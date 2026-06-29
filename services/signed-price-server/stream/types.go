package stream

import (
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
	"github.com/syndicate/backend/services/signed-price-server/signing"
)

// SendAllSymbol is the sentinel symbol stored when the client has no filter (send all).
// Empty symbol list means send nothing.
const SendAllSymbol = "SENDALL!@#"

// Client represents a WebSocket client connection
type Client struct {
	ID        string
	Conn      *websocket.Conn
	Symbols   atomic.Value // map[string]bool; SendAllSymbol key = send all, empty map = send none
	SendCh    chan []byte  // Pre-encoded JSON bytes for zero-copy
	CloseCh   chan struct{}
	connected atomic.Bool

	// pendingLatest holds the newest message per symbol when SendCh is full (coalesce-to-latest).
	pendingLatest sync.Map // map[string][]byte
}

// Subscription semantics for Client.Symbols (map[string]bool):
//   - map containing SendAllSymbol: send all (no filter)
//   - empty map: send nothing (empty symbol list / unsubscribed from all)
//   - non-empty map without SendAllSymbol: send only symbols present in the map
//
// ShouldSend reports whether this client should receive the given price.
func (c *Client) ShouldSend(price signing.SignedPrice) bool {
	v := c.Symbols.Load()
	if v == nil {
		return false
	}
	symbolMap := v.(map[string]bool)
	if len(symbolMap) == 0 {
		return false // Empty list = don't send anything
	}
	if symbolMap[SendAllSymbol] {
		return true // Send all
	}
	_, ok := symbolMap[price.Symbol]
	return ok
}

// EnqueuePrice delivers jsonBytes to the client, coalescing to latest per symbol on backpressure.
func (c *Client) EnqueuePrice(symbol string, jsonBytes []byte) (sent bool, coalesced bool) {
	if !c.connected.Load() {
		return false, false
	}
	select {
	case c.SendCh <- jsonBytes:
		return true, false
	default:
		c.pendingLatest.Store(symbol, jsonBytes)
		// Drop one queued message to make room for fresher data.
		select {
		case <-c.SendCh:
			select {
			case c.SendCh <- jsonBytes:
				c.pendingLatest.Delete(symbol)
				return true, true
			default:
				return false, true
			}
		default:
			return false, true
		}
	}
}

// FlushPending sends one coalesced pending message if any.
func (c *Client) FlushPending() {
	if !c.connected.Load() {
		return
	}
	c.pendingLatest.Range(func(key, value interface{}) bool {
		symbol := key.(string)
		b := value.([]byte)
		select {
		case c.SendCh <- b:
			c.pendingLatest.Delete(symbol)
		default:
		}
		return true
	})
}

// Close closes the client connection
func (c *Client) Close() {
	// Use atomic CAS to ensure we only close once
	if c.connected.CompareAndSwap(true, false) {
		close(c.CloseCh)
		if c.Conn != nil {
			c.Conn.Close()
		}
	}
}

// SubscriptionMessage represents a client subscription request
type SubscriptionMessage struct {
	Action  string   `json:"action"`  // "subscribe" or "unsubscribe"
	Symbols []string `json:"symbols"` // List of symbols to subscribe to
}
