//go:build ignore

// Capture Coinbase ticker events from the local price-bot WebSocket and emit a
// markdown report that quantifies the difference between consecutive exchange
// timestamps (event N+1 minus event N).
//
// Usage:
//
//	go run ./scripts/capture_coinbase_event_delta.go \
//	  --url ws://127.0.0.1:18090/ws \
//	  --symbol BTCUSD \
//	  --duration 120s \
//	  --out coinbase_trade_event_delta_btc.md
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type signedPriceMsg struct {
	Type      string `json:"type"`
	Symbol    string `json:"symbol"`
	Price     string `json:"price"`
	Timestamp int64  `json:"timestamp"`
	TradeID   int64  `json:"trade_id"`
	SignedAt  int64  `json:"signed_at"`
}

type event struct {
	Timestamp int64
	SignedAt  int64
	Price     string
	TradeID   int64
}

func main() {
	wsURL := flag.String("url", "ws://127.0.0.1:18090/ws", "price-bot WebSocket base URL")
	symbol := flag.String("symbol", "BTCUSD", "symbol to capture")
	durationStr := flag.String("duration", "120s", "capture duration")
	outPath := flag.String("out", "coinbase_trade_event_delta_btc.md", "output markdown path")
	flag.Parse()

	duration, err := time.ParseDuration(*durationStr)
	if err != nil {
		die("invalid duration: %v", err)
	}

	u := *wsURL + "?symbols=" + url.QueryEscape(*symbol)
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(u, nil)
	if err != nil {
		die("dial %s: %v", u, err)
	}
	defer conn.Close()

	captureStart := time.Now().UTC()
	deadline := captureStart.Add(duration)
	fmt.Printf("capturing %s from %s for %s\n", *symbol, u, duration)

	var events []event
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline)
		_, bz, err := conn.ReadMessage()
		if err != nil {
			if time.Now().Before(deadline) {
				fmt.Fprintf(os.Stderr, "read: %v\n", err)
			}
			break
		}
		var msg signedPriceMsg
		if err := json.Unmarshal(bz, &msg); err != nil {
			continue
		}
		if msg.Price == "" || msg.Symbol != *symbol {
			continue
		}
		events = append(events, event{
			Timestamp: msg.Timestamp,
			SignedAt:  msg.SignedAt,
			Price:     msg.Price,
			TradeID:   msg.TradeID,
		})
	}
	captureEnd := time.Now().UTC()
	fmt.Printf("captured %d events\n", len(events))

	if len(events) < 2 {
		die("need at least 2 events, got %d", len(events))
	}

	if err := writeReport(*outPath, *symbol, u, captureStart, captureEnd, events); err != nil {
		die("write report: %v", err)
	}
	fmt.Printf("wrote %s\n", *outPath)
}

type stats struct {
	count  int
	min    int64
	max    int64
	mean   float64
	stdev  float64
	p50    int64
	p90    int64
	p95    int64
	p99    int64
	zeroes int
	negs   int
}

func computeStats(values []int64) stats {
	if len(values) == 0 {
		return stats{}
	}
	sorted := make([]int64, len(values))
	copy(sorted, values)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	var sum int64
	var zeroes, negs int
	for _, v := range values {
		sum += v
		if v == 0 {
			zeroes++
		}
		if v < 0 {
			negs++
		}
	}
	mean := float64(sum) / float64(len(values))

	var sq float64
	for _, v := range values {
		d := float64(v) - mean
		sq += d * d
	}
	stdev := math.Sqrt(sq / float64(len(values)))

	pct := func(p float64) int64 {
		if len(sorted) == 0 {
			return 0
		}
		idx := int(math.Ceil(p*float64(len(sorted)))) - 1
		if idx < 0 {
			idx = 0
		}
		if idx >= len(sorted) {
			idx = len(sorted) - 1
		}
		return sorted[idx]
	}

	return stats{
		count:  len(values),
		min:    sorted[0],
		max:    sorted[len(sorted)-1],
		mean:   mean,
		stdev:  stdev,
		p50:    pct(0.50),
		p90:    pct(0.90),
		p95:    pct(0.95),
		p99:    pct(0.99),
		zeroes: zeroes,
		negs:   negs,
	}
}

type bucket struct {
	label string
	count int
}

func bucketize(values []int64) []bucket {
	buckets := []struct {
		label string
		lo    int64
		hi    int64 // inclusive
	}{
		{"<0 (out-of-order)", math.MinInt64, -1},
		{"0 (same-ms)", 0, 0},
		{"1-10", 1, 10},
		{"11-50", 11, 50},
		{"51-100", 51, 100},
		{"101-250", 101, 250},
		{"251-500", 251, 500},
		{"501-1000", 501, 1000},
		{"1001-5000", 1001, 5000},
		{">5000", 5001, math.MaxInt64},
	}
	out := make([]bucket, len(buckets))
	for i, b := range buckets {
		out[i].label = b.label
	}
	for _, v := range values {
		for i, b := range buckets {
			if v >= b.lo && v <= b.hi {
				out[i].count++
				break
			}
		}
	}
	return out
}

func writeReport(path, symbol, srvURL string, start, end time.Time, events []event) error {
	deltaTs := make([]int64, 0, len(events)-1)
	deltaSigned := make([]int64, 0, len(events)-1)
	e2eLat := make([]int64, 0, len(events))
	for i, e := range events {
		e2eLat = append(e2eLat, e.SignedAt-e.Timestamp)
		if i == 0 {
			continue
		}
		deltaTs = append(deltaTs, events[i].Timestamp-events[i-1].Timestamp)
		deltaSigned = append(deltaSigned, events[i].SignedAt-events[i-1].SignedAt)
	}

	dtsStats := computeStats(deltaTs)
	dsaStats := computeStats(deltaSigned)
	latStats := computeStats(e2eLat)
	buckets := bucketize(deltaTs)

	var b strings.Builder
	fmt.Fprintf(&b, "# Coinbase ticker event-delta — %s\n\n", symbol)
	fmt.Fprintf(&b, "Captured live from the local price-bot WebSocket. The Coinbase provider in this codebase subscribes to the `ticker` channel (see `provider/coinbase.go`); each ticker carries a `time` field that is parsed by `ParseCoinbaseTime` and stored as the exchange `timestamp` (ms). `delta_ts_ms` below is exactly that exchange `timestamp` for event N+1 minus event N.\n\n")
	fmt.Fprintf(&b, "## Capture metadata\n\n")
	fmt.Fprintf(&b, "- **Server URL:** %s\n", srvURL)
	fmt.Fprintf(&b, "- **Capture start (UTC):** %s\n", start.Format(time.RFC3339Nano))
	fmt.Fprintf(&b, "- **Capture end (UTC):** %s\n", end.Format(time.RFC3339Nano))
	fmt.Fprintf(&b, "- **Wall duration:** %s\n", end.Sub(start).Round(time.Millisecond))
	fmt.Fprintf(&b, "- **Event count:** %d\n", len(events))
	fmt.Fprintf(&b, "- **Pair count (deltas):** %d\n\n", len(deltaTs))

	fmt.Fprintf(&b, "## `delta_ts_ms` (exchange timestamp delta, event N+1 − event N)\n\n")
	writeStatsBlock(&b, dtsStats)

	fmt.Fprintf(&b, "\n### Distribution buckets\n\n")
	fmt.Fprintf(&b, "| bucket (ms) | count | %% |\n")
	fmt.Fprintf(&b, "|-------------|-------|----|\n")
	total := len(deltaTs)
	for _, bk := range buckets {
		pct := 0.0
		if total > 0 {
			pct = 100.0 * float64(bk.count) / float64(total)
		}
		fmt.Fprintf(&b, "| %s | %d | %.2f |\n", bk.label, bk.count, pct)
	}

	fmt.Fprintf(&b, "\n## Sanity columns\n\n")
	fmt.Fprintf(&b, "### `delta_signed_at_ms` (server inter-arrival)\n\n")
	writeStatsBlock(&b, dsaStats)

	fmt.Fprintf(&b, "\n### `e2e_latency_ms` (signed_at − timestamp, per event)\n\n")
	writeStatsBlock(&b, latStats)

	fmt.Fprintf(&b, "\n## Full per-pair table\n\n")
	b.WriteString("| idx | prev_ts_ms | curr_ts_ms | delta_ts_ms | delta_signed_at_ms | e2e_latency_ms | trade_id_prev | trade_id_curr | id_gap | price_prev | price_curr |\n")
	b.WriteString("|-----|------------|------------|-------------|---------------------|-----------------|----------------|----------------|--------|------------|------------|\n")
	for i := 1; i < len(events); i++ {
		prev := events[i-1]
		cur := events[i]
		dts := cur.Timestamp - prev.Timestamp
		dsa := cur.SignedAt - prev.SignedAt
		lat := cur.SignedAt - cur.Timestamp
		idGap := cur.TradeID - prev.TradeID
		fmt.Fprintf(&b, "| %d | %d | %d | %d | %d | %d | %d | %d | %d | %s | %s |\n",
			i, prev.Timestamp, cur.Timestamp, dts, dsa, lat,
			prev.TradeID, cur.TradeID, idGap, prev.Price, cur.Price)
	}

	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func writeStatsBlock(b *strings.Builder, s stats) {
	fmt.Fprintf(b, "- count: %d\n", s.count)
	fmt.Fprintf(b, "- min: %d ms\n", s.min)
	fmt.Fprintf(b, "- p50: %d ms\n", s.p50)
	fmt.Fprintf(b, "- p90: %d ms\n", s.p90)
	fmt.Fprintf(b, "- p95: %d ms\n", s.p95)
	fmt.Fprintf(b, "- p99: %d ms\n", s.p99)
	fmt.Fprintf(b, "- max: %d ms\n", s.max)
	fmt.Fprintf(b, "- mean: %s ms\n", strconv.FormatFloat(s.mean, 'f', 3, 64))
	fmt.Fprintf(b, "- stdev: %s ms\n", strconv.FormatFloat(s.stdev, 'f', 3, 64))
	fmt.Fprintf(b, "- zeros (=0 ms): %d\n", s.zeroes)
	fmt.Fprintf(b, "- negatives (<0 ms, out-of-order vs exchange timeline): %d\n", s.negs)
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
