package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

const (
	binanceWSHost        = "stream.binance.com:9443"
	binanceUSWSHost      = "stream.binance.us:9443"
	binanceWSPath        = "/ws/ojostream"
	binanceRestHost      = "https://api1.binance.com"
	binanceRestUSHost    = "https://api.binance.us"
	binanceRestPath      = "/api/v3/ticker/price"
	binanceRestDepthPath = "/api/v3/depth"

	// USDTUSD pair is always subscribed for currency conversion
	usdtUsdPair = "USDTUSD"

	// Maximum age for USDT/USD rate before considered stale (30 seconds)
	usdtRateMaxAge = 30 * time.Second
)

// binanceNormalizeMessage returns the nested `data` payload for combined multiplex
// frames ({"stream":"...","data":{...}}). Some endpoints send data as a JSON string
// containing the nested object literal. Handles application {"ping":n} with {"pong":n}.
func binanceNormalizeMessage(conn *WebsocketConnection, bz []byte) []byte {
	var pingMsg struct {
		Ping int64 `json:"ping"`
	}
	if err := json.Unmarshal(bz, &pingMsg); err == nil && pingMsg.Ping > 0 {
		if conn != nil {
			conn.mtx.Lock()
			cl := conn.client
			conn.mtx.Unlock()
			if cl != nil {
				pong := fmt.Sprintf(`{"pong":%d}`, pingMsg.Ping)
				_ = cl.WriteMessage(websocket.TextMessage, []byte(pong))
			}
		}
		return nil
	}
	var wrap struct {
		Stream string          `json:"stream"`
		Data   json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(bz, &wrap); err != nil || wrap.Stream == "" || len(wrap.Data) == 0 || bytes.Equal(wrap.Data, []byte("null")) {
		return bz
	}
	raw := wrap.Data
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil && strings.HasPrefix(strings.TrimSpace(asString), "{") {
		raw = []byte(asString)
	}
	return raw
}

var _ Provider = (*BinanceProvider)(nil)

type (
	// UsdtUsdRate holds USDT/USD conversion rate with timestamp for staleness checking
	UsdtUsdRate struct {
		Rate      float64   // USDT to USD conversion rate
		Timestamp time.Time // When this rate was last updated
	}

	// BinanceProvider defines an Oracle provider implemented by the Binance public
	// API.
	//
	// REF: https://binance-docs.github.io/apidocs/spot/en/#individual-symbol-mini-ticker-stream
	// REF: https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-streams
	BinanceProvider struct {
		wsc       *WebsocketController
		logger    zerolog.Logger
		mtx       sync.RWMutex
		endpoints Endpoint

		priceStore

		// Trade callback for real-time trade events
		tradeCallback func(BinanceTrade)

		// USDT/USD conversion rate (atomic for lock-free reads)
		usdtUsdRate atomic.Value // stores *UsdtUsdRate

		// pair key Base+Quote (e.g. BTCUSDT) -> feed mode; nil defaults to last_trade
		priceModes map[string]types.PriceFeedMode

		bboStore *bbo.SnapshotStore
	}

	// BinanceTicker ticker price response. https://pkg.go.dev/encoding/json#Unmarshal
	// Unmarshal matches incoming object keys to the keys used by Marshal (either the
	// struct field name or its tag), preferring an exact match but also accepting a
	// case-insensitive match. C field which is Statistics close time is not used, but
	// it avoids to implement specific UnmarshalJSON.
	BinanceTicker struct {
		Symbol    string `json:"s"` // Symbol ex.: BTCUSDT
		LastPrice string `json:"c"` // Last price ex.: 0.0025
		Volume    string `json:"v"` // Total traded base asset volume ex.: 1000
		C         uint64 `json:"C"` // Statistics close time
	}

	// BinanceTrade represents a trade event from Binance @trade stream
	BinanceTrade struct {
		EventType string `json:"e"` // "trade"
		EventTime int64  `json:"E"` // Event time
		Symbol    string `json:"s"` // Symbol
		TradeID   int64  `json:"t"` // Trade ID
		Price     string `json:"p"` // Price
		Quantity  string `json:"q"` // Quantity
		BuyerMM   bool   `json:"m"` // Buyer is market maker
		TradeTime int64  `json:"T"` // Trade time
	}

	// BinanceBookTicker is the @bookTicker stream payload (Spot).
	BinanceBookTicker struct {
		EventType string `json:"e"` // "bookTicker"
		EventTime int64  `json:"E"` // Event time
		Symbol    string `json:"s"`
		BestBid   string `json:"b"`
		BestBidSz string `json:"B"`
		BestAsk   string `json:"a"`
		BestAskSz string `json:"A"`
		TradeTime int64  `json:"T"` // Transaction time
	}

	BinanceDepth struct {
		E  string     `json:"e"` //depthUpdate // Event type
		E0 int64      `json:"E"` // Event time
		S  string     `json:"s"` // Symbol ex.: BTCUSDT
		U  int64      `json:"U"` // First update ID in event
		U0 int64      `json:"u"` // Final update ID in event
		B  [][]string `json:"b"` // Bids to be updated
		A  [][]string `json:"a"` // Asks to be updated
	}

	// BinanceCandleMetadata candle metadata used to compute tvwap price.
	BinanceCandleMetadata struct {
		Close     string `json:"c"` // Price at close
		TimeStamp int64  `json:"T"` // Close time in unix epoch ex.: 1645756200000
		Volume    string `json:"v"` // Volume during period
	}

	// BinanceCandle candle binance websocket channel "kline_1m" response.
	BinanceCandle struct {
		Symbol   string                `json:"s"` // Symbol ex.: BTCUSDT
		Metadata BinanceCandleMetadata `json:"k"` // Metadata for candle
	}

	// BinanceSubscribeMsg Msg to subscribe all the tickers channels.
	BinanceSubscriptionMsg struct {
		Method string   `json:"method"` // SUBSCRIBE/UNSUBSCRIBE
		Params []string `json:"params"` // streams to subscribe ex.: usdtatom@ticker
		ID     uint16   `json:"id"`     // identify messages going back and forth
	}

	// BinanceSubscriptionResp the response structure for a binance subscription response
	BinanceSubscriptionResp struct {
		Result string `json:"result"`
		ID     uint16 `json:"id"`
	}

	// BinancePairSummary defines the response structure for a Binance pair
	// summary.
	BinancePairSummary struct {
		Symbol string `json:"symbol"`
	}

	BinanceDepthDataResponse struct {
		LastUpdateId int64       `json:"lastUpdateId"`
		Asks         [][2]string `json:"asks"`
		Bids         [][2]string `json:"bids"`
	}
)

func NewBinanceProvider(
	ctx context.Context,
	logger zerolog.Logger,
	endpoints Endpoint,
	binanceUS bool,
	priceModes map[string]types.PriceFeedMode,
	bboStore *bbo.SnapshotStore,
	pairs ...types.CurrencyPair,
) (*BinanceProvider, error) {
	if (endpoints.Name) != ProviderBinance {
		if !binanceUS {
			endpoints = Endpoint{
				Name:      ProviderBinance,
				Rest:      binanceRestHost,
				Websocket: binanceWSHost,
			}
		} else {
			endpoints = Endpoint{
				Name:      ProviderBinanceUS,
				Rest:      binanceRestUSHost,
				Websocket: binanceUSWSHost,
			}
		}
	}

	wsURL := url.URL{
		Scheme: "wss",
		Host:   endpoints.Websocket,
		Path:   binanceWSPath,
	}

	binanceLogger := logger.With().Str("provider", string(endpoints.Name)).Logger()

	provider := &BinanceProvider{
		logger:     binanceLogger,
		endpoints:  endpoints,
		priceStore: newPriceStore(),
		priceModes: priceModes,
		bboStore:   bboStore,
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

	// Always subscribe to USDTUSD for price conversion (hardcoded)
	allPairs := append(confirmedPairs, types.CurrencyPair{Base: "USDT", Quote: "USD"})

	provider.wsc = NewWebsocketController(
		ctx,
		endpoints.Name,
		wsURL,
		provider.getSubscriptionMsgs(allPairs...),
		provider.messageReceived,
		disabledPingDuration,
		websocket.PingMessage,
		binanceLogger,
	)

	binanceLogger.Info().Msg("USDTUSD pair automatically subscribed for price conversion")

	return provider, nil
}

func (p *BinanceProvider) StartConnections() {
	p.wsc.StartConnections()
}

// SetTradeCallback sets the callback function for trade events
func (p *BinanceProvider) SetTradeCallback(callback func(BinanceTrade)) {
	p.mtx.Lock()
	defer p.mtx.Unlock()
	p.tradeCallback = callback
}

// updateUsdtUsdRate atomically updates the USDT/USD conversion rate
func (p *BinanceProvider) updateUsdtUsdRate(rate float64) {
	p.usdtUsdRate.Store(&UsdtUsdRate{
		Rate:      rate,
		Timestamp: time.Now(),
	})
	p.logger.Debug().Float64("rate", rate).Msg("USDT/USD rate updated")
}

// getUsdtUsdRate returns the current USDT/USD rate if available and not stale
// Falls back to 1.0 (1 USDT = 1 USD) if rate is unavailable or stale
func (p *BinanceProvider) getUsdtUsdRate() float64 {
	val := p.usdtUsdRate.Load()
	if val == nil {
		p.logger.Debug().Msg("USDT/USD rate not yet available, using fallback 1.0")
		return 1.0
	}

	rateData := val.(*UsdtUsdRate)

	// Check if rate is stale
	age := time.Since(rateData.Timestamp)
	if age > usdtRateMaxAge {
		p.logger.Warn().
			Float64("age_seconds", age.Seconds()).
			Float64("max_age_seconds", usdtRateMaxAge.Seconds()).
			Msg("USDT/USD rate is stale, using fallback 1.0")
		return 1.0
	}

	return rateData.Rate
}

// ConvertUsdtToUsd converts a USDT-denominated price to USD using current rate
// Returns (usdPrice, conversionRate)
func (p *BinanceProvider) feedModeForPair(cp types.CurrencyPair) types.PriceFeedMode {
	if p.priceModes == nil {
		return types.PriceFeedLastTrade
	}
	mode, ok := p.priceModes[cp.String()]
	if !ok {
		return types.PriceFeedLastTrade
	}
	return mode
}

func (p *BinanceProvider) feedModeForSymbol(sym string) types.PriceFeedMode {
	if p.priceModes == nil {
		return types.PriceFeedLastTrade
	}
	mode, ok := p.priceModes[sym]
	if !ok {
		return types.PriceFeedLastTrade
	}
	return mode
}

func (p *BinanceProvider) ConvertUsdtToUsd(usdtPrice string) (string, float64, error) {
	priceFloat, err := strconv.ParseFloat(usdtPrice, 64)
	if err != nil {
		return "", 0, fmt.Errorf("invalid USDT price: %w", err)
	}

	conversionRate := p.getUsdtUsdRate()
	usdPriceFloat := priceFloat * conversionRate

	// Preserve precision - format with 8 decimal places (standard for crypto)
	usdPrice := strconv.FormatFloat(usdPriceFloat, 'f', -1, 64)

	return usdPrice, conversionRate, nil
}

func (p *BinanceProvider) getSubscriptionMsgs(cps ...types.CurrencyPair) []interface{} {
	streams := make([]string, 0, len(cps))
	seen := make(map[string]struct{}, len(cps)*2)

	add := func(s string) {
		if _, dup := seen[s]; dup {
			return
		}
		seen[s] = struct{}{}
		streams = append(streams, s)
	}

	for _, cp := range cps {
		if cp.Base == "USDT" && cp.Quote == "USD" {
			add(currencyPairToBinanceTradePair(cp))
			continue
		}
		switch p.feedModeForPair(cp) {
		case types.PriceFeedBookMid:
			add(currencyPairToBinanceBookTickerPair(cp))
		default:
			add(currencyPairToBinanceTradePair(cp))
		}
	}

	return []interface{}{
		BinanceSubscriptionMsg{
			Method: "SUBSCRIBE",
			Params: streams,
			ID:     1,
		},
	}
}

// SubscribeCurrencyPairs sends the new subscription messages to the websocket
// and adds them to the providers subscribedPairs array
func (p *BinanceProvider) SubscribeCurrencyPairs(cps ...types.CurrencyPair) {
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

	newSubscriptionMsgs := p.getSubscriptionMsgs(confirmedPairs...)
	p.wsc.AddWebsocketConnection(
		newSubscriptionMsgs,
		p.messageReceived,
		disabledPingDuration,
		websocket.PingMessage,
	)
	p.setSubscribedPairs(confirmedPairs...)
}

func (p *BinanceProvider) messageReceived(_ int, conn *WebsocketConnection, bz []byte) {
	payload := binanceNormalizeMessage(conn, bz)
	if payload == nil {
		return
	}

	var (
		tradeResp        BinanceTrade
		tradeErr         error
		subscribeResp    BinanceSubscriptionResp
		subscribeRespErr error
	)

	// Parse trade events only (price-bot uses real-time trades)
	tradeErr = json.Unmarshal(payload, &tradeResp)
	if tradeResp.EventType == "trade" && len(tradeResp.Price) != 0 {
		// Special handling for USDTUSD: update conversion rate cache
		if tradeResp.Symbol == usdtUsdPair {
			rate, err := strconv.ParseFloat(tradeResp.Price, 64)
			if err != nil {
				p.logger.Error().Err(err).Str("price", tradeResp.Price).Msg("failed to parse USDT/USD rate")
				return
			}
			p.updateUsdtUsdRate(rate)
			telemetryWebsocketMessage(p.endpoints.Name, MessageTypeUsdtUsdUpdate)
			return
		}

		// Call trade callback for other pairs
		if p.feedModeForSymbol(tradeResp.Symbol) != types.PriceFeedLastTrade {
			return
		}

		if p.tradeCallback != nil {
			p.tradeCallback(tradeResp)
		}
		telemetryWebsocketMessage(p.endpoints.Name, MessageTypeTrade)
		return
	}

	var book BinanceBookTicker
	// Combined-stream `data` sometimes omits `e`; accept top-of-book payloads with bid/ask.
	if err := json.Unmarshal(payload, &book); err == nil && book.Symbol != "" &&
		book.BestBid != "" && book.BestAsk != "" &&
		(strings.EqualFold(book.EventType, "bookTicker") || book.EventType == "") {
		if book.Symbol == usdtUsdPair {
			return
		}
		if p.feedModeForSymbol(book.Symbol) != types.PriceFeedBookMid {
			return
		}
		if _, err := MidPriceFromBestBidAsk(book.BestBid, book.BestAsk); err != nil {
			p.logger.Debug().Err(err).Str("symbol", book.Symbol).Msg("skip bookTicker BBO")
			return
		}
		if p.bboStore != nil {
			usdSym := symbolUSDTToUSD(book.Symbol)
			p.bboStore.Update(bbo.Key{Provider: string(p.endpoints.Name), Symbol: usdSym}, book.BestBid, book.BestAsk)
			recordBookMidWSUpdate(string(p.endpoints.Name), usdSym)
		}
		telemetryWebsocketMessage(p.endpoints.Name, MessageTypeBookTicker)
		return
	}

	subscribeRespErr = json.Unmarshal(payload, &subscribeResp)
	if subscribeResp.ID == 1 {
		return
	}

	// Log unrecognized messages (debugging only)
	p.logger.Error().
		Int("length", len(payload)).
		AnErr("trade", tradeErr).
		AnErr("subscribeResp", subscribeRespErr).
		Msg("Unrecognized message received")
}

// GetAvailablePairs returns all pairs to which the provider can subscribe.
// ex.: map["ATOMUSDT" => {}, "OJOUSDC" => {}].
func (p *BinanceProvider) GetAvailablePairs() (map[string]struct{}, error) {
	resp, err := http.Get(p.endpoints.Rest + binanceRestPath)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var pairsSummary []BinancePairSummary
	if err := json.Unmarshal(b, &pairsSummary); err != nil {
		fmt.Println("Failure in GetAvailablePairs", p.endpoints.Rest+binanceRestPath)
		fmt.Println(string(b))
		return nil, err
	}

	availablePairs := make(map[string]struct{}, len(pairsSummary))
	for _, pairName := range pairsSummary {
		availablePairs[strings.ToUpper(pairName.Symbol)] = struct{}{}
	}

	return availablePairs, nil
}

const binanceProvider = "binance"

// currencyPairToBinanceTickerPair receives a currency pair and return binance
// ticker symbol atomusdt@ticker.
func currencyPairToBinanceTickerPair(cp types.CurrencyPair) string {
	return strings.ToLower(cp.String() + "@ticker")
}

// currencyPairToBinanceTradePair receives a currency pair and returns binance
// trade symbol btcusdt@trade for real-time trade events
func currencyPairToBinanceTradePair(cp types.CurrencyPair) string {
	return strings.ToLower(cp.String() + "@trade")
}

func symbolUSDTToUSD(symbol string) string {
	if strings.HasSuffix(symbol, "USDT") {
		return strings.TrimSuffix(symbol, "USDT") + "USD"
	}
	return symbol
}

func currencyPairToBinanceBookTickerPair(cp types.CurrencyPair) string {
	// Symbol must be lowercase; stream suffix is camelCase @bookTicker (not @bookticker).
	return strings.ToLower(cp.String()) + "@bookTicker"
}
