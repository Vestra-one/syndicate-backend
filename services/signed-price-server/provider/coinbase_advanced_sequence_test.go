package provider

import (
	"io"
	"net/url"
	"testing"

	"github.com/rs/zerolog"
)

func testCoinbaseProvider(t *testing.T) *CoinbaseProvider {
	t.Helper()
	return &CoinbaseProvider{
		logger: zerolog.New(io.Discard),
	}
}

func TestCheckAdvancedSequence_FirstFrameSetsBaseline(t *testing.T) {
	p := testCoinbaseProvider(t)
	conn := &WebsocketConnection{}
	frame := CoinbaseAdvancedFrame{Channel: "subscriptions", SequenceNum: 0}

	if !p.checkAdvancedSequence(frame, conn) {
		t.Fatal("expected first frame to be accepted")
	}
	if got := conn.lastSequence.Load(); got != 0 {
		t.Fatalf("expected lastSequence 0, got %d", got)
	}
}

func TestCheckAdvancedSequence_StrictIncrement(t *testing.T) {
	p := testCoinbaseProvider(t)
	conn := &WebsocketConnection{}
	conn.lastSequence.Store(3)
	conn.seqInitialized.Store(true)

	if !p.checkAdvancedSequence(CoinbaseAdvancedFrame{Channel: "heartbeats", SequenceNum: 4}, conn) {
		t.Fatal("expected seq 4 after 3")
	}
	if got := conn.lastSequence.Load(); got != 4 {
		t.Fatalf("expected lastSequence 4, got %d", got)
	}
}

func TestCheckAdvancedSequence_DuplicateIgnored(t *testing.T) {
	p := testCoinbaseProvider(t)
	conn := &WebsocketConnection{}
	conn.lastSequence.Store(5)
	conn.seqInitialized.Store(true)

	if p.checkAdvancedSequence(CoinbaseAdvancedFrame{Channel: "heartbeats", SequenceNum: 5}, conn) {
		t.Fatal("expected duplicate frame to be rejected without reconnect")
	}
	if got := conn.lastSequence.Load(); got != 5 {
		t.Fatalf("expected lastSequence unchanged at 5, got %d", got)
	}
}

// TestCheckAdvancedSequence_GapAcrossFirstFrames covers the sentinel bug fixed
// in 1.4: a gap across the very first frames (seq 0 -> 2) must be detected. The
// old `last == 0` sentinel mistook the baseline-0 for "uninitialized" and
// silently accepted seq 2.
func TestCheckAdvancedSequence_GapAcrossFirstFrames(t *testing.T) {
	p := testCoinbaseProvider(t)
	conn := &WebsocketConnection{}

	// First frame establishes baseline at 0 (a legitimate sequence value).
	if !p.checkAdvancedSequence(CoinbaseAdvancedFrame{Channel: "l2_data", SequenceNum: 0}, conn) {
		t.Fatal("expected first frame (seq 0) to be accepted as baseline")
	}
	if !conn.seqInitialized.Load() {
		t.Fatal("expected connection marked initialized after first frame")
	}

	// seq 0 -> 2 is a gap (missing seq 1): must be rejected and force a reconnect.
	if p.checkAdvancedSequence(CoinbaseAdvancedFrame{Channel: "l2_data", SequenceNum: 2}, conn) {
		t.Fatal("expected seq 0 -> 2 gap to be rejected")
	}
	// ForceReconnect resets the sentinel so the next snapshot rebuilds the book.
	if conn.seqInitialized.Load() {
		t.Fatal("expected seqInitialized reset to false after gap-forced reconnect")
	}
}

func TestCheckAdvancedSequence_IndependentPerConnection(t *testing.T) {
	p := testCoinbaseProvider(t)
	connA := &WebsocketConnection{}
	connB := &WebsocketConnection{}

	if !p.checkAdvancedSequence(CoinbaseAdvancedFrame{Channel: "heartbeats", SequenceNum: 0}, connA) {
		t.Fatal("connA baseline failed")
	}
	for i := int64(1); i <= 10; i++ {
		if !p.checkAdvancedSequence(CoinbaseAdvancedFrame{Channel: "heartbeats", SequenceNum: i}, connA) {
			t.Fatalf("connA seq %d failed", i)
		}
	}

	// connB starts its own sequence at 0 — must not conflict with connA at 10.
	if !p.checkAdvancedSequence(CoinbaseAdvancedFrame{Channel: "l2_data", SequenceNum: 0}, connB) {
		t.Fatal("connB baseline failed; sequences must be per-connection")
	}
	if got := connA.lastSequence.Load(); got != 10 {
		t.Fatalf("connA lastSequence=%d, want 10", got)
	}
	if got := connB.lastSequence.Load(); got != 0 {
		t.Fatalf("connB lastSequence=%d, want 0", got)
	}
}

func TestNewWebsocketController_SingleConnectionForMultipleSubs(t *testing.T) {
	msgs := []interface{}{
		map[string]string{"channel": "level2"},
		map[string]string{"channel": "heartbeats"},
	}
	wsc := NewWebsocketController(
		t.Context(),
		ProviderCoinbase,
		mustURL(t, "wss://advanced-trade-ws.coinbase.com"),
		msgs,
		func(int, *WebsocketConnection, []byte) {},
		disabledPingDuration,
		0,
		zerolog.New(io.Discard),
	)
	if len(wsc.connections) != 1 {
		t.Fatalf("expected 1 connection for %d subscription msgs, got %d", len(msgs), len(wsc.connections))
	}
	if len(wsc.connections[0].subscriptionMsgs) != 2 {
		t.Fatalf("expected 2 subscription msgs on connection, got %d", len(wsc.connections[0].subscriptionMsgs))
	}
}

func mustURL(t *testing.T, raw string) url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return *u
}
