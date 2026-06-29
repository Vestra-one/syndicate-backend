// Capture signed prices from trade vs book_mid servers for side-by-side comparison.
//
// Usage:
//
//	go run ./scripts/capture_feed_comparison.go --duration 120s
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
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
	Meta      *struct {
		Bid string `json:"bid"`
		Ask string `json:"ask"`
	} `json:"meta,omitempty"`
}

type priceRow struct {
	SignedAt  int64
	Timestamp int64
	Price     string
	TradeID   int64
	Bid       string
	Ask       string
}

type streamKey struct {
	mode   string // "trade" or "mid"
	symbol string
}

func main() {
	tradeWS := flag.String("trade-url", "ws://127.0.0.1:18080/ws", "last_trade server WebSocket base URL")
	midWS := flag.String("mid-url", "ws://127.0.0.1:18081/ws", "book_mid server WebSocket base URL")
	durationStr := flag.String("duration", "120s", "capture duration")
	symbolsStr := flag.String("symbols", "BTCUSD,ETHUSD,USDCUSD", "comma-separated symbols")
	outDir := flag.String("out-dir", ".", "output directory for markdown files")
	fileSuffix := flag.String("file-suffix", "", "appended to output filenames (e.g. _coinbase)")
	healthTimeout := flag.Duration("health-timeout", 60*time.Second, "wait for both servers")
	flag.Parse()

	duration, err := time.ParseDuration(*durationStr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid duration: %v\n", err)
		os.Exit(1)
	}
	symbols := strings.Split(*symbolsStr, ",")
	for i := range symbols {
		symbols[i] = strings.TrimSpace(symbols[i])
	}

	tradeHealth := healthURL(*tradeWS)
	midHealth := healthURL(*midWS)
	if err := waitForServers(tradeHealth, midHealth, *healthTimeout); err != nil {
		fmt.Fprintf(os.Stderr, "servers not ready: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("both servers up, warming up 15s for provider feeds...")
	time.Sleep(15 * time.Second)
	if err := waitForBookMid(midHealth, 30*time.Second); err != nil {
		fmt.Fprintf(os.Stderr, "book_mid not ready: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("starting capture...")

	buffers := make(map[streamKey][]priceRow)
	var mu sync.Mutex

	captureStart := time.Now().UTC()
	deadline := captureStart.Add(duration)
	var wg sync.WaitGroup

	for _, sym := range symbols {
		for _, spec := range []struct {
			mode string
			base string
		}{
			{"trade", *tradeWS},
			{"mid", *midWS},
		} {
			wg.Add(1)
			go func(mode, base, sym string) {
				defer wg.Done()
				rows := captureStream(base, sym, deadline)
				mu.Lock()
				buffers[streamKey{mode, sym}] = rows
				mu.Unlock()
			}(spec.mode, spec.base, sym)
		}
	}
	wg.Wait()
	captureEnd := time.Now().UTC()

	var failed bool
	for _, sym := range symbols {
		for _, mode := range []string{"trade", "mid"} {
			key := streamKey{mode, sym}
			if len(buffers[key]) == 0 {
				fmt.Fprintf(os.Stderr, "no messages for %s %s\n", mode, sym)
				failed = true
			}
		}
	}

	for _, sym := range symbols {
		if err := writeMarkdown(*outDir, *fileSuffix, "trade", sym, *tradeWS, captureStart, captureEnd, buffers[streamKey{"trade", sym}]); err != nil {
			fmt.Fprintf(os.Stderr, "write trade %s: %v\n", sym, err)
			failed = true
		}
		if err := writeMarkdown(*outDir, *fileSuffix, "mid", sym, *midWS, captureStart, captureEnd, buffers[streamKey{"mid", sym}]); err != nil {
			fmt.Fprintf(os.Stderr, "write mid %s: %v\n", sym, err)
			failed = true
		}
	}

	if failed {
		os.Exit(1)
	}
	fmt.Println("capture complete")
}

func healthURL(wsBase string) string {
	u, err := url.Parse(wsBase)
	if err != nil {
		return "http://127.0.0.1:8080/health"
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "80"
	}
	return fmt.Sprintf("http://%s:%s/health", host, port)
}

func waitForServers(tradeHealth, midHealth string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		if serverResponding(client, tradeHealth) && serverResponding(client, midHealth) {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for servers (trade=%s mid=%s)", tradeHealth, midHealth)
}

// serverResponding is true when the HTTP server answers /health (ok may be false before WS clients connect).
func serverResponding(client *http.Client, healthURL string) bool {
	resp, err := client.Get(healthURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var body struct {
		Service string `json:"service"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false
	}
	return body.Service != ""
}

func waitForBookMid(midHealth string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(midHealth)
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		var body struct {
			BookMidOK *bool `json:"book_mid_ok"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if body.BookMidOK != nil && *body.BookMidOK {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("book_mid_ok not true at %s", midHealth)
}

func captureStream(wsBase, symbol string, deadline time.Time) []priceRow {
	u := wsBase + "?symbols=" + url.QueryEscape(symbol)
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(u, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "dial %s: %v\n", u, err)
		return nil
	}
	defer conn.Close()

	var rows []priceRow
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline)
		_, bz, err := conn.ReadMessage()
		if err != nil {
			if time.Now().Before(deadline) {
				fmt.Fprintf(os.Stderr, "read %s: %v\n", u, err)
			}
			break
		}
		var msg signedPriceMsg
		if err := json.Unmarshal(bz, &msg); err != nil {
			continue
		}
		if msg.Price == "" || msg.Symbol == "" {
			continue
		}
		if msg.Symbol != symbol {
			continue
		}
		row := priceRow{
			SignedAt:  msg.SignedAt,
			Timestamp: msg.Timestamp,
			Price:     msg.Price,
			TradeID:   msg.TradeID,
		}
		if msg.Meta != nil {
			row.Bid = msg.Meta.Bid
			row.Ask = msg.Meta.Ask
		}
		rows = append(rows, row)
	}
	return rows
}

func writeMarkdown(outDir, fileSuffix, mode, symbol, wsBase string, start, end time.Time, rows []priceRow) error {
	feedLabel := "Trade feed"
	prefix := "trade"
	if mode == "mid" {
		feedLabel = "Book mid feed"
		prefix = "mid_point"
	}
	asset := strings.TrimSuffix(symbol, "USD")
	name := fmt.Sprintf("%s_%s%s.md", prefix, strings.ToLower(asset), fileSuffix)
	path := filepath.Join(outDir, name)

	deltas := interArrivals(rows)
	stats := deltaStats(deltas)
	priceMin, priceMax, priceLast := priceRange(rows)

	var b strings.Builder
	fmt.Fprintf(&b, "# %s — %s (2 min capture)\n\n", feedLabel, symbol)
	fmt.Fprintf(&b, "- **Server:** %s?symbols=%s\n", wsBase, symbol)
	fmt.Fprintf(&b, "- **Capture start (UTC):** %s\n", start.Format(time.RFC3339Nano))
	fmt.Fprintf(&b, "- **Capture end (UTC):** %s\n", end.Format(time.RFC3339Nano))
	fmt.Fprintf(&b, "- **Message count:** %d\n", len(rows))
	fmt.Fprintf(&b, "- **Inter-arrival ms (signed_at):** min=%d p50=%d p95=%d max=%d\n", stats.min, stats.p50, stats.p95, stats.max)
	fmt.Fprintf(&b, "- **Price range:** min=%s max=%s last=%s\n\n", priceMin, priceMax, priceLast)
	hasMeta := mode == "mid" && anyBidAsk(rows)
	if hasMeta {
		b.WriteString("| signed_at_ms | timestamp | price | trade_id | bid | ask | delta_ms |\n")
		b.WriteString("|--------------|-----------|-------|----------|-----|-----|----------|\n")
	} else {
		b.WriteString("| signed_at_ms | timestamp | price | trade_id | delta_ms |\n")
		b.WriteString("|--------------|-----------|-------|----------|----------|\n")
	}
	for i, r := range rows {
		delta := ""
		if i > 0 && deltas[i-1] >= 0 {
			delta = strconv.FormatInt(deltas[i-1], 10)
		}
		if hasMeta {
			bid := r.Bid
			if bid == "" {
				bid = "-"
			}
			ask := r.Ask
			if ask == "" {
				ask = "-"
			}
			fmt.Fprintf(&b, "| %d | %d | %s | %d | %s | %s | %s |\n",
				r.SignedAt, r.Timestamp, r.Price, r.TradeID, bid, ask, delta)
		} else {
			fmt.Fprintf(&b, "| %d | %d | %s | %d | %s |\n",
				r.SignedAt, r.Timestamp, r.Price, r.TradeID, delta)
		}
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func anyBidAsk(rows []priceRow) bool {
	for _, r := range rows {
		if r.Bid != "" || r.Ask != "" {
			return true
		}
	}
	return false
}

func interArrivals(rows []priceRow) []int64 {
	if len(rows) < 2 {
		return nil
	}
	out := make([]int64, len(rows)-1)
	for i := 1; i < len(rows); i++ {
		out[i-1] = rows[i].SignedAt - rows[i-1].SignedAt
	}
	return out
}

type statBundle struct {
	min, p50, p95, max int64
}

func deltaStats(deltas []int64) statBundle {
	if len(deltas) == 0 {
		return statBundle{}
	}
	cp := append([]int64(nil), deltas...)
	sort.Slice(cp, func(i, j int) bool { return cp[i] < cp[j] })
	return statBundle{
		min:  cp[0],
		p50:  percentile(cp, 50),
		p95:  percentile(cp, 95),
		max:  cp[len(cp)-1],
	}
}

func percentile(sorted []int64, p int) int64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := (len(sorted)-1)*p/100
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func priceRange(rows []priceRow) (min, max, last string) {
	if len(rows) == 0 {
		return "-", "-", "-"
	}
	last = rows[len(rows)-1].Price
	minF, maxF := parseFloat(rows[0].Price), parseFloat(rows[0].Price)
	for _, r := range rows[1:] {
		v := parseFloat(r.Price)
		if v < minF {
			minF = v
		}
		if v > maxF {
			maxF = v
		}
	}
	return formatFloat(minF), formatFloat(maxF), last
}

func parseFloat(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

func formatFloat(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}
