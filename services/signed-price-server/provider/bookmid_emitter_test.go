package provider

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
	"github.com/syndicate/backend/services/signed-price-server/signing"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

type mockSubmitter struct {
	mu      sync.Mutex
	updates []signing.TradeUpdate
}

func (m *mockSubmitter) SubmitTrade(t signing.TradeUpdate) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.updates = append(m.updates, t)
	return true
}

func (m *mockSubmitter) last() (signing.TradeUpdate, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.updates) == 0 {
		return signing.TradeUpdate{}, false
	}
	return m.updates[len(m.updates)-1], true
}

func (m *mockSubmitter) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.updates)
}

func TestBookMidEmitter_stale_skips_emit(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	sub := &mockSubmitter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ent := BookMidEntry{
		Provider:  ProviderCoinbase,
		Exchange:  "coinbase",
		UsdSymbol: "BTCUSD",
		BboKey: bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"},
		Token:     common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"),
	}
	emitter := NewBookMidEmitter(ctx, zerolog.Nop(), store, []BookMidEntry{ent}, sub, nil, 5*time.Millisecond, 10*time.Millisecond, nil, nil)
	go emitter.Start()

	time.Sleep(25 * time.Millisecond)
	if sub.count() == 0 {
		t.Fatal("expected emits while fresh")
	}
	before := sub.count()

	time.Sleep(20 * time.Millisecond)
	if sub.count() != before {
		t.Fatalf("expected no new emits while stale, before=%d after=%d", before, sub.count())
	}

	store.Update(key, "101", "103")
	time.Sleep(15 * time.Millisecond)
	if sub.count() <= before {
		t.Fatal("expected auto-resume after BBO update")
	}
}

type fixedRateConverter struct {
	rate float64
}

func (c fixedRateConverter) ConvertUsdtToUsd(usdtPrice string) (string, float64, error) {
	v, err := strconv.ParseFloat(usdtPrice, 64)
	if err != nil {
		return "", 0, err
	}
	return strconv.FormatFloat(v*c.rate, 'f', -1, 64), c.rate, nil
}

func TestBookMidEmitter_meta_bid_ask_passthrough_coinbase(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100.50", "100.60")

	sub := &mockSubmitter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ent := BookMidEntry{
		Provider:  ProviderCoinbase,
		Exchange:  "coinbase",
		UsdSymbol: "BTCUSD",
		BboKey:    key,
		Token:     common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"),
	}
	emitter := NewBookMidEmitter(ctx, zerolog.Nop(), store, []BookMidEntry{ent}, sub, nil, 5*time.Millisecond, time.Second, nil, nil)
	go emitter.Start()
	time.Sleep(15 * time.Millisecond)

	u, ok := sub.last()
	if !ok {
		t.Fatal("expected at least one emit")
	}
	if u.Bid != "100.50" || u.Ask != "100.60" {
		t.Fatalf("expected raw bid/ask, got bid=%q ask=%q", u.Bid, u.Ask)
	}
	if u.Price != "100.55" {
		t.Fatalf("expected mid=100.55, got %q", u.Price)
	}
}

func TestBookMidEmitter_meta_bid_ask_converted_for_binance_usdt(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "binance", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	sub := &mockSubmitter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ent := BookMidEntry{
		Provider:  ProviderBinance,
		Exchange:  "binance",
		UsdSymbol: "BTCUSD",
		BboKey:    key,
		Token:     common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"),
		NeedsUSDT: true,
	}
	converters := map[types.ProviderName]UsdtToUsdConverter{
		ProviderBinance: fixedRateConverter{rate: 1.5},
	}
	emitter := NewBookMidEmitter(ctx, zerolog.Nop(), store, []BookMidEntry{ent}, sub, converters, 5*time.Millisecond, time.Second, nil, nil)
	go emitter.Start()
	time.Sleep(15 * time.Millisecond)

	u, ok := sub.last()
	if !ok {
		t.Fatal("expected at least one emit")
	}
	// 100 USDT * 1.5 = 150 USD; 102 USDT * 1.5 = 153 USD; mid = 101 USDT * 1.5 = 151.5 USD.
	if u.Bid != "150" || u.Ask != "153" {
		t.Fatalf("expected converted bid=150 ask=153, got bid=%q ask=%q", u.Bid, u.Ask)
	}
	if u.Price != "151.5" {
		t.Fatalf("expected mid=151.5, got %q", u.Price)
	}
}

// TestBookMidEmitter_book_age_ms_populated covers 1.1: emitted trades carry the
// BBO snapshot age (observational), within the freshness bound.
func TestBookMidEmitter_book_age_ms_populated(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	sub := &mockSubmitter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ent := BookMidEntry{
		Provider:  ProviderCoinbase,
		Exchange:  "coinbase",
		UsdSymbol: "BTCUSD",
		BboKey:    key,
		Token:     common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"),
	}
	maxAge := 500 * time.Millisecond
	emitter := NewBookMidEmitter(ctx, zerolog.Nop(), store, []BookMidEntry{ent}, sub, nil, 5*time.Millisecond, maxAge, nil, nil)
	go emitter.Start()
	time.Sleep(15 * time.Millisecond)

	u, ok := sub.last()
	if !ok {
		t.Fatal("expected at least one emit")
	}
	if u.BookAgeMs < 0 || u.BookAgeMs > maxAge.Milliseconds() {
		t.Fatalf("book_age_ms out of expected range [0,%d]: %d", maxAge.Milliseconds(), u.BookAgeMs)
	}
}

// TestBookMidEmitter_event_driven_emit_on_change covers 3.2: a BBO price change
// triggers an emit even when the heartbeat interval has not elapsed.
func TestBookMidEmitter_event_driven_emit_on_change(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}

	sub := &mockSubmitter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ent := BookMidEntry{
		Provider:  ProviderCoinbase,
		Exchange:  "coinbase",
		UsdSymbol: "BTCUSD",
		BboKey:    key,
		Token:     common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"),
	}
	// Hour-long heartbeat: any emit we observe must come from the event path.
	emitter := NewBookMidEmitter(ctx, zerolog.Nop(), store, []BookMidEntry{ent}, sub, nil, time.Hour, time.Second, nil, nil)
	go emitter.Start()

	// Let Start register the change listener before the first update.
	time.Sleep(20 * time.Millisecond)
	store.Update(key, "100", "102")

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if sub.count() > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("expected an event-driven emit after BBO change")
}

func TestBookMidEmitter_auto_resume_timestamp_increases(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "ETHUSD"}
	store.Update(key, "2000", "2002")

	sub := &mockSubmitter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ent := BookMidEntry{
		Provider:  ProviderCoinbase,
		Exchange:  "coinbase",
		UsdSymbol: "ETHUSD",
		BboKey:    key,
		Token:     common.HexToAddress("0x4200000000000000000000000000000000000006"),
	}
	emitter := NewBookMidEmitter(ctx, zerolog.Nop(), store, []BookMidEntry{ent}, sub, nil, 5*time.Millisecond, time.Second, nil, nil)
	go emitter.Start()
	time.Sleep(12 * time.Millisecond)

	u1, ok := sub.last()
	if !ok {
		t.Fatal("expected update")
	}
	time.Sleep(8 * time.Millisecond)
	u2, ok := sub.last()
	if !ok || u2.Timestamp <= u1.Timestamp {
		t.Fatalf("expected increasing timestamps: %d -> %d", u1.Timestamp, u2.Timestamp)
	}
}
