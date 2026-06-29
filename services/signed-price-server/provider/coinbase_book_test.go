package provider

import (
	"strconv"
	"sync"
	"testing"
)

func TestCoinbaseBook_SnapshotInstallsTopOfBook(t *testing.T) {
	s := NewCoinbaseBookStore()
	bid, ask, ok := s.Reset("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.00", NewQuantity: "1"},
		{Side: "bid", PriceLevel: "99.50", NewQuantity: "2"},
		{Side: "bid", PriceLevel: "99.00", NewQuantity: "3"},
		{Side: "offer", PriceLevel: "101.00", NewQuantity: "1"},
		{Side: "offer", PriceLevel: "101.50", NewQuantity: "2"},
		{Side: "offer", PriceLevel: "102.00", NewQuantity: "3"},
	})
	if !ok {
		t.Fatalf("expected ok=true after snapshot")
	}
	if bid != "100.00" {
		t.Fatalf("expected bestBid 100.00, got %q", bid)
	}
	if ask != "101.00" {
		t.Fatalf("expected bestAsk 101.00, got %q", ask)
	}

	bid2, ask2, ok2 := s.BestBidAsk("BTC-USD")
	if !ok2 || bid2 != bid || ask2 != ask {
		t.Fatalf("atomic snapshot mismatch: (%q,%q,%v) vs (%q,%q,%v)", bid2, ask2, ok2, bid, ask, ok)
	}
}

func TestCoinbaseBook_UpdateChangesBestBidAsk(t *testing.T) {
	s := NewCoinbaseBookStore()
	s.Reset("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.00", NewQuantity: "1"},
		{Side: "offer", PriceLevel: "101.00", NewQuantity: "1"},
	})
	bid, ask, ok := s.Apply("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.50", NewQuantity: "1"},
		{Side: "offer", PriceLevel: "100.80", NewQuantity: "2"},
	})
	if !ok {
		t.Fatalf("expected ok after update")
	}
	if bid != "100.50" {
		t.Fatalf("expected bestBid 100.50, got %q", bid)
	}
	if ask != "100.80" {
		t.Fatalf("expected bestAsk 100.80, got %q", ask)
	}
}

func TestCoinbaseBook_ZeroQuantityRemovesLevel(t *testing.T) {
	s := NewCoinbaseBookStore()
	s.Reset("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.00", NewQuantity: "1"},
		{Side: "bid", PriceLevel: "99.50", NewQuantity: "2"},
		{Side: "offer", PriceLevel: "101.00", NewQuantity: "1"},
	})
	bid, ask, ok := s.Apply("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.00", NewQuantity: "0"},
	})
	if !ok {
		t.Fatalf("expected ok after delete")
	}
	if bid != "99.50" {
		t.Fatalf("expected next-best bid 99.50, got %q", bid)
	}
	if ask != "101.00" {
		t.Fatalf("expected ask unchanged 101.00, got %q", ask)
	}
	bids, asks, _ := s.LevelCounts("BTC-USD")
	if bids != 1 || asks != 1 {
		t.Fatalf("unexpected level counts bids=%d asks=%d", bids, asks)
	}
}

func TestCoinbaseBook_ResnapshotClearsStaleLevels(t *testing.T) {
	s := NewCoinbaseBookStore()
	s.Reset("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.00", NewQuantity: "1"},
		{Side: "bid", PriceLevel: "99.00", NewQuantity: "2"},
		{Side: "offer", PriceLevel: "101.00", NewQuantity: "1"},
		{Side: "offer", PriceLevel: "102.00", NewQuantity: "2"},
	})
	bid, ask, _ := s.Reset("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "50.00", NewQuantity: "1"},
		{Side: "offer", PriceLevel: "51.00", NewQuantity: "1"},
	})
	if bid != "50.00" || ask != "51.00" {
		t.Fatalf("re-snapshot did not replace book: bid=%q ask=%q", bid, ask)
	}
	bids, asks, _ := s.LevelCounts("BTC-USD")
	if bids != 1 || asks != 1 {
		t.Fatalf("expected 1/1 levels after re-snapshot, got %d/%d", bids, asks)
	}
}

func TestCoinbaseBook_ApplyBeforeSnapshotIsDropped(t *testing.T) {
	s := NewCoinbaseBookStore()
	_, _, ok := s.Apply("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.00", NewQuantity: "1"},
	})
	if ok {
		t.Fatalf("expected Apply before Reset to return ok=false")
	}
	if _, _, hasBBO := s.BestBidAsk("BTC-USD"); hasBBO {
		t.Fatalf("expected no BBO before snapshot")
	}
}

func TestCoinbaseBook_OneSidedSnapshotReturnsNotOK(t *testing.T) {
	s := NewCoinbaseBookStore()
	_, _, ok := s.Reset("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.00", NewQuantity: "1"},
	})
	if ok {
		t.Fatalf("expected ok=false when ask side is empty")
	}
}

func TestCoinbaseBook_IgnoresUnknownSideAndBadInputs(t *testing.T) {
	s := NewCoinbaseBookStore()
	bid, ask, ok := s.Reset("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.00", NewQuantity: "1"},
		{Side: "offer", PriceLevel: "101.00", NewQuantity: "1"},
		{Side: "sell", PriceLevel: "200.00", NewQuantity: "1"},
		{Side: "bid", PriceLevel: "not-a-number", NewQuantity: "1"},
		{Side: "bid", PriceLevel: "0", NewQuantity: "1"},
		{Side: "bid", PriceLevel: "-1", NewQuantity: "1"},
	})
	if !ok || bid != "100.00" || ask != "101.00" {
		t.Fatalf("unexpected BBO after malformed inputs: bid=%q ask=%q ok=%v", bid, ask, ok)
	}
	bids, asks, _ := s.LevelCounts("BTC-USD")
	if bids != 1 || asks != 1 {
		t.Fatalf("expected 1/1 valid levels, got %d/%d", bids, asks)
	}
}

func TestCoinbaseBook_ConcurrentApplyAndRead(t *testing.T) {
	s := NewCoinbaseBookStore()
	s.Reset("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.00", NewQuantity: "1"},
		{Side: "offer", PriceLevel: "101.00", NewQuantity: "1"},
	})

	stop := make(chan struct{})
	var wg sync.WaitGroup

	// Single writer goroutine, mirroring the WS reader.
	wg.Add(1)
	go func() {
		defer wg.Done()
		base := 100.0
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			p := base + float64(i%50)*0.01
			s.Apply("BTC-USD", []L2Update{
				{Side: "bid", PriceLevel: formatFloat(p), NewQuantity: "1"},
				{Side: "offer", PriceLevel: formatFloat(p + 1), NewQuantity: "1"},
			})
		}
	}()

	// Many reader goroutines mirroring the emitter tick.
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 10000; i++ {
				select {
				case <-stop:
					return
				default:
				}
				if bid, ask, ok := s.BestBidAsk("BTC-USD"); ok {
					if bid == "" || ask == "" {
						t.Errorf("empty BBO with ok=true")
						return
					}
				}
			}
		}()
	}

	// Let it run briefly then stop.
	for i := 0; i < 200; i++ {
		s.BestBidAsk("BTC-USD")
	}
	close(stop)
	wg.Wait()
}

func formatFloat(f float64) string {
	return strconv.FormatFloat(f, 'f', 2, 64)
}

// TestCoinbaseBook_DistinctStringsSameFloatNotCollapsed covers 4.3: two distinct
// decimal strings that round to the same float64 must remain separate btree
// levels (the old float-only key silently collapsed them). Deleting one must not
// remove the other.
func TestCoinbaseBook_DistinctStringsSameFloatNotCollapsed(t *testing.T) {
	// "100.10" and "100.1" parse to the same float64 but differ as strings.
	if a, b := mustParse(t, "100.10"), mustParse(t, "100.1"); a != b {
		t.Fatalf("test precondition failed: %v != %v", a, b)
	}

	s := NewCoinbaseBookStore()
	s.Reset("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.10", NewQuantity: "1"},
		{Side: "bid", PriceLevel: "100.1", NewQuantity: "2"},
		{Side: "offer", PriceLevel: "101.00", NewQuantity: "1"},
	})
	if bids, _, _ := s.LevelCounts("BTC-USD"); bids != 2 {
		t.Fatalf("expected 2 distinct bid levels (no float collision), got %d", bids)
	}

	// Deleting one decimal string must leave the other intact.
	s.Apply("BTC-USD", []L2Update{
		{Side: "bid", PriceLevel: "100.10", NewQuantity: "0"},
	})
	if bids, _, _ := s.LevelCounts("BTC-USD"); bids != 1 {
		t.Fatalf("expected 1 bid after deleting one colliding string, got %d", bids)
	}
}

func mustParse(t *testing.T, s string) float64 {
	t.Helper()
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return f
}
