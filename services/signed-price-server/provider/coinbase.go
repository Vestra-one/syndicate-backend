package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

const (
	coinbaseWSHost         = "ws-feed.exchange.coinbase.com"
	coinbaseAdvancedWSHost = "advanced-trade-ws.coinbase.com"
	coinbaseRestHost       = "https://api.exchange.coinbase.com"
	coinbaseRestPath       = "/products"
)

var _ Provider = (*CoinbaseProvider)(nil)

type (
	// CoinbaseProvider defines an Oracle provider implemented by the Coinbase Exchange
	// public API. Coinbase uses USD-denominated pairs directly (e.g. BTC-USD), so no
	// USDT-to-USD conversion is needed.
	//
	// REF (Exchange feed, `ticker` channel used for last_trade mode):
	//   https://docs.cdp.coinbase.com/exchange/websocket-feed/overview
	//   https://docs.cdp.coinbase.com/exchange/websocket-feed/channels
	// REF (Advanced Trade feed, `level2` channel used for book_mid mode):
	//   https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels
	CoinbaseProvider struct {
		wsc         *WebsocketController // Exchange ticker feed for last_trade pairs
		wscAdvanced *WebsocketController // Advanced Trade level2 feed for book_mid pairs

		ctx       context.Context
		logger    zerolog.Logger
		mtx       sync.RWMutex
		endpoints Endpoint

		priceStore

		// Trade callback for real-time ticker events (last_trade mode only)
		tradeCallback func(CoinbaseTicker)

		priceModes map[string]types.PriceFeedMode // key Base+Quote e.g. BTCUSD

		bboStore  *bbo.SnapshotStore
		bookStore *CoinbaseBookStore

		// bookMidKeys are the BBO keys the staleness watchdog monitors (book_mid pairs).
		bookMidKeys []bbo.Key
		// Stale-book watchdog parameters (configured via SetStaleWatchdog). A zero
		// staleWatchdogInterval disables the watchdog.
		staleWatchdogInterval  time.Duration
		staleThreshold         time.Duration
		staleReconnectCooldown time.Duration
		// lastForceReconnect gates watchdog reconnects to staleReconnectCooldown.
		lastForceReconnect time.Time
	}

	// CoinbaseTicker represents a ticker message from Coinbase ticker channel.
	// Prices are already in USD.
	CoinbaseTicker struct {
		Type      string `json:"type"`       // "ticker"
		ProductID string `json:"product_id"` // e.g. "BTC-USD"
		Price     string `json:"price"`      // Last trade price
		BestBid   string `json:"best_bid"`
		BestAsk   string `json:"best_ask"`
		Size      string `json:"size"`      // Last trade size (alias: last_size)
		LastSize  string `json:"last_size"` // Alternative field name
		TradeID   int64  `json:"trade_id"`  // Last trade ID
		Time      string `json:"time"`      // ISO 8601 timestamp
	}

	// CoinbaseProduct defines a product from the REST API /products response.
	CoinbaseProduct struct {
		ID string `json:"id"` // e.g. "BTC-USD"
	}

	// CoinbaseSubscribeMsg is the subscription message for the Coinbase Exchange
	// WebSocket (ticker channel etc).
	CoinbaseSubscribeMsg struct {
		Type     string `json:"type"`     // "subscribe"
		Channels []any  `json:"channels"` // Channel configs
	}
)

// NewCoinbaseProvider creates a new Coinbase provider for the given currency pairs.
// Coinbase uses product IDs like "BTC-USD" (base-quote with hyphen).
//
// Pairs whose feed mode is "last_trade" are routed to the Exchange `ticker`
// channel (`ws-feed.exchange.coinbase.com`). Pairs whose mode is "book_mid"
// are routed to the Advanced Trade `level2` + `heartbeats` channels
// (`advanced-trade-ws.coinbase.com`) and feed a local order book.
func NewCoinbaseProvider(
	ctx context.Context,
	logger zerolog.Logger,
	endpoints Endpoint,
	priceModes map[string]types.PriceFeedMode,
	bboStore *bbo.SnapshotStore,
	pairs ...types.CurrencyPair,
) (*CoinbaseProvider, error) {
	if endpoints.Name != ProviderCoinbase {
		endpoints = Endpoint{
			Name:      ProviderCoinbase,
			Rest:      coinbaseRestHost,
			Websocket: coinbaseWSHost,
		}
	}

	coinbaseLogger := logger.With().Str("provider", string(endpoints.Name)).Logger()

	provider := &CoinbaseProvider{
		ctx:        ctx,
		logger:     coinbaseLogger,
		endpoints:  endpoints,
		priceStore: newPriceStore(),
		priceModes: priceModes,
		bboStore:   bboStore,
		bookStore:  NewCoinbaseBookStore(),
	}

	confirmedPairs, err := ConfirmPairAvailability(
		provider,
		provider.endpoints.Name,
		provider.logger,
		pairs...,
	)
	if err != nil {
		return nil, err
	}

	provider.setSubscribedPairs(confirmedPairs...)

	lastTradePairs, bookMidPairs := provider.partitionByMode(confirmedPairs)

	if len(lastTradePairs) > 0 {
		exchangeURL := url.URL{
			Scheme: "wss",
			Host:   endpoints.Websocket,
			Path:   "/",
		}
		provider.wsc = NewWebsocketController(
			ctx,
			endpoints.Name,
			exchangeURL,
			provider.getSubscriptionMsgs(lastTradePairs...),
			provider.messageReceived,
			disabledPingDuration,
			websocket.PingMessage,
			coinbaseLogger,
		)
	}

	if len(bookMidPairs) > 0 {
		for _, cp := range bookMidPairs {
			provider.bookMidKeys = append(provider.bookMidKeys, bbo.Key{
				Provider: string(provider.endpoints.Name),
				Symbol:   CoinbaseProductIDToSymbol(currencyPairToCoinbaseProductID(cp)),
			})
		}
		advancedURL := url.URL{
			Scheme: "wss",
			Host:   coinbaseAdvancedWSHost,
			Path:   "/",
		}
		provider.wscAdvanced = NewWebsocketController(
			ctx,
			endpoints.Name,
			advancedURL,
			provider.getAdvancedSubscriptionMsgs(bookMidPairs...),
			provider.advancedMessageReceived,
			disabledPingDuration,
			websocket.PingMessage,
			coinbaseLogger,
		)
	}

	return provider, nil
}

func (p *CoinbaseProvider) StartConnections() {
	if p.wsc != nil {
		p.wsc.StartConnections()
	}
	if p.wscAdvanced != nil {
		p.wscAdvanced.StartConnections()
		if p.staleWatchdogInterval > 0 {
			go p.runStaleBookWatchdog()
		}
	}
}

// runStaleBookWatchdog periodically checks each book_mid symbol's BBO freshness
// and forces an Advanced Trade reconnect when one has gone stale beyond
// staleThreshold. Coinbase can silently stop streaming l2_data for a single
// product while heartbeats and other products keep the socket alive; that never
// trips the read-error or sequence-gap reconnect paths, so the book ages forever
// and book_mid signing stays paused. A reconnect re-snapshots every subscribed
// product, rebuilding the stalled book so signing resumes.
func (p *CoinbaseProvider) runStaleBookWatchdog() {
	if len(p.bookMidKeys) == 0 || p.staleWatchdogInterval <= 0 {
		return
	}
	// Seed the cooldown from startup so the first snapshot has time to arrive
	// before a not-yet-ready book could trigger a (counterproductive) reconnect.
	p.lastForceReconnect = time.Now()
	ticker := time.NewTicker(p.staleWatchdogInterval)
	defer ticker.Stop()

	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.checkStaleBooks()
		}
	}
}

// checkStaleBooks forces one reconnect (subject to cooldown) if any monitored
// book_mid symbol is stale. The cooldown also gives a fresh connection time to
// receive its snapshot before the watchdog could trigger again.
func (p *CoinbaseProvider) checkStaleBooks() {
	if time.Since(p.lastForceReconnect) < p.staleReconnectCooldown {
		return
	}
	for _, k := range p.bookMidKeys {
		if p.bboStore.IsFresh(k, p.staleThreshold) {
			continue
		}
		p.logger.Warn().
			Str("symbol", k.Symbol).
			Dur("stale_threshold", p.staleThreshold).
			Msg("book_mid feed stale; forcing coinbase advanced reconnect")
		recordCoinbaseL2StaleReconnect(k.Symbol)
		p.lastForceReconnect = time.Now()
		p.wscAdvanced.ForceReconnectAll()
		return
	}
}

// SetStaleWatchdog configures the per-symbol stale-book reconnect watchdog. A
// zero interval disables it. Must be called before StartConnections.
func (p *CoinbaseProvider) SetStaleWatchdog(interval, threshold, cooldown time.Duration) {
	p.staleWatchdogInterval = interval
	p.staleThreshold = threshold
	p.staleReconnectCooldown = cooldown
}

// SetTradeCallback sets the callback function for ticker events.
func (p *CoinbaseProvider) SetTradeCallback(callback func(CoinbaseTicker)) {
	p.mtx.Lock()
	defer p.mtx.Unlock()
	p.tradeCallback = callback
}

func (p *CoinbaseProvider) feedModeForSymbol(sym string) types.PriceFeedMode {
	if p.priceModes == nil {
		return types.PriceFeedLastTrade
	}
	mode, ok := p.priceModes[sym]
	if !ok {
		return types.PriceFeedLastTrade
	}
	return mode
}

func (p *CoinbaseProvider) partitionByMode(cps []types.CurrencyPair) (lastTrade, bookMid []types.CurrencyPair) {
	for _, cp := range cps {
		switch p.feedModeForSymbol(cp.String()) {
		case types.PriceFeedBookMid:
			bookMid = append(bookMid, cp)
		default:
			lastTrade = append(lastTrade, cp)
		}
	}
	return
}

func (p *CoinbaseProvider) getSubscriptionMsgs(cps ...types.CurrencyPair) []interface{} {
	productIDs := make([]string, 0, len(cps))
	for _, cp := range cps {
		productIDs = append(productIDs, currencyPairToCoinbaseProductID(cp))
	}

	return []interface{}{
		CoinbaseSubscribeMsg{
			Type: "subscribe",
			Channels: []any{
				map[string]any{
					"name":        "ticker",
					"product_ids": productIDs,
				},
			},
		},
	}
}

// getAdvancedSubscriptionMsgs builds the per-channel subscribe messages for the
// Advanced Trade WebSocket. Each channel needs its own message.
func (p *CoinbaseProvider) getAdvancedSubscriptionMsgs(cps ...types.CurrencyPair) []interface{} {
	productIDs := make([]string, 0, len(cps))
	for _, cp := range cps {
		productIDs = append(productIDs, currencyPairToCoinbaseProductID(cp))
	}
	return []interface{}{
		CoinbaseAdvancedSubscribe{
			Type:       "subscribe",
			Channel:    "level2",
			ProductIDs: productIDs,
		},
		CoinbaseAdvancedSubscribe{
			Type:       "subscribe",
			Channel:    "heartbeats",
			ProductIDs: productIDs,
		},
	}
}

// SubscribeCurrencyPairs sends new subscription messages for last_trade pairs.
// book_mid mode is not supported via this dynamic-add path; configure new
// book_mid pairs at startup instead.
func (p *CoinbaseProvider) SubscribeCurrencyPairs(cps ...types.CurrencyPair) {
	p.mtx.Lock()
	defer p.mtx.Unlock()

	newPairs := []types.CurrencyPair{}
	for _, cp := range cps {
		if !p.isSubscribed(cp.String()) {
			newPairs = append(newPairs, cp)
		}
	}

	confirmedPairs, err := ConfirmPairAvailability(
		p,
		p.endpoints.Name,
		p.logger,
		newPairs...,
	)
	if err != nil {
		return
	}

	lastTradePairs, bookMidPairs := p.partitionByMode(confirmedPairs)
	if len(bookMidPairs) > 0 {
		p.logger.Warn().
			Int("book_mid_pairs", len(bookMidPairs)).
			Msg("dynamic SubscribeCurrencyPairs for book_mid mode not supported; configure at startup")
	}
	if len(lastTradePairs) == 0 || p.wsc == nil {
		return
	}

	newSubscriptionMsgs := p.getSubscriptionMsgs(lastTradePairs...)
	p.wsc.AddWebsocketConnection(
		newSubscriptionMsgs,
		p.messageReceived,
		disabledPingDuration,
		websocket.PingMessage,
	)
	p.setSubscribedPairs(lastTradePairs...)
}

// messageReceived handles Exchange-feed `ticker` frames for last_trade pairs.
func (p *CoinbaseProvider) messageReceived(_ int, _ *WebsocketConnection, bz []byte) {
	var ticker CoinbaseTicker
	if err := json.Unmarshal(bz, &ticker); err != nil {
		return
	}

	if ticker.Type != "ticker" || ticker.ProductID == "" {
		return
	}

	if ticker.Price == "" {
		return
	}
	if ticker.Size == "" && ticker.LastSize != "" {
		ticker.Size = ticker.LastSize
	}

	if p.tradeCallback != nil {
		p.tradeCallback(ticker)
	}
	telemetryWebsocketMessage(p.endpoints.Name, MessageTypeTickerTrade)
}

// advancedMessageReceived handles Advanced Trade frames: l2_data (snapshot /
// update), heartbeats, and subscriptions ack.
//
// sequence_num is a per-connection envelope counter shared across all
// subscribed channels (level2, heartbeats, subscriptions, ...). A gap is any
// frame whose sequence is not exactly previous+1, regardless of channel; that
// indicates dropped frames and forces a reconnect so the next snapshot rebuilds
// the book.
func (p *CoinbaseProvider) advancedMessageReceived(_ int, conn *WebsocketConnection, bz []byte) {
	var frame CoinbaseAdvancedFrame
	if err := json.Unmarshal(bz, &frame); err != nil {
		return
	}

	if !p.checkAdvancedSequence(frame, conn) {
		return
	}

	switch frame.Channel {
	case "l2_data":
		for _, ev := range frame.Events {
			p.applyAdvancedEvent(ev)
		}

	case "heartbeats":
		telemetryWebsocketMessage(p.endpoints.Name, MessageTypeHeartbeat)

	case "subscriptions":
		p.logger.Debug().RawJSON("frame", bz).Msg("coinbase advanced subscriptions ack")

	default:
		p.logger.Debug().Str("channel", frame.Channel).Msg("coinbase advanced frame ignored")
	}
}

// checkAdvancedSequence enforces strict +1 monotonicity on the per-connection
// sequence_num across all frames on this WebSocket. Returns false if a gap was
// detected and the connection was force-reconnected; callers should drop the
// current frame in that case.
func (p *CoinbaseProvider) checkAdvancedSequence(frame CoinbaseAdvancedFrame, conn *WebsocketConnection) bool {
	if conn == nil {
		return true
	}
	if !conn.seqInitialized.Load() {
		conn.lastSequence.Store(frame.SequenceNum)
		conn.seqInitialized.Store(true)
		return true
	}
	last := conn.lastSequence.Load()
	if frame.SequenceNum <= last {
		// Duplicate or out-of-order frame; ignore without reconnecting.
		p.logger.Debug().
			Int64("last_seq", last).
			Int64("got_seq", frame.SequenceNum).
			Str("channel", frame.Channel).
			Msg("coinbase advanced duplicate sequence; ignoring frame")
		return false
	}
	if frame.SequenceNum == last+1 {
		conn.lastSequence.Store(frame.SequenceNum)
		return true
	}
	p.logger.Warn().
		Int64("last_seq", last).
		Int64("got_seq", frame.SequenceNum).
		Str("channel", frame.Channel).
		Msg("coinbase advanced sequence gap; forcing reconnect")
	for _, ev := range frame.Events {
		if sym := CoinbaseProductIDToSymbol(ev.ProductID); sym != "" {
			recordCoinbaseL2SequenceGap(sym)
		}
	}
	conn.ForceReconnect()
	return false
}

func (p *CoinbaseProvider) applyAdvancedEvent(ev CoinbaseAdvancedEvent) {
	if ev.ProductID == "" || len(ev.Updates) == 0 {
		return
	}
	updates := make([]L2Update, len(ev.Updates))
	for i, u := range ev.Updates {
		updates[i] = L2Update{Side: u.Side, PriceLevel: u.PriceLevel, NewQuantity: u.NewQuantity}
	}

	sym := CoinbaseProductIDToSymbol(ev.ProductID)
	var bid, ask string
	var ok bool
	switch ev.Type {
	case "snapshot":
		bid, ask, ok = p.bookStore.Reset(ev.ProductID, updates)
		telemetryWebsocketMessage(p.endpoints.Name, MessageTypeL2Snapshot)
	case "update":
		bid, ask, ok = p.bookStore.Apply(ev.ProductID, updates)
		telemetryWebsocketMessage(p.endpoints.Name, MessageTypeL2Update)
	default:
		return
	}

	recordCoinbaseL2UpdatesApplied(sym, len(updates))
	if bids, asks, sized := p.bookStore.LevelCounts(ev.ProductID); sized {
		setCoinbaseL2BookLevels(sym, bids, asks)
	}

	if !ok || p.bboStore == nil {
		return
	}
	p.bboStore.Update(bbo.Key{Provider: string(p.endpoints.Name), Symbol: sym}, bid, ask)
	recordBookMidWSUpdate(string(p.endpoints.Name), sym)
}

// GetAvailablePairs returns all USD-denominated product IDs from Coinbase.
// Coinbase uses format "BTC-USD", "ETH-USD", etc.
func (p *CoinbaseProvider) GetAvailablePairs() (map[string]struct{}, error) {
	resp, err := http.Get(p.endpoints.Rest + coinbaseRestPath)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var products []CoinbaseProduct
	if err := json.Unmarshal(b, &products); err != nil {
		return nil, fmt.Errorf("failed to parse products: %w", err)
	}

	availablePairs := make(map[string]struct{}, len(products))
	for _, prod := range products {
		// Only include USD pairs for oracle use
		if strings.HasSuffix(prod.ID, "-USD") {
			availablePairs[prod.ID] = struct{}{}
			// Also add Base+Quote format (e.g. BTCUSD) for ConfirmPairAvailability
			availablePairs[CoinbaseProductIDToSymbol(prod.ID)] = struct{}{}
		}
	}

	return availablePairs, nil
}

// currencyPairToCoinbaseProductID converts a CurrencyPair to Coinbase product ID.
// e.g. CurrencyPair{Base: "BTC", Quote: "USD"} -> "BTC-USD"
func currencyPairToCoinbaseProductID(cp types.CurrencyPair) string {
	return cp.Base + "-" + cp.Quote
}

// CoinbaseProductIDToSymbol converts a Coinbase product ID to internal symbol format.
// e.g. "BTC-USD" -> "BTCUSD" (for token mapping lookup)
func CoinbaseProductIDToSymbol(productID string) string {
	return strings.ReplaceAll(productID, "-", "")
}

// ParseCoinbaseTime parses Coinbase's ISO 8601 time string to Unix milliseconds.
func ParseCoinbaseTime(timeStr string) (int64, error) {
	if timeStr == "" {
		return 0, fmt.Errorf("empty time string")
	}
	t, err := time.Parse(time.RFC3339Nano, timeStr)
	if err != nil {
		t, err = time.Parse(time.RFC3339, timeStr)
		if err != nil {
			return 0, fmt.Errorf("failed to parse time %q: %w", timeStr, err)
		}
	}
	return t.UnixMilli(), nil
}
