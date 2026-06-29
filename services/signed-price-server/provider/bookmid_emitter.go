package provider

import (
	"context"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
	"github.com/syndicate/backend/services/signed-price-server/failover"
	"github.com/syndicate/backend/services/signed-price-server/pricebuild"
	"github.com/syndicate/backend/services/signed-price-server/signing"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

// eventDebounce rate-limits event-driven emits per symbol so a burst of BBO
// quote changes produces at most one extra signature per window (the heartbeat
// still guarantees the cadence floor). Leading-edge: the first change after a
// quiet window emits immediately for low move-latency.
const eventDebounce = 2 * time.Millisecond

// eventChanBuffer bounds the change-notification queue from the BBO store.
const eventChanBuffer = 256

// TradeSubmitter submits trades for signing (typically signing.WorkerPool).
type TradeSubmitter interface {
	SubmitTrade(trade signing.TradeUpdate) bool
}

// UsdtToUsdConverter converts USDT-denominated prices to USD.
type UsdtToUsdConverter interface {
	ConvertUsdtToUsd(usdtPrice string) (usdPrice string, rate float64, err error)
}

// BookMidEntry is one book_mid pair the emitter signs on a fixed interval.
type BookMidEntry struct {
	Provider  types.ProviderName
	Exchange  string
	PairKey   string
	UsdSymbol string
	BboKey    bbo.Key
	Token     common.Address
	NeedsUSDT bool
}

// BookMidEmitter ticks at a fixed interval and submits mid prices from the BBO store.
type BookMidEmitter struct {
	ctx        context.Context
	logger     zerolog.Logger
	store      *bbo.SnapshotStore
	entries    []BookMidEntry
	entryByKey map[bbo.Key]BookMidEntry
	submitter  TradeSubmitter
	binance    map[types.ProviderName]UsdtToUsdConverter
	interval   time.Duration
	maxBookAge time.Duration

	signGate failover.SignGate
	observer failover.StalenessObserver

	// Per-key leading-edge debounce state for event-driven emits.
	debounceMu    sync.Mutex
	lastEventEmit map[bbo.Key]time.Time
}

// NewBookMidEmitter creates an emitter. signGate and observer are optional (nil disables failover gating).
func NewBookMidEmitter(
	ctx context.Context,
	logger zerolog.Logger,
	store *bbo.SnapshotStore,
	entries []BookMidEntry,
	submitter TradeSubmitter,
	binanceConverters map[types.ProviderName]UsdtToUsdConverter,
	emitInterval, maxBookAge time.Duration,
	signGate failover.SignGate,
	observer failover.StalenessObserver,
) *BookMidEmitter {
	entryByKey := make(map[bbo.Key]BookMidEntry, len(entries))
	for _, ent := range entries {
		entryByKey[ent.BboKey] = ent
	}
	return &BookMidEmitter{
		ctx:           ctx,
		logger:        logger.With().Str("component", "book_mid_emitter").Logger(),
		store:         store,
		entries:       entries,
		entryByKey:    entryByKey,
		submitter:     submitter,
		binance:       binanceConverters,
		interval:      emitInterval,
		maxBookAge:    maxBookAge,
		signGate:      signGate,
		observer:      observer,
		lastEventEmit: make(map[bbo.Key]time.Time),
	}
}

// Start runs the emit loop until ctx is cancelled.
func (e *BookMidEmitter) Start() {
	if len(e.entries) == 0 {
		return
	}
	e.logger.Info().
		Int("pairs", len(e.entries)).
		Dur("interval", e.interval).
		Dur("max_book_age", e.maxBookAge).
		Msg("starting book_mid emitter")

	// Event-driven path: emit immediately (debounced) when a tracked BBO price
	// changes, in addition to the heartbeat below.
	changeCh := make(chan bbo.Key, eventChanBuffer)
	e.store.SetChangeListener(changeCh)
	defer e.store.SetChangeListener(nil)
	go e.consumeEvents(changeCh)

	ticker := time.NewTicker(e.interval)
	defer ticker.Stop()

	for {
		select {
		case <-e.ctx.Done():
			e.logger.Info().Msg("book_mid emitter stopped")
			return
		case <-ticker.C:
			e.tick()
		}
	}
}

// consumeEvents drains BBO change notifications and emits the affected entry,
// rate-limited per key by eventDebounce.
func (e *BookMidEmitter) consumeEvents(ch <-chan bbo.Key) {
	for {
		select {
		case <-e.ctx.Done():
			return
		case k := <-ch:
			ent, ok := e.entryByKey[k]
			if !ok {
				continue
			}
			if !e.allowEventEmit(k) {
				continue
			}
			e.emitEntry(time.Now(), ent)
		}
	}
}

// allowEventEmit returns true if an event-driven emit for k is outside the
// debounce window, recording the emit time when it returns true.
func (e *BookMidEmitter) allowEventEmit(k bbo.Key) bool {
	now := time.Now()
	e.debounceMu.Lock()
	defer e.debounceMu.Unlock()
	if last, ok := e.lastEventEmit[k]; ok && now.Sub(last) < eventDebounce {
		return false
	}
	e.lastEventEmit[k] = now
	return true
}

func (e *BookMidEmitter) tick() {
	now := time.Now()
	for _, ent := range e.entries {
		e.emitEntry(now, ent)
	}
}

// emitEntry builds and submits one book_mid trade for ent, applying the
// staleness gate, invalid-BBO and conversion guards. Safe for concurrent use by
// the heartbeat ticker and the event-driven consumer (SubmitTrade and metrics
// are goroutine-safe).
func (e *BookMidEmitter) emitEntry(now time.Time, ent BookMidEntry) {
	bid, ask, bookUpdatedAt, ready, ok := e.store.Snapshot(ent.BboKey)
	bookAge := time.Since(bookUpdatedAt)
	if !ok || !ready {
		setBookMidObservability(ent.UsdSymbol, 0, true)
		recordBookMidSkipped(ent.UsdSymbol, "not_ready")
		return
	}

	paused := bookAge > e.maxBookAge
	setBookMidObservability(ent.UsdSymbol, bookAge.Seconds(), paused)
	if e.observer != nil {
		e.observer.OnBookMidTick(ent.UsdSymbol, bookAge, paused)
	}
	if paused {
		recordBookMidSkipped(ent.UsdSymbol, "stale_book")
		return
	}
	if e.signGate != nil && !e.signGate.CanSign(ent.UsdSymbol) {
		recordBookMidSkipped(ent.UsdSymbol, "failover_standby")
		return
	}

	mid, err := MidPriceFromBestBidAsk(bid, ask)
	if err != nil {
		e.logger.Debug().Err(err).Str("symbol", ent.UsdSymbol).Msg("skip emit invalid BBO")
		recordBookMidSkipped(ent.UsdSymbol, "invalid_bbo")
		return
	}

	usdPrice := mid
	usdBid := bid
	usdAsk := ask
	if ent.NeedsUSDT {
		conv, ok := e.binance[ent.Provider]
		if !ok {
			recordBookMidSkipped(ent.UsdSymbol, "no_converter")
			return
		}
		var convErr error
		usdPrice, _, convErr = conv.ConvertUsdtToUsd(mid)
		if convErr != nil {
			e.logger.Debug().Err(convErr).Str("symbol", ent.UsdSymbol).Msg("skip emit conversion failed")
			recordBookMidSkipped(ent.UsdSymbol, "conversion_error")
			return
		}
		// Convert bid / ask with the same rate. A failure here is observational only;
		// fall back to omitting the meta on this tick rather than skipping the emit.
		if b, _, err := conv.ConvertUsdtToUsd(bid); err == nil {
			usdBid = b
		} else {
			usdBid = ""
		}
		if a, _, err := conv.ConvertUsdtToUsd(ask); err == nil {
			usdAsk = a
		} else {
			usdAsk = ""
		}
	}

	priceInWad, err := pricebuild.PriceToWad(usdPrice)
	if err != nil {
		e.logger.Debug().Err(err).Str("symbol", ent.UsdSymbol).Msg("skip emit wad failed")
		recordBookMidSkipped(ent.UsdSymbol, "wad_error")
		return
	}

	update := signing.TradeUpdate{
		Token:      ent.Token,
		Symbol:     ent.UsdSymbol,
		Price:      usdPrice,
		PriceInWad: priceInWad,
		Quantity:   "",
		Timestamp:  now.UnixMilli(),
		TradeID:    0,
		Exchange:   ent.Exchange,
		Bid:        usdBid,
		Ask:        usdAsk,
		BookAgeMs:  bookAge.Milliseconds(),
	}
	if e.submitter.SubmitTrade(update) {
		recordBookMidEmit(ent.UsdSymbol, ent.Exchange)
	} else {
		recordBookMidSkipped(ent.UsdSymbol, "queue_full")
	}
}
