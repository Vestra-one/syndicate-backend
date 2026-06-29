package bbo

import (
	"testing"
	"time"
)

// TestSnapshotStore_changeListenerFiresOnlyOnChange covers the 3.2 event-driven
// notification: the listener fires when bid or ask changes, and stays silent on
// an identical update.
func TestSnapshotStore_changeListenerFiresOnlyOnChange(t *testing.T) {
	t.Parallel()
	store := NewSnapshotStore()
	ch := make(chan Key, 8)
	store.SetChangeListener(ch)
	k := Key{Provider: "coinbase", Symbol: "BTCUSD"}

	store.Update(k, "100", "102") // first update => change
	select {
	case got := <-ch:
		if got != k {
			t.Fatalf("got key %v, want %v", got, k)
		}
	default:
		t.Fatal("expected notification on first update")
	}

	store.Update(k, "100", "102") // identical => no notification
	select {
	case <-ch:
		t.Fatal("expected no notification on identical update")
	default:
	}

	store.Update(k, "101", "102") // bid changed => notification
	select {
	case <-ch:
	default:
		t.Fatal("expected notification on changed bid")
	}
}

func TestSnapshotStore_update_fresh_stale_resume(t *testing.T) {
	t.Parallel()
	store := NewSnapshotStore()
	key := Key{Provider: "binance", Symbol: "BTCUSD"}
	maxAge := 10 * time.Millisecond

	if store.IsFresh(key, maxAge) {
		t.Fatal("expected not fresh before update")
	}

	store.Update(key, "100", "102")
	if !store.IsFresh(key, maxAge) {
		t.Fatal("expected fresh after update")
	}

	time.Sleep(15 * time.Millisecond)
	if store.IsFresh(key, maxAge) {
		t.Fatal("expected stale after sleep")
	}

	store.Update(key, "101", "103")
	if !store.IsFresh(key, maxAge) {
		t.Fatal("expected fresh after resume update")
	}
}

func TestSnapshotStore_healthStartupGrace(t *testing.T) {
	t.Parallel()
	store := NewSnapshotStore()
	key := Key{Provider: "binance", Symbol: "ETHUSD"}
	started := time.Now()
	report := store.HealthReport([]Key{key}, time.Second, started)
	if report["ETHUSD"].Paused || report["ETHUSD"].Reason != "starting_up" {
		t.Fatalf("expected starting_up, got %+v", report["ETHUSD"])
	}
	if store.AnyPaused([]Key{key}, time.Second, started) {
		t.Fatal("expected not paused during startup grace")
	}
	oldStart := time.Now().Add(-2 * time.Second)
	if !store.AnyPaused([]Key{key}, time.Second, oldStart) {
		t.Fatal("expected paused when not ready after grace")
	}
}
