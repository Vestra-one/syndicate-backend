package provider

import (
	"context"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
)

// TestBookMidEmitter_emitCadence verifies multiple submits while BBO stays fresh.
func TestBookMidEmitter_emitCadence(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "binance", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	sub := &mockSubmitter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const interval = 20 * time.Millisecond
	ent := BookMidEntry{
		Provider:  ProviderCoinbase,
		Exchange:  "coinbase",
		UsdSymbol: "BTCUSD",
		BboKey:    key,
		Token:     common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"),
	}
	emitter := NewBookMidEmitter(ctx, zerolog.Nop(), store, []BookMidEntry{ent}, sub, nil, interval, time.Second, nil, nil)
	go emitter.Start()

	time.Sleep(95 * time.Millisecond)
	n := sub.count()
	if n < 3 {
		t.Fatalf("expected at least 3 emits in ~95ms at 20ms interval, got %d", n)
	}
	if n > 8 {
		t.Fatalf("expected at most ~5 emits, got %d (runaway ticker?)", n)
	}
}
