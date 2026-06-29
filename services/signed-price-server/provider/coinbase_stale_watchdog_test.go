package provider

import (
	"io"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
)

// staleWatchdogProvider builds a CoinbaseProvider wired with a BBO store and a
// single clientless advanced connection. ForceReconnect on a nil client is a safe
// no-op that still resets the sequence sentinel, which the tests observe to tell
// whether a reconnect was triggered.
func staleWatchdogProvider(t *testing.T, keys ...bbo.Key) (*CoinbaseProvider, *WebsocketConnection) {
	t.Helper()
	store := bbo.NewSnapshotStore()
	wsc := NewWebsocketController(
		t.Context(),
		ProviderCoinbase,
		mustURL(t, "wss://advanced-trade-ws.coinbase.com"),
		[]interface{}{map[string]string{"channel": "level2"}},
		func(int, *WebsocketConnection, []byte) {},
		disabledPingDuration,
		0,
		zerolog.New(io.Discard),
	)
	p := &CoinbaseProvider{
		logger:                 zerolog.New(io.Discard),
		endpoints:              Endpoint{Name: ProviderCoinbase},
		bboStore:               store,
		wscAdvanced:            wsc,
		bookMidKeys:            keys,
		staleWatchdogInterval:  1 * time.Second,
		staleThreshold:         5 * time.Second,
		staleReconnectCooldown: 30 * time.Second,
	}
	return p, wsc.connections[0]
}

// reconnected reports whether ForceReconnect ran by checking the sentinel it
// resets. The caller arms the sentinel to true beforehand.
func reconnected(conn *WebsocketConnection) bool {
	return !conn.seqInitialized.Load()
}

func TestCheckStaleBooks_FreshBookNoReconnect(t *testing.T) {
	key := bbo.Key{Provider: string(ProviderCoinbase), Symbol: "ETHUSD"}
	p, conn := staleWatchdogProvider(t, key)
	p.bboStore.Update(key, "100", "101") // fresh as of now
	conn.seqInitialized.Store(true)

	p.checkStaleBooks()

	if reconnected(conn) {
		t.Fatal("expected no reconnect while book is fresh")
	}
}

func TestCheckStaleBooks_StaleBookForcesReconnect(t *testing.T) {
	key := bbo.Key{Provider: string(ProviderCoinbase), Symbol: "ETHUSD"}
	// Never updated => not fresh => treated as stale.
	p, conn := staleWatchdogProvider(t, key)
	conn.seqInitialized.Store(true)

	p.checkStaleBooks()

	if !reconnected(conn) {
		t.Fatal("expected reconnect when book is stale")
	}
}

func TestCheckStaleBooks_CooldownGatesReconnect(t *testing.T) {
	key := bbo.Key{Provider: string(ProviderCoinbase), Symbol: "ETHUSD"}
	p, conn := staleWatchdogProvider(t, key)

	// First stale check reconnects and records the time.
	conn.seqInitialized.Store(true)
	p.checkStaleBooks()
	if !reconnected(conn) {
		t.Fatal("expected first stale check to reconnect")
	}

	// Immediate second check is inside the cooldown window: no reconnect.
	conn.seqInitialized.Store(true)
	p.checkStaleBooks()
	if reconnected(conn) {
		t.Fatal("expected cooldown to gate the second reconnect")
	}
}
