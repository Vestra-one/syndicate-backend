package provider

// Wire types for the Coinbase Advanced Trade WebSocket feed.
//
// REF: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels
//
// The envelope is:
//   {
//     "channel": "l2_data" | "heartbeats" | "subscriptions" | ...,
//     "sequence_num": <int>,
//     "timestamp": "...",
//     "events": [ {...}, ... ]
//   }

// CoinbaseAdvancedSubscribe is the subscribe wire message. One channel per
// message; `product_ids` is required for market-data channels.
type CoinbaseAdvancedSubscribe struct {
	Type       string   `json:"type"`
	Channel    string   `json:"channel"`
	ProductIDs []string `json:"product_ids,omitempty"`
}

// CoinbaseAdvancedFrame is the common envelope received over the wire.
type CoinbaseAdvancedFrame struct {
	Channel     string          `json:"channel"`
	SequenceNum int64           `json:"sequence_num"`
	Timestamp   string          `json:"timestamp"`
	Events      []CoinbaseAdvancedEvent `json:"events"`
}

// CoinbaseAdvancedEvent is one event inside a frame. For `l2_data` frames,
// Type is "snapshot" or "update" and Updates contains the L2 deltas.
type CoinbaseAdvancedEvent struct {
	Type      string          `json:"type"`
	ProductID string          `json:"product_id"`
	Updates   []CoinbaseAdvancedL2Update `json:"updates"`
}

// CoinbaseAdvancedL2Update mirrors one entry from the `updates` array of an
// `l2_data` event.
type CoinbaseAdvancedL2Update struct {
	Side        string `json:"side"`         // "bid" or "offer"
	PriceLevel  string `json:"price_level"`
	NewQuantity string `json:"new_quantity"` // absolute size; "0" deletes
	EventTime   string `json:"event_time"`
}
