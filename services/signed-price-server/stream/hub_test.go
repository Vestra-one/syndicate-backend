package stream

import (
	"context"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// recvWithin reads one message from the client's SendCh within d, failing the
// test on timeout.
func recvWithin(t *testing.T, c *Client, d time.Duration) []byte {
	t.Helper()
	select {
	case b, ok := <-c.SendCh:
		if !ok {
			t.Fatal("SendCh closed unexpectedly")
		}
		return b
	case <-time.After(d):
		t.Fatal("timed out waiting for message")
		return nil
	}
}

// mustNotRecv asserts no message arrives on SendCh within d.
func mustNotRecv(t *testing.T, c *Client, d time.Duration) {
	t.Helper()
	select {
	case b, ok := <-c.SendCh:
		if ok {
			t.Fatalf("unexpected message delivered: %s", b)
		}
	case <-time.After(d):
	}
}

func newTestHub(t *testing.T) *Hub {
	t.Helper()
	hub := NewHub(context.Background(), 1024, 0, 16, zerolog.Nop())
	hub.Start()
	t.Cleanup(hub.Stop)
	return hub
}

// TestHub_SymbolIndexFanout verifies 2.1/2.2: a broadcast reaches only the
// clients subscribed to that symbol plus send-all clients, and never others.
func TestHub_SymbolIndexFanout(t *testing.T) {
	hub := newTestHub(t)

	btc := NewClient(nil, []string{"BTCUSD"}, 8)
	eth := NewClient(nil, []string{"ETHUSD"}, 8)
	all := NewClient(nil, nil, 8) // no filter => send all

	for _, c := range []*Client{btc, eth, all} {
		if !hub.Register(c) {
			t.Fatalf("register %s failed", c.ID)
		}
	}

	data := []byte(`{"symbol":"BTCUSD","price":"100"}`)
	hub.Broadcast("BTCUSD", data)

	if got := recvWithin(t, btc, time.Second); string(got) != string(data) {
		t.Fatalf("btc got %s, want %s", got, data)
	}
	if got := recvWithin(t, all, time.Second); string(got) != string(data) {
		t.Fatalf("all got %s, want %s", got, data)
	}
	mustNotRecv(t, eth, 50*time.Millisecond)
}

// TestHub_SubscriptionUpdateReindexes verifies the symbol index is maintained
// when a client changes its subscription.
func TestHub_SubscriptionUpdateReindexes(t *testing.T) {
	hub := newTestHub(t)

	c := NewClient(nil, []string{"ETHUSD"}, 8)
	if !hub.Register(c) {
		t.Fatal("register failed")
	}

	// Initially not subscribed to BTCUSD.
	hub.Broadcast("BTCUSD", []byte(`{"symbol":"BTCUSD"}`))
	mustNotRecv(t, c, 50*time.Millisecond)

	// Re-subscribe to BTCUSD; allow the async subUpdate to drain.
	hub.updateSubscription(c, []string{"BTCUSD"})
	time.Sleep(30 * time.Millisecond)

	data := []byte(`{"symbol":"BTCUSD","price":"2"}`)
	hub.Broadcast("BTCUSD", data)
	if got := recvWithin(t, c, time.Second); string(got) != string(data) {
		t.Fatalf("after resubscribe got %s, want %s", got, data)
	}

	// Old subscription must no longer deliver.
	hub.Broadcast("ETHUSD", []byte(`{"symbol":"ETHUSD"}`))
	mustNotRecv(t, c, 50*time.Millisecond)
}

// TestHub_UnregisterRemovesFromIndex verifies an unregistered client no longer
// receives broadcasts (its SendCh is closed).
func TestHub_UnregisterRemovesFromIndex(t *testing.T) {
	hub := newTestHub(t)

	c := NewClient(nil, []string{"BTCUSD"}, 8)
	if !hub.Register(c) {
		t.Fatal("register failed")
	}
	hub.Unregister(c)
	time.Sleep(30 * time.Millisecond)

	hub.Broadcast("BTCUSD", []byte(`{"symbol":"BTCUSD"}`))
	// SendCh was closed on unregister; a receive returns ok=false promptly.
	select {
	case _, ok := <-c.SendCh:
		if ok {
			t.Fatal("expected no live message after unregister")
		}
	case <-time.After(time.Second):
		t.Fatal("expected SendCh to be closed after unregister")
	}
}

// TestHub_CapacityLimit verifies the global connection cap is enforced across
// shards.
func TestHub_CapacityLimit(t *testing.T) {
	hub := NewHub(context.Background(), 16, 1, 16, zerolog.Nop())
	hub.Start()
	t.Cleanup(hub.Stop)

	if !hub.Register(NewClient(nil, nil, 4)) {
		t.Fatal("first client should be accepted")
	}
	if hub.Register(NewClient(nil, nil, 4)) {
		t.Fatal("second client should be rejected at max_connections=1")
	}
}
