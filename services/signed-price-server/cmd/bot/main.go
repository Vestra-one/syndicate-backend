package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/syndicate/backend/services/signed-price-server/api"
	"github.com/syndicate/backend/services/signed-price-server/bbo"
	"github.com/syndicate/backend/services/signed-price-server/config"
	"github.com/syndicate/backend/services/signed-price-server/failover"
	"github.com/syndicate/backend/services/signed-price-server/pricebuild"
	"github.com/syndicate/backend/services/signed-price-server/provider"
	"github.com/syndicate/backend/services/signed-price-server/signing"
	"github.com/syndicate/backend/services/signed-price-server/store"
	"github.com/syndicate/backend/services/signed-price-server/stream"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

func main() {
	// Bootstrap logger for any errors emitted before the config (and its logging
	// settings) is loaded. Replaced by the config-driven logger after load.
	logger := log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	logger.Info().Msg("Starting price-bot server")

	// Accept the key either inline (ECDSA_PRIVATE_KEY) or via a mounted secret file
	// (ECDSA_PRIVATE_KEY_FILE), matching the *_FILE secrets convention the rest of the
	// stack uses (postgres-password, session-signing-key, …).
	privateKeyHex := os.Getenv("ECDSA_PRIVATE_KEY")
	if privateKeyHex == "" {
		if keyFile := os.Getenv("ECDSA_PRIVATE_KEY_FILE"); keyFile != "" {
			b, err := os.ReadFile(keyFile)
			if err != nil {
				logger.Fatal().Err(err).Str("file", keyFile).Msg("failed to read ECDSA_PRIVATE_KEY_FILE")
				return
			}
			privateKeyHex = strings.TrimSpace(string(b))
		}
	}
	if privateKeyHex == "" {
		logger.Fatal().Msg("neither ECDSA_PRIVATE_KEY nor ECDSA_PRIVATE_KEY_FILE is set")
		return
	}

	configPath := os.Getenv("CONFIG_PATH")
	if configPath == "" {
		configPath = "config/config.toml"
	}

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		logger.Fatal().Err(err).Msg("failed to load configuration")
		return
	}
	// Rebuild the root logger from config so level/format apply to every
	// component that derives its child logger from this one.
	logger = cfg.Logging.BuildLogger()
	logger.Info().
		Str("config", configPath).
		Str("log_level", cfg.Logging.Level).
		Str("log_format", cfg.Logging.Format).
		Msg("configuration loaded")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logger.Info().Msg("initializing components")

	priceStore, err := store.NewSignedPriceStoreWithArchive(cfg.Store.HistoryCapacity, cfg.Store.SQLitePath)
	if err != nil {
		logger.Fatal().Err(err).Str("sqlite_path", cfg.Store.SQLitePath).Msg("failed to create price store")
		return
	}
	defer priceStore.Close()
	logger.Info().
		Int("capacity", cfg.Store.HistoryCapacity).
		Str("sqlite_path", cfg.Store.SQLitePath).
		Msg("price store created")

	numWorkers := cfg.Signing.NumWorkers
	if numWorkers == 0 {
		numWorkers = runtime.NumCPU() * 2
	}
	logger.Info().Int("workers", numWorkers).Msg("creating signing worker pool")

	workerPool, err := signing.NewWorkerPool(
		ctx,
		privateKeyHex,
		numWorkers,
		cfg.Signing.TradeQueueSize,
		cfg.Signing.SignedQueueSize,
		logger,
	)
	if err != nil {
		logger.Fatal().Err(err).Msg("failed to create worker pool")
		return
	}
	workerPool.Start()
	logger.Info().Msg("signing worker pool started")

	hub := stream.NewHub(
		ctx,
		cfg.Hub.ClientQueueSize,
		cfg.Server.MaxConnections,
		cfg.Hub.ClientSendBufferSize,
		logger,
	)
	hub.Start()
	logger.Info().
		Int("max_connections", cfg.Server.MaxConnections).
		Int("client_send_buffer", cfg.Hub.ClientSendBufferSize).
		Msg("WebSocket hub started")

	bboStore := bbo.NewSnapshotStore()
	priceModesByProvider := cfg.ProviderPriceModesMap()
	providerPairs := cfg.ProviderPairs()
	endpoints := cfg.ProviderEndpointsMap()

	providers, err := provider.CreateProvidersForPairs(ctx, logger, providerPairs, priceModesByProvider, endpoints, bboStore)
	if err != nil {
		logger.Fatal().Err(err).Msg("failed to create providers")
		return
	}

	tokenAddresses := cfg.TokenMappingsMap()
	logger.Info().Int("tokens", len(tokenAddresses)).Msg("token mappings loaded")

	bookMidCfgEntries := cfg.BookMidEntries(priceModesByProvider)
	bookMidEntries := bookMidEntriesFromConfig(bookMidCfgEntries)
	bookMidKeys := bboKeysFromConfig(bookMidCfgEntries)

	// Refuse to start with unauthenticated failover endpoints: the promote/demote
	// routes can force a node to start/stop signing, so an empty shared secret
	// (which makes authorizeFailover allow everyone) is a fail-open hazard.
	if cfg.Failover.Enabled && cfg.Failover.SharedSecret() == "" {
		logger.Fatal().Msg("failover.enabled but failover shared secret is empty; set FAILOVER_SHARED_SECRET (or shared_secret_env) to authenticate /internal/failover endpoints")
		return
	}

	failoverCtrl := failover.NewController(cfg.Failover.ToFailoverSettings(), bboStore, cfg.MaxBookAge(), bookMidKeys, logger)
	go failoverCtrl.Run(ctx)
	if cfg.Failover.Enabled {
		logger.Info().
			Str("node_id", cfg.Failover.NodeID).
			Str("peer_url", cfg.Failover.PeerURL).
			Int("symbols", len(cfg.Failover.Symbols)).
			Msg("failover controller started")
	}

	go consumeSignedPrices(ctx, workerPool, hub, priceStore, failoverCtrl, logger)
	logger.Info().Msg("price consumer started")

	binanceConverters := make(map[types.ProviderName]provider.UsdtToUsdConverter)
	for providerName, prov := range providers {
		if binanceProv, ok := prov.(*provider.BinanceProvider); ok {
			binanceConverters[providerName] = binanceProv
		}
	}

	if len(bookMidEntries) > 0 {
		emitter := provider.NewBookMidEmitter(
			ctx,
			logger,
			bboStore,
			bookMidEntries,
			workerPool,
			binanceConverters,
			cfg.EmitInterval(),
			cfg.MaxBookAge(),
			failoverCtrl,
			failoverCtrl,
		)
		go emitter.Start()
		logger.Info().
			Int("book_mid_pairs", len(bookMidEntries)).
			Dur("emit_interval", cfg.EmitInterval()).
			Dur("max_book_age", cfg.MaxBookAge()).
			Msg("book_mid emitter started")
	}

	for providerName, prov := range providers {
		if binanceProv, ok := prov.(*provider.BinanceProvider); ok {
			logger.Info().Str("provider", string(providerName)).Msg("setting up trade callback")

			binanceProv.SetTradeCallback(func(trade provider.BinanceTrade) {
				tokenAddr, ok := tokenAddresses[trade.Symbol]
				if !ok {
					usdSym := pricebuild.SymbolUSDTToUSD(trade.Symbol)
					tokenAddr, ok = tokenAddresses[usdSym]
				}
				if !ok {
					logger.Warn().Str("symbol", trade.Symbol).Msg("no token address configured")
					return
				}

				usdPrice, conversionRate, err := binanceProv.ConvertUsdtToUsd(trade.Price)
				if err != nil {
					logger.Error().Err(err).Str("symbol", trade.Symbol).Str("usdt_price", trade.Price).Msg("failed to convert USDT to USD")
					return
				}

				priceInWad, err := pricebuild.PriceToWad(usdPrice)
				if err != nil {
					logger.Error().Err(err).Str("symbol", trade.Symbol).Str("usd_price", usdPrice).Msg("failed to convert price to WAD")
					return
				}

				usdSymbol := pricebuild.SymbolUSDTToUSD(trade.Symbol)

				tradeUpdate := signing.TradeUpdate{
					Token:      tokenAddr,
					Symbol:     usdSymbol,
					Price:      usdPrice,
					PriceInWad: priceInWad,
					Quantity:   trade.Quantity,
					Timestamp:  trade.TradeTime,
					TradeID:    trade.TradeID,
					Exchange:   string(providerName),
				}
				workerPool.SubmitTrade(tradeUpdate)

				logger.Debug().
					Str("symbol", trade.Symbol).
					Str("usdt_price", trade.Price).
					Str("usd_price", usdPrice).
					Float64("conversion_rate", conversionRate).
					Str("final_symbol", usdSymbol).
					Msg("price converted from USDT to USD")
			})
		}

		if coinbaseProv, ok := prov.(*provider.CoinbaseProvider); ok {
			logger.Info().Str("provider", string(providerName)).Msg("setting up trade callback")

			coinbaseProv.SetStaleWatchdog(
				cfg.StaleWatchdogInterval(),
				cfg.StaleThreshold(),
				cfg.StaleReconnectCooldown(),
			)

			coinbaseProv.SetTradeCallback(func(ticker provider.CoinbaseTicker) {
				symbol := provider.CoinbaseProductIDToSymbol(ticker.ProductID)
				tokenAddr, ok := tokenAddresses[symbol]
				if !ok {
					logger.Warn().Str("symbol", symbol).Str("product_id", ticker.ProductID).Msg("no token address configured")
					return
				}

				usdPrice := ticker.Price

				priceInWad, err := pricebuild.PriceToWad(usdPrice)
				if err != nil {
					logger.Error().Err(err).Str("symbol", symbol).Str("usd_price", usdPrice).Msg("failed to convert price to WAD")
					return
				}

				timestampMs, err := provider.ParseCoinbaseTime(ticker.Time)
				if err != nil {
					logger.Error().Err(err).Str("time", ticker.Time).Msg("failed to parse Coinbase timestamp")
					return
				}

				quantity := ticker.Size
				if quantity == "" {
					quantity = ticker.LastSize
				}

				tradeUpdate := signing.TradeUpdate{
					Token:      tokenAddr,
					Symbol:     symbol,
					Price:      usdPrice,
					PriceInWad: priceInWad,
					Quantity:   quantity,
					Timestamp:  timestampMs,
					TradeID:    ticker.TradeID,
					Exchange:   string(providerName),
				}
				workerPool.SubmitTrade(tradeUpdate)

				logger.Debug().
					Str("product_id", ticker.ProductID).
					Str("symbol", symbol).
					Str("price", usdPrice).
					Msg("Coinbase price received")
			})
		}
	}

	for providerName, prov := range providers {
		prov.StartConnections()
		logger.Info().Str("provider", string(providerName)).Msg("provider connected")
	}

	startedAt := time.Now()
	apiServer := api.NewServer(
		cfg.Server.ListenAddr,
		hub,
		priceStore,
		bboStore,
		bookMidKeys,
		cfg.MaxBookAge(),
		startedAt,
		failoverCtrl,
		cfg.Metrics.Path,
		logger,
	)
	go func() {
		if err := apiServer.Start(); err != nil {
			logger.Error().Err(err).Msg("HTTP server error")
			return
		}
	}()
	logger.Info().Str("listen_addr", cfg.Server.ListenAddr).Msg("HTTP server started")

	logger.Info().Msg("price-bot server running successfully!")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	logger.Info().Msg("shutdown signal received, stopping gracefully")

	shutdownTimeout, err := time.ParseDuration(cfg.Server.ShutdownTimeout)
	if err != nil {
		logger.Warn().Err(err).Str("shutdown_timeout", cfg.Server.ShutdownTimeout).Msg("invalid shutdown_timeout, using 30s")
		shutdownTimeout = 30 * time.Second
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer shutdownCancel()

	apiServer.Stop(shutdownCtx)
	hub.Stop()
	workerPool.Stop()

	logger.Info().Msg("price-bot server stopped successfully")
}

// consumeSignedPrices consumes and distributes signed prices with timestamp ordering
func consumeSignedPrices(
	ctx context.Context,
	workerPool *signing.WorkerPool,
	hub *stream.Hub,
	priceStore *store.SignedPriceStore,
	failoverCtrl *failover.Controller,
	logger zerolog.Logger,
) {
	for {
		select {
		case <-ctx.Done():
			return
		case price, ok := <-workerPool.SignedPrices():
			if !ok {
				return
			}
			if failoverCtrl != nil && !failoverCtrl.CanSign(price.Symbol) {
				failover.BlockedSign(price.Symbol)
				continue
			}
			if !priceStore.Store(price) {
				continue
			}
			if failoverCtrl != nil {
				failoverCtrl.OnBroadcast(price.Symbol, price.SignedAt)
			}
			// Pre-serialize once off the hub hot path; the resulting bytes are
			// shared read-only by every subscribed client.
			data, err := marshalSignedPrice(price)
			if err != nil {
				logger.Error().Err(err).Str("symbol", price.Symbol).Msg("failed to marshal signed price")
				continue
			}
			hub.Broadcast(price.Symbol, data)
			logger.Debug().
				Str("symbol", price.Symbol).
				Int64("timestamp", price.Timestamp).
				Msg("signed price broadcast")
		}
	}
}

// encodeBufPool reuses encode buffers across broadcasts to keep marshal
// allocations off the hub hot path.
var encodeBufPool = sync.Pool{New: func() interface{} { return new(bytes.Buffer) }}

// marshalSignedPrice serializes a signed price to an owned []byte using a pooled
// buffer. The returned slice is independent of the pool (safe to share and
// retain after the buffer is recycled).
func marshalSignedPrice(price signing.SignedPrice) ([]byte, error) {
	buf := encodeBufPool.Get().(*bytes.Buffer)
	buf.Reset()
	defer encodeBufPool.Put(buf)

	enc := json.NewEncoder(buf)
	if err := enc.Encode(price); err != nil {
		return nil, err
	}
	// json.Encoder appends a trailing newline; trim it for parity with json.Marshal.
	b := bytes.TrimRight(buf.Bytes(), "\n")
	out := make([]byte, len(b))
	copy(out, b)
	return out, nil
}
