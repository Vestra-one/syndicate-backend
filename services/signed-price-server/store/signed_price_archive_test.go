package store

import (
	"path/filepath"
	"testing"

	"github.com/syndicate/backend/services/signed-price-server/signing"
)

func testSignedPrice(symbol string, timestampMs, signedAtMs int64) signing.SignedPrice {
	return signing.SignedPrice{
		Token:      "0xa7BaE7da3E4950700BE9f107EB186e89a474d180",
		Symbol:     symbol,
		Price:      "100000",
		PriceInWad: "100000000000000000000000",
		Quantity:   "0",
		Timestamp:  timestampMs,
		TradeID:    timestampMs,
		Exchange:   "coinbase",
		V:          27,
		R:          "0x" + "11",
		S:          "0x" + "22",
		PublicKey:  "0x" + "33",
		SignedAt:   signedAtMs,
	}
}

func newArchiveStore(t *testing.T) *SignedPriceStore {
	t.Helper()
	store, err := NewSignedPriceStoreWithArchive(16, filepath.Join(t.TempDir(), "prices.sqlite"))
	if err != nil {
		t.Fatalf("new archive store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	})
	return store
}

func TestSecondBucketKeepsLatestPayloadTimestamp(t *testing.T) {
	store := newArchiveStore(t)

	store.Store(testSignedPrice("BTCUSD", 1_715_000_000_100, 10))
	store.Store(testSignedPrice("BTCUSD", 1_715_000_000_900, 11))

	got, ok, err := store.GetAt("BTCUSD", 1_715_000_000)
	if err != nil {
		t.Fatalf("get archive price: %v", err)
	}
	if !ok {
		t.Fatal("expected archived price")
	}
	if got.Timestamp != 1_715_000_000_900 {
		t.Fatalf("expected latest timestamp, got %d", got.Timestamp)
	}
}

func TestOlderSameSecondDoesNotReplaceNewer(t *testing.T) {
	store := newArchiveStore(t)

	store.Store(testSignedPrice("ETHUSD", 1_715_000_000_900, 10))
	store.Store(testSignedPrice("ETHUSD", 1_715_000_000_100, 99))

	got, ok, err := store.GetAt("ETHUSD", 1_715_000_000)
	if err != nil {
		t.Fatalf("get archive price: %v", err)
	}
	if !ok {
		t.Fatal("expected archived price")
	}
	if got.Timestamp != 1_715_000_000_900 {
		t.Fatalf("older same-second update replaced latest: %d", got.Timestamp)
	}
}

func TestSecondBucketTiebreaksBySignedAt(t *testing.T) {
	store := newArchiveStore(t)

	store.Store(testSignedPrice("SOLUSD", 1_715_000_000_500, 10))
	store.Store(testSignedPrice("SOLUSD", 1_715_000_000_500, 11))

	got, ok, err := store.GetAt("SOLUSD", 1_715_000_000)
	if err != nil {
		t.Fatalf("get archive price: %v", err)
	}
	if !ok {
		t.Fatal("expected archived price")
	}
	if got.SignedAt != 11 {
		t.Fatalf("expected signed_at tie-break winner, got %d", got.SignedAt)
	}
}

func TestSQLitePersistenceSurvivesReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "prices.sqlite")
	store, err := NewSignedPriceStoreWithArchive(16, dbPath)
	if err != nil {
		t.Fatalf("new archive store: %v", err)
	}
	store.Store(testSignedPrice("BTCUSD", 1_715_000_123_456, 10))
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	reopened, err := NewSignedPriceStoreWithArchive(16, dbPath)
	if err != nil {
		t.Fatalf("reopen archive store: %v", err)
	}
	defer reopened.Close()

	got, ok, err := reopened.GetAt("BTCUSD", 1_715_000_123)
	if err != nil {
		t.Fatalf("get archive price: %v", err)
	}
	if !ok {
		t.Fatal("expected archived price after reopen")
	}
	if got.Timestamp != 1_715_000_123_456 {
		t.Fatalf("unexpected timestamp after reopen: %d", got.Timestamp)
	}
}
