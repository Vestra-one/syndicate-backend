//go:build ignore

// Wire-smoke for the Coinbase Advanced Trade `level2` channel.
//
// Subscribes directly to wss://advanced-trade-ws.coinbase.com for the given
// product, applies snapshot + update frames into a local CoinbaseBookStore-like
// structure, and prints the best bid / best ask once per second. Intended to
// confirm the wire format is parsed correctly and that the BBO updates faster
// than once per Coinbase trade.
//
// Usage:
//
//	go run ./scripts/coinbase_l2_smoke.go \
//	  --product BTC-USD \
//	  --duration 60s
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type l2Update struct {
	Side        string `json:"side"`
	PriceLevel  string `json:"price_level"`
	NewQuantity string `json:"new_quantity"`
	EventTime   string `json:"event_time"`
}

type l2Event struct {
	Type      string     `json:"type"`
	ProductID string     `json:"product_id"`
	Updates   []l2Update `json:"updates"`
}

type frame struct {
	Channel     string    `json:"channel"`
	SequenceNum int64     `json:"sequence_num"`
	Events      []l2Event `json:"events"`
}

// book holds bid/ask price levels as sorted slices. This is intentionally
// minimal: the production code uses a btree, but for a 60s smoke test on a
// single product, sorted slices are sufficient and dependency-free.
type book struct {
	mu   sync.Mutex
	bids map[string]string // price -> size
	asks map[string]string
}

func (b *book) apply(u l2Update) {
	b.mu.Lock()
	defer b.mu.Unlock()
	target := b.asks
	if u.Side == "bid" {
		target = b.bids
	}
	sz, err := strconv.ParseFloat(u.NewQuantity, 64)
	if err != nil || sz <= 0 {
		delete(target, u.PriceLevel)
		return
	}
	target[u.PriceLevel] = u.NewQuantity
}

func (b *book) reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.bids = map[string]string{}
	b.asks = map[string]string{}
}

func (b *book) bbo() (bid, ask string, bidF, askF float64, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.bids) == 0 || len(b.asks) == 0 {
		return "", "", 0, 0, false
	}
	bidF = -1
	for k := range b.bids {
		v, _ := strconv.ParseFloat(k, 64)
		if v > bidF {
			bidF = v
			bid = k
		}
	}
	askF = -1
	first := true
	for k := range b.asks {
		v, _ := strconv.ParseFloat(k, 64)
		if first || v < askF {
			askF = v
			ask = k
			first = false
		}
	}
	return bid, ask, bidF, askF, true
}

func (b *book) depth() (bids, asks int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.bids), len(b.asks)
}

func main() {
	product := flag.String("product", "BTC-USD", "Coinbase product id (e.g. BTC-USD)")
	dur := flag.Duration("duration", 60*time.Second, "how long to run")
	flag.Parse()

	u := url.URL{Scheme: "wss", Host: "advanced-trade-ws.coinbase.com", Path: "/"}
	dialer := *websocket.DefaultDialer
	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dial:", err)
		os.Exit(1)
	}
	defer conn.Close()

	subscribe := func(channel string) error {
		msg := map[string]any{"type": "subscribe", "channel": channel, "product_ids": []string{*product}}
		return conn.WriteJSON(msg)
	}
	if err := subscribe("level2"); err != nil {
		fmt.Fprintln(os.Stderr, "subscribe level2:", err)
		os.Exit(1)
	}
	if err := subscribe("heartbeats"); err != nil {
		fmt.Fprintln(os.Stderr, "subscribe heartbeats:", err)
		os.Exit(1)
	}

	b := &book{bids: map[string]string{}, asks: map[string]string{}}
	deadline := time.Now().Add(*dur)
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	var (
		snapshotCount int64
		updateCount   int64
		updateEntries int64
		lastSeq       int64
		gapCount      int64
	)

	go func() {
		for range ticker.C {
			bid, ask, bidF, askF, ok := b.bbo()
			bids, asks := b.depth()
			if !ok {
				fmt.Println("BBO: not ready", "depth", bids, "/", asks)
				continue
			}
			fmt.Printf("BBO bid=%s ask=%s spread=%.4f depth=%d/%d snapshots=%d updates=%d entries=%d gaps=%d\n",
				bid, ask, askF-bidF, bids, asks, snapshotCount, updateCount, updateEntries, gapCount)
		}
	}()

	conn.SetReadDeadline(deadline.Add(2 * time.Second))
	for time.Now().Before(deadline) {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			fmt.Fprintln(os.Stderr, "read:", err)
			break
		}
		var f frame
		if err := json.Unmarshal(raw, &f); err != nil {
			continue
		}
		// sequence_num is per-connection across ALL channels, not per-channel.
		if lastSeq != 0 && f.SequenceNum != lastSeq+1 {
			gapCount++
		}
		lastSeq = f.SequenceNum
		if f.Channel == "l2_data" {
			for _, ev := range f.Events {
				if ev.ProductID != *product {
					continue
				}
				if ev.Type == "snapshot" {
					b.reset()
					for _, u := range ev.Updates {
						b.apply(u)
					}
					snapshotCount++
				} else if ev.Type == "update" {
					for _, u := range ev.Updates {
						b.apply(u)
					}
					updateCount++
					updateEntries += int64(len(ev.Updates))
				}
			}
		}
	}

	// Final summary
	bid, ask, bidF, askF, ok := b.bbo()
	bids, asks := b.depth()
	fmt.Println("--- summary ---")
	fmt.Printf("snapshots=%d update_frames=%d update_entries=%d sequence_gaps=%d\n", snapshotCount, updateCount, updateEntries, gapCount)
	if ok {
		fmt.Printf("final BBO bid=%s ask=%s spread=%.4f depth=%d/%d\n", bid, ask, askF-bidF, bids, asks)
	}
	// Sort just to demonstrate book is valid
	keys := make([]string, 0, len(b.bids))
	for k := range b.bids {
		keys = append(keys, k)
	}
	sort.Strings(keys)
}
