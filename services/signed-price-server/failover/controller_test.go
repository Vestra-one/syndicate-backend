package failover

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
)

func testSettings(primary, standby bool) Settings {
	symbols := []SymbolSettings{}
	if primary {
		symbols = append(symbols, SymbolSettings{Symbol: "BTCUSD", Role: RolePrimary})
	}
	if standby {
		symbols = append(symbols, SymbolSettings{Symbol: "BTCUSD", Role: RoleStandby})
	}
	return Settings{
		Enabled:            true,
		NodeID:             "test-primary",
		PeerNodeID:         "test-standby",
		PeerURL:            "http://unused",
		PromoteDebounce:    10 * time.Millisecond,
		RecoverHysteresis:  50 * time.Millisecond,
		PeerRequestTimeout: 500 * time.Millisecond,
		Symbols:            symbols,
	}
}

func TestController_primaryCanSignByDefault(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	ctrl := NewController(testSettings(true, false), store, 20*time.Millisecond, []bbo.Key{key}, zerolog.Nop())
	if !ctrl.CanSign("BTCUSD") {
		t.Fatal("primary should sign in active state")
	}
}

func TestController_standbyCannotSignByDefault(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	ctrl := NewController(testSettings(false, true), store, 20*time.Millisecond, []bbo.Key{key}, zerolog.Nop())
	if ctrl.CanSign("BTCUSD") {
		t.Fatal("standby should not sign in standby_warm")
	}
}

func TestController_disabledAlwaysCanSign(t *testing.T) {
	t.Parallel()
	cfg := testSettings(true, false)
	cfg.Enabled = false
	ctrl := NewController(cfg, bbo.NewSnapshotStore(), time.Second, nil, zerolog.Nop())
	if !ctrl.CanSign("BTCUSD") {
		t.Fatal("disabled failover should not gate signing")
	}
}

func TestController_promoteEnablesStandbySigning(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	standby := NewController(testSettings(false, true), store, 50*time.Millisecond, []bbo.Key{key}, zerolog.Nop())
	resp := standby.HandlePromote(context.Background(), PromoteRequest{
		Symbols: []string{"BTCUSD"},
		Epoch:   1,
	})
	if !resp.Accepted {
		t.Fatalf("promote rejected: %+v", resp)
	}
	if !standby.CanSign("BTCUSD") {
		t.Fatal("standby should sign after promote")
	}
}

func TestController_promoteRejectsStaleBook(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	standby := NewController(testSettings(false, true), store, 5*time.Millisecond, []bbo.Key{key}, zerolog.Nop())
	time.Sleep(10 * time.Millisecond)

	resp := standby.HandlePromote(context.Background(), PromoteRequest{
		Symbols: []string{"BTCUSD"},
		Epoch:   1,
	})
	if resp.Accepted {
		t.Fatal("expected reject for stale book")
	}
	if standby.CanSign("BTCUSD") {
		t.Fatal("standby must not sign on rejected promote")
	}
}

func TestController_demoteDisablesStandbySigning(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	standby := NewController(testSettings(false, true), store, time.Second, []bbo.Key{key}, zerolog.Nop())
	_ = standby.HandlePromote(context.Background(), PromoteRequest{Symbols: []string{"BTCUSD"}, Epoch: 2})
	if !standby.CanSign("BTCUSD") {
		t.Fatal("precondition: standby signing")
	}

	resp := standby.HandleDemote(context.Background(), DemoteRequest{Symbols: []string{"BTCUSD"}, Epoch: 2})
	if !resp.Accepted {
		t.Fatalf("demote rejected: %+v", resp)
	}
	if standby.CanSign("BTCUSD") {
		t.Fatal("standby should stop signing after demote")
	}
}

func TestController_duplicatePromoteIdempotent(t *testing.T) {
	t.Parallel()
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	standby := NewController(testSettings(false, true), store, time.Second, []bbo.Key{key}, zerolog.Nop())
	r1 := standby.HandlePromote(context.Background(), PromoteRequest{Symbols: []string{"BTCUSD"}, Epoch: 5})
	r2 := standby.HandlePromote(context.Background(), PromoteRequest{Symbols: []string{"BTCUSD"}, Epoch: 5})
	if !r1.Accepted || !r2.Accepted {
		t.Fatalf("duplicate promote should succeed: r1=%+v r2=%+v", r1, r2)
	}
}

func TestController_mutualExclusionOnHandoff(t *testing.T) {
	store := bbo.NewSnapshotStore()
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store.Update(key, "100", "102")

	standbyStore := bbo.NewSnapshotStore()
	standbyStore.Update(key, "100", "102")

	standby := NewController(testSettings(false, true), standbyStore, time.Second, []bbo.Key{key}, zerolog.Nop())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/failover/promote" {
			http.NotFound(w, r)
			return
		}
		var req PromoteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		resp := standby.HandlePromote(r.Context(), req)
		w.Header().Set("Content-Type", "application/json")
		if !resp.Accepted {
			w.WriteHeader(http.StatusConflict)
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	primaryCfg := testSettings(true, false)
	primaryCfg.PeerURL = srv.URL
	primary := NewController(primaryCfg, store, 20*time.Millisecond, []bbo.Key{key}, zerolog.Nop())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go primary.Run(ctx)

	for i := 0; i < 8; i++ {
		primary.OnBookMidTick("BTCUSD", 30*time.Millisecond, true)
		time.Sleep(15 * time.Millisecond)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		p := primary.CanSign("BTCUSD")
		s := standby.CanSign("BTCUSD")
		if p && s {
			t.Fatal("both nodes signing simultaneously")
		}
		if !p && s {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("expected primary delegated and standby signing")
}

// TestController_noDualSignOnPromoteCancelRace reproduces the split-brain race:
// the primary delegates and dispatches a promote, the standby promotes itself,
// and the primary's book recovers while the promote response is still in flight.
// The primary must NOT resume signing locally (that would dual-sign with the same
// key); it must recover via an explicit peer demote. With the old cancel-to-active
// (epoch--) path this failed with both nodes signing.
func TestController_noDualSignOnPromoteCancelRace(t *testing.T) {
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}

	standbyStore := bbo.NewSnapshotStore()
	standbyStore.Update(key, "100", "102")
	standby := NewController(testSettings(false, true), standbyStore, time.Second, []bbo.Key{key}, zerolog.Nop())

	promoteReceived := make(chan struct{}, 1)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/failover/promote" {
			http.NotFound(w, r)
			return
		}
		var req PromoteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		resp := standby.HandlePromote(r.Context(), req) // standby becomes active
		select {
		case promoteReceived <- struct{}{}:
		default:
		}
		<-release // hold the response so the promote is "in flight"
		w.Header().Set("Content-Type", "application/json")
		if !resp.Accepted {
			w.WriteHeader(http.StatusConflict)
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	primaryStore := bbo.NewSnapshotStore()
	primaryStore.Update(key, "100", "102")
	primaryCfg := testSettings(true, false)
	primaryCfg.PeerURL = srv.URL
	primaryCfg.PeerRequestTimeout = 2 * time.Second
	primary := NewController(primaryCfg, primaryStore, 50*time.Millisecond, []bbo.Key{key}, zerolog.Nop())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go primary.Run(ctx)

	// Drive the primary's book stale until it delegates and dispatches the promote.
	dispatched := false
	for i := 0; i < 400 && !dispatched; i++ {
		primary.OnBookMidTick("BTCUSD", 100*time.Millisecond, true)
		select {
		case <-promoteReceived:
			dispatched = true
		case <-time.After(5 * time.Millisecond):
		}
	}
	if !dispatched {
		close(release)
		t.Fatal("promote was never dispatched to the peer")
	}

	// The standby has now promoted and the promote response is held in flight.
	// Simulate the primary's own book recovering during the RTT (the cancel race).
	primary.OnBookMidTick("BTCUSD", 1*time.Millisecond, false)

	// Let the held promote response return.
	close(release)

	// Invariant: the two nodes must never both be able to sign the same symbol.
	deadline := time.Now().Add(1 * time.Second)
	sawStandbySign := false
	for time.Now().Before(deadline) {
		p := primary.CanSign("BTCUSD")
		s := standby.CanSign("BTCUSD")
		if p && s {
			t.Fatal("dual-sign: primary and standby both report can_sign for BTCUSD")
		}
		if s {
			sawStandbySign = true
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !sawStandbySign {
		t.Fatal("liveness: standby never signed after promote (neither node signing)")
	}
}

// leaseSettings is testSettings with fast lease timings for snappy tests.
func leaseSettings(primary, standby bool) Settings {
	s := testSettings(primary, standby)
	s.PeerRequestTimeout = 80 * time.Millisecond
	s.PromoteDebounce = 10 * time.Millisecond
	s.RecoverHysteresis = 20 * time.Millisecond
	s.LeaseTTL = 250 * time.Millisecond
	s.LeaseRenew = 50 * time.Millisecond
	s.ClockSkewMargin = 100 * time.Millisecond
	return s
}

func standbyHandler(t *testing.T, standby *Controller) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		var out any
		switch r.URL.Path {
		case "/internal/failover/promote":
			var req PromoteRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			out = standby.HandlePromote(r.Context(), req)
		case "/internal/failover/demote":
			var req DemoteRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			out = standby.HandleDemote(r.Context(), req)
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}
}

// Test 1: when the peer is unreachable (API erroring), a primary whose book
// recovers must still resume signing on its own via the lease-expiry deadline,
// rather than getting stuck retrying a dead peer forever.
func TestController_resumesWhenPeerUnreachable(t *testing.T) {
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store := bbo.NewSnapshotStore()
	store.Update(key, "100", "102")

	// Peer always fails (HTTP 500) — simulates the fallback node down / API erroring.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	cfg := leaseSettings(true, false)
	cfg.PeerURL = srv.URL
	primary := NewController(cfg, store, 40*time.Millisecond, []bbo.Key{key}, zerolog.Nop())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go primary.Run(ctx)

	// Book goes stale -> primary delegates and stops signing (peer is unreachable).
	for i := 0; i < 6; i++ {
		primary.OnBookMidTick("BTCUSD", 100*time.Millisecond, true)
		time.Sleep(10 * time.Millisecond)
	}
	if primary.CanSign("BTCUSD") {
		t.Fatal("primary should have stopped signing while its book was stale")
	}

	// Book recovers. The primary must resume on its own even though it can never
	// reach the peer to demote.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		store.Update(key, "100", "102") // keep the book fresh
		primary.OnBookMidTick("BTCUSD", 1*time.Millisecond, false)
		if primary.CanSign("BTCUSD") {
			return // resumed — success
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("primary never resumed signing after book recovered with peer unreachable (stuck)")
}

// Test 2: with a reachable peer, recovery uses the fast demote path and resumes
// well before the lease would expire, and the standby stands down.
func TestController_fastResumeWhenPeerReachable(t *testing.T) {
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	standbyStore := bbo.NewSnapshotStore()
	standbyStore.Update(key, "100", "102")
	standby := NewController(leaseSettings(false, true), standbyStore, time.Second, []bbo.Key{key}, zerolog.Nop())

	srv := httptest.NewServer(standbyHandler(t, standby))
	defer srv.Close()

	primaryStore := bbo.NewSnapshotStore()
	primaryStore.Update(key, "100", "102")
	cfg := leaseSettings(true, false)
	cfg.PeerURL = srv.URL
	primary := NewController(cfg, primaryStore, 40*time.Millisecond, []bbo.Key{key}, zerolog.Nop())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go primary.Run(ctx)

	// Drive primary book stale until the standby is signing and the primary is not.
	handoff := time.Now().Add(2 * time.Second)
	for time.Now().Before(handoff) {
		primary.OnBookMidTick("BTCUSD", 100*time.Millisecond, true)
		if !primary.CanSign("BTCUSD") && standby.CanSign("BTCUSD") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if primary.CanSign("BTCUSD") || !standby.CanSign("BTCUSD") {
		t.Fatal("handoff did not complete: expected standby signing and primary not")
	}

	// Book recovers; with a reachable peer the primary resumes via the demote fast
	// path, well under the lease TTL.
	start := time.Now()
	resumeBy := start.Add(2 * time.Second)
	for time.Now().Before(resumeBy) {
		primaryStore.Update(key, "100", "102")
		primary.OnBookMidTick("BTCUSD", 1*time.Millisecond, false)
		if primary.CanSign("BTCUSD") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	elapsed := time.Since(start)
	if !primary.CanSign("BTCUSD") {
		t.Fatal("primary did not resume after book recovery with a reachable peer")
	}
	if elapsed >= cfg.LeaseTTL {
		t.Fatalf("resume took %v; expected fast demote path under lease TTL %v", elapsed, cfg.LeaseTTL)
	}
	if standby.CanSign("BTCUSD") {
		t.Fatal("standby still signing after the primary reclaimed (dual-sign)")
	}
}

// Test 3: a delegated standby stops signing on its own once its lease lapses
// without renewal (so a partitioned/abandoned standby never signs indefinitely).
func TestController_standbyLeaseExpiresWithoutRenewal(t *testing.T) {
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}
	store := bbo.NewSnapshotStore()
	store.Update(key, "100", "102")
	cfg := leaseSettings(false, true)
	standby := NewController(cfg, store, time.Second, []bbo.Key{key}, zerolog.Nop())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go standby.Run(ctx)

	resp := standby.HandlePromote(context.Background(), PromoteRequest{Symbols: []string{"BTCUSD"}, Epoch: 1})
	if !resp.Accepted || !standby.CanSign("BTCUSD") {
		t.Fatalf("standby should sign immediately after promote: %+v", resp)
	}

	deadline := time.Now().Add(cfg.LeaseTTL + 500*time.Millisecond)
	for time.Now().Before(deadline) {
		if !standby.CanSign("BTCUSD") {
			return // lease lapsed — success
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("standby kept signing after its lease should have expired")
}

// Test 4: when both books are stale, neither node signs; the standby takes over
// only once its own book recovers (while the primary's stays stale).
func TestController_bothBooksStaleNeitherSigns(t *testing.T) {
	key := bbo.Key{Provider: "coinbase", Symbol: "BTCUSD"}

	standbyStore := bbo.NewSnapshotStore() // not yet fresh
	standby := NewController(leaseSettings(false, true), standbyStore, 30*time.Millisecond, []bbo.Key{key}, zerolog.Nop())

	srv := httptest.NewServer(standbyHandler(t, standby))
	defer srv.Close()

	primaryStore := bbo.NewSnapshotStore() // never fresh -> primary book stale throughout
	cfg := leaseSettings(true, false)
	cfg.PeerURL = srv.URL
	primary := NewController(cfg, primaryStore, 30*time.Millisecond, []bbo.Key{key}, zerolog.Nop())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go primary.Run(ctx)

	// Primary book stale -> it delegates; standby book also stale -> promote rejected.
	for i := 0; i < 15; i++ {
		primary.OnBookMidTick("BTCUSD", 100*time.Millisecond, true)
		time.Sleep(10 * time.Millisecond)
	}
	if primary.CanSign("BTCUSD") {
		t.Fatal("primary must not sign with a stale book")
	}
	if standby.CanSign("BTCUSD") {
		t.Fatal("standby must not sign while its own book is stale (promote should be rejected)")
	}

	// Standby's book recovers (primary's stays stale) -> standby takes over.
	deadline := time.Now().Add(2 * time.Second)
	took := false
	for time.Now().Before(deadline) {
		standbyStore.Update(key, "100", "102") // keep standby book fresh
		primary.OnBookMidTick("BTCUSD", 100*time.Millisecond, true)
		if standby.CanSign("BTCUSD") {
			took = true
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if !took {
		t.Fatal("standby did not take over after its book recovered")
	}
	if primary.CanSign("BTCUSD") {
		t.Fatal("primary signing despite a still-stale book")
	}
}
