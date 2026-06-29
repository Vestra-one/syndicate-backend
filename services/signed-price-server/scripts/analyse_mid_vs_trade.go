//go:build ignore

// Analyse mid_point vs trade signed-price markdown reports for the same symbol.
//
// Reads two markdown files written by scripts/capture_feed_comparison.go and
// classifies each maximal run of consecutive equal mid prices as EXPECTED
// (trade prints fully explain the locked mid) or ANOMALOUS.
//
// Usage:
//
//	go run ./scripts/analyse_mid_vs_trade.go \
//	  --mid mid_point_eth.md \
//	  --trade trade_eth.md \
//	  --symbol ETHUSD \
//	  --out difference_analysis_report.md
package main

import (
	"bufio"
	"flag"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
)

type row struct {
	signedAt int64
	priceStr string
	priceF   float64
	tradeID  int64
	bidStr   string
	askStr   string
	bidF     float64
	askF     float64
	hasBA    bool
}

type stuckRun struct {
	priceStr     string
	priceF       float64
	startMs      int64
	endMs        int64
	count        int
	bidStr       string
	askStr       string
	bidF         float64
	askF         float64
	hasBA        bool
	bidAskVaried bool
	tradeRows    []row
}

type classification struct {
	verdict   string
	mean      float64
	deltaUSD  float64
	deltaPPM  float64
	distinct  []string
	implied   string
	maxDevUSD float64
	tradeThru int
	anomalous int
	note      string
	mode      string // "exact" (bid/ask available) or "legacy" (tick-based)
}

// Legacy (no bid/ask in capture): one-tick + slack inference from trade prices alone.
const toleranceUSD = 1e-3
const tickUSD = 0.01

// Exact-mode tolerances when bid/ask are present.
//   - midEqualEps:    |(bid+ask)/2 - mid| must be within this for the mid equation to hold.
//   - tradeBoundEps:  trades must satisfy bid-eps <= t <= ask+eps to be classified as in-bounds.
//     The slack absorbs micro-USD drift in the USDC/USDT rate between trade and book_mid feeds.
const midEqualEps = 5e-6
const tradeBoundEps = 1e-3

func main() {
	midPath := flag.String("mid", "mid_point_eth.md", "mid_point markdown file")
	tradePath := flag.String("trade", "trade_eth.md", "trade markdown file")
	symbol := flag.String("symbol", "ETHUSD", "symbol label")
	outPath := flag.String("out", "difference_analysis_report.md", "output report path")
	minRunLen := flag.Int("min-run", 3, "minimum length (rows) to consider a stuck run")
	flag.Parse()

	midRows, midHeader, err := parseMarkdown(*midPath)
	if err != nil {
		die("read mid: %v", err)
	}
	tradeRows, tradeHeader, err := parseMarkdown(*tradePath)
	if err != nil {
		die("read trade: %v", err)
	}

	runs := findStuckRuns(midRows, *minRunLen)
	attachTrades(runs, tradeRows)

	classes := make([]classification, len(runs))
	expected := 0
	anomalous := 0
	noTrades := 0
	tradeThru := 0
	exactRuns := 0
	for i := range runs {
		classes[i] = classify(&runs[i])
		if classes[i].mode == "exact" {
			exactRuns++
		}
		switch classes[i].verdict {
		case "EXPECTED":
			expected++
			tradeThru += classes[i].tradeThru
		case "ANOMALOUS":
			anomalous++
		case "NO_TRADES":
			noTrades++
		}
	}

	report := renderReport(*symbol, *midPath, *tradePath, midHeader, tradeHeader,
		midRows, tradeRows, runs, classes, expected, anomalous, noTrades, tradeThru, exactRuns)
	if err := os.WriteFile(*outPath, []byte(report), 0o644); err != nil {
		die("write out: %v", err)
	}
	fmt.Printf("wrote %s (%d stuck runs >= %d ticks, %d EXPECTED [%d with trade-through], %d ANOMALOUS, %d NO_TRADES; exact-mode runs: %d)\n",
		*outPath, len(runs), *minRunLen, expected, tradeThru, anomalous, noTrades, exactRuns)
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

type header struct {
	startUTC   string
	endUTC     string
	msgCount   int
	interMin   string
	interP50   string
	interP95   string
	interMax   string
	priceMin   string
	priceMax   string
	priceLast  string
	rawLines   []string
}

func parseMarkdown(path string) ([]row, header, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, header{}, err
	}
	defer f.Close()

	var rows []row
	var hdr header

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	inTable := false
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "- **Capture start"):
			hdr.startUTC = afterColon(line)
		case strings.HasPrefix(line, "- **Capture end"):
			hdr.endUTC = afterColon(line)
		case strings.HasPrefix(line, "- **Message count"):
			n, _ := strconv.Atoi(strings.TrimSpace(afterColon(line)))
			hdr.msgCount = n
		case strings.HasPrefix(line, "- **Inter-arrival"):
			// "min=47 p50=50 p95=51 max=53"
			vals := afterColon(line)
			for _, kv := range strings.Fields(vals) {
				k, v, _ := strings.Cut(kv, "=")
				switch k {
				case "min":
					hdr.interMin = v
				case "p50":
					hdr.interP50 = v
				case "p95":
					hdr.interP95 = v
				case "max":
					hdr.interMax = v
				}
			}
		case strings.HasPrefix(line, "- **Price range"):
			vals := afterColon(line)
			for _, kv := range strings.Fields(vals) {
				k, v, _ := strings.Cut(kv, "=")
				switch k {
				case "min":
					hdr.priceMin = v
				case "max":
					hdr.priceMax = v
				case "last":
					hdr.priceLast = v
				}
			}
		}

		if strings.HasPrefix(line, "|--") {
			inTable = true
			continue
		}
		if !inTable {
			continue
		}
		if !strings.HasPrefix(line, "|") {
			continue
		}
		cells := splitRow(line)
		if len(cells) < 4 {
			continue
		}
		signedAt, err := strconv.ParseInt(strings.TrimSpace(cells[0]), 10, 64)
		if err != nil {
			continue
		}
		priceStr := strings.TrimSpace(cells[2])
		priceF, err := strconv.ParseFloat(priceStr, 64)
		if err != nil {
			continue
		}
		tradeID, _ := strconv.ParseInt(strings.TrimSpace(cells[3]), 10, 64)
		r := row{
			signedAt: signedAt,
			priceStr: priceStr,
			priceF:   priceF,
			tradeID:  tradeID,
		}
		// Mid table layout when bid/ask are present:
		//   signed_at_ms | timestamp | price | trade_id | bid | ask | delta_ms
		// Trade table layout is always:
		//   signed_at_ms | timestamp | price | trade_id | delta_ms
		if len(cells) >= 7 {
			bidStr := strings.TrimSpace(cells[4])
			askStr := strings.TrimSpace(cells[5])
			bidF, errB := strconv.ParseFloat(bidStr, 64)
			askF, errA := strconv.ParseFloat(askStr, 64)
			if errB == nil && errA == nil && bidStr != "" && askStr != "" && bidStr != "-" && askStr != "-" {
				r.bidStr = bidStr
				r.askStr = askStr
				r.bidF = bidF
				r.askF = askF
				r.hasBA = true
			}
		}
		rows = append(rows, r)
	}
	if err := scanner.Err(); err != nil {
		return nil, hdr, err
	}
	return rows, hdr, nil
}

func afterColon(s string) string {
	if i := strings.Index(s, ":**"); i >= 0 {
		return strings.TrimSpace(s[i+3:])
	}
	return s
}

func splitRow(line string) []string {
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	parts := strings.Split(line, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func findStuckRuns(rows []row, minLen int) []stuckRun {
	var runs []stuckRun
	if len(rows) == 0 {
		return runs
	}
	i := 0
	for i < len(rows) {
		j := i + 1
		for j < len(rows) && rows[j].priceStr == rows[i].priceStr {
			j++
		}
		count := j - i
		if count >= minLen {
			run := stuckRun{
				priceStr: rows[i].priceStr,
				priceF:   rows[i].priceF,
				startMs:  rows[i].signedAt,
				endMs:    rows[j-1].signedAt,
				count:    count,
			}
			if rows[i].hasBA {
				run.bidStr = rows[i].bidStr
				run.askStr = rows[i].askStr
				run.bidF = rows[i].bidF
				run.askF = rows[i].askF
				run.hasBA = true
				for k := i + 1; k < j; k++ {
					if !rows[k].hasBA || rows[k].bidStr != run.bidStr || rows[k].askStr != run.askStr {
						run.bidAskVaried = true
						break
					}
				}
			}
			runs = append(runs, run)
		}
		i = j
	}
	return runs
}

func attachTrades(runs []stuckRun, trades []row) {
	if len(runs) == 0 || len(trades) == 0 {
		return
	}
	sort.Slice(trades, func(i, j int) bool { return trades[i].signedAt < trades[j].signedAt })
	for i := range runs {
		lo := sort.Search(len(trades), func(k int) bool { return trades[k].signedAt >= runs[i].startMs })
		hi := sort.Search(len(trades), func(k int) bool { return trades[k].signedAt > runs[i].endMs })
		if lo < hi {
			runs[i].tradeRows = append([]row(nil), trades[lo:hi]...)
		}
	}
}

func classify(r *stuckRun) classification {
	if r.hasBA {
		return classifyExact(r)
	}
	return classifyLegacy(r)
}

// classifyExact uses the captured best bid / best ask to verify mid and each trade directly.
func classifyExact(r *stuckRun) classification {
	c := classification{mode: "exact"}

	computedMid := (r.bidF + r.askF) / 2
	midDelta := math.Abs(computedMid - r.priceF)
	if midDelta > midEqualEps {
		c.verdict = "ANOMALOUS"
		c.deltaUSD = midDelta
		if r.priceF != 0 {
			c.deltaPPM = midDelta / r.priceF * 1e6
		}
		c.note = fmt.Sprintf("mid equation broken: |(bid+ask)/2 - mid| = %.9f USD > %g (bid=%s ask=%s mid=%s)",
			midDelta, midEqualEps, r.bidStr, r.askStr, r.priceStr)
		return c
	}

	if len(r.tradeRows) == 0 {
		c.verdict = "EXPECTED"
		c.note = fmt.Sprintf("no trades inside run; mid equation verified: (%s + %s)/2 == %s", r.bidStr, r.askStr, r.priceStr)
		if r.bidAskVaried {
			c.note += " (note: bid/ask varied within run but mid stayed constant)"
		}
		return c
	}

	distinctSet := make(map[string]struct{}, 4)
	minF := math.Inf(1)
	maxF := math.Inf(-1)
	maxDev := 0.0
	aboveAsk := 0
	belowBid := 0
	for _, t := range r.tradeRows {
		distinctSet[t.priceStr] = struct{}{}
		if t.priceF < minF {
			minF = t.priceF
		}
		if t.priceF > maxF {
			maxF = t.priceF
		}
		dev := math.Abs(t.priceF - r.priceF)
		if dev > maxDev {
			maxDev = dev
		}
		if t.priceF > r.askF+tradeBoundEps {
			aboveAsk++
		} else if t.priceF < r.bidF-tradeBoundEps {
			belowBid++
		}
	}
	outOfBand := aboveAsk + belowBid
	distinct := make([]string, 0, len(distinctSet))
	for k := range distinctSet {
		distinct = append(distinct, k)
	}
	sort.Strings(distinct)

	c.mean = (minF + maxF) / 2
	c.deltaUSD = math.Abs(c.mean - r.priceF)
	if r.priceF != 0 {
		c.deltaPPM = c.deltaUSD / r.priceF * 1e6
	}
	c.distinct = distinct
	c.implied = fmt.Sprintf("[%s, %s] bid_ask_mid=%g", r.bidStr, r.askStr, computedMid)
	c.maxDevUSD = maxDev
	c.anomalous = outOfBand

	switch {
	case outOfBand == 0:
		c.verdict = "EXPECTED"
		c.note = fmt.Sprintf("all %d trade(s) lie within [bid - %g, ask + %g]; mid equation exact", len(r.tradeRows), tradeBoundEps, tradeBoundEps)
		if r.bidAskVaried {
			c.note += " (bid/ask varied within run but mid stayed constant)"
		}
	case outOfBand == 1 && len(r.tradeRows) >= 2:
		c.verdict = "EXPECTED"
		c.tradeThru = 1
		c.note = "one trade outside [bid, ask]: classified as trade-through (taker swept resting depth before next @bookTicker arrived); other trades respect BBO bounds"
	case (aboveAsk > 0 && belowBid == 0) || (belowBid > 0 && aboveAsk == 0):
		// Same-side sweep: a single taker market order consumed multiple resting levels
		// before the next @bookTicker arrived. Mathematically identical to one trade-through,
		// just split across N matches.
		c.verdict = "EXPECTED"
		c.tradeThru = 1
		side := "ask-side (taker buyer sweep)"
		if belowBid > 0 {
			side = "bid-side (taker seller sweep)"
		}
		c.note = fmt.Sprintf("%d trades outside [bid, ask] all on the %s; classified as a single trade-through sweep (one market order consumed multiple resting levels before next @bookTicker arrived)", outOfBand, side)
	default:
		c.verdict = "ANOMALOUS"
		c.note = fmt.Sprintf("%d trades above ask AND %d below bid in the same run: BBO is inconsistent with both sides of the trade evidence (not a simple sweep)", aboveAsk, belowBid)
	}
	return c
}

func classifyLegacy(r *stuckRun) classification {
	if len(r.tradeRows) == 0 {
		return classification{
			verdict: "NO_TRADES",
			mode:    "legacy",
			note:    "no trade prints inside this stuck mid run; cannot verify (bid/ask not captured)",
		}
	}

	distinctSet := make(map[string]struct{}, 4)
	minF := math.Inf(1)
	maxF := math.Inf(-1)
	maxDev := 0.0
	outliers := 0
	for _, t := range r.tradeRows {
		distinctSet[t.priceStr] = struct{}{}
		if t.priceF < minF {
			minF = t.priceF
		}
		if t.priceF > maxF {
			maxF = t.priceF
		}
		dev := math.Abs(t.priceF - r.priceF)
		if dev > maxDev {
			maxDev = dev
		}
		if dev > tickUSD+toleranceUSD {
			outliers++
		}
	}
	distinct := make([]string, 0, len(distinctSet))
	for k := range distinctSet {
		distinct = append(distinct, k)
	}
	sort.Strings(distinct)

	mean := (minF + maxF) / 2.0
	delta := math.Abs(mean - r.priceF)
	deltaPPM := 0.0
	if r.priceF != 0 {
		deltaPPM = delta / r.priceF * 1e6
	}
	implied := fmt.Sprintf("[%g, %g] mid=%g", minF, maxF, mean)

	verdict := "EXPECTED"
	note := ""
	tradeThru := 0
	switch {
	case outliers == 0:
		switch len(distinct) {
		case 1:
			note = "single trade-side observed; trade lies within +/- 1 tick of mid (consistent with stationary BBO)"
		default:
			note = "trades straddle mid by <= 1 tick (consistent with stationary BBO; trades hit existing depth)"
		}
	case outliers == 1 && len(r.tradeRows) >= 2:
		verdict = "EXPECTED"
		tradeThru = 1
		note = "one trade > 1 tick from mid: classified as trade-through (taker swept resting depth before next @bookTicker arrived); remaining trades are within BBO bounds"
	default:
		verdict = "ANOMALOUS"
		note = fmt.Sprintf("%d/%d trades lie > %g USD from mid; needs root-cause investigation", outliers, len(r.tradeRows), tickUSD+toleranceUSD)
	}

	return classification{
		verdict:   verdict,
		mean:      mean,
		deltaUSD:  delta,
		deltaPPM:  deltaPPM,
		distinct:  distinct,
		implied:   implied,
		maxDevUSD: maxDev,
		tradeThru: tradeThru,
		anomalous: outliers,
		note:      note,
		mode:      "legacy",
	}
}

func renderReport(symbol, midPath, tradePath string, midHdr, tradeHdr header,
	midRows, tradeRows []row, runs []stuckRun, classes []classification,
	expected, anomalous, noTrades, tradeThru, exactRuns int) string {

	var b strings.Builder
	wf := func(format string, args ...any) { fmt.Fprintf(&b, format, args...) }

	exact := exactRuns > 0 && exactRuns == len(runs)
	mixedMode := exactRuns > 0 && exactRuns < len(runs)

	verdictHeadline := "No bug. Stuck mid runs are fully explained by a stationary BBO with trades against existing depth."
	if anomalous > 0 {
		if exact {
			verdictHeadline = fmt.Sprintf("Investigation required: %d stuck mid run(s) violate `mid == (bid+ask)/2` or have multiple trades outside `[bid, ask]`.", anomalous)
		} else {
			verdictHeadline = fmt.Sprintf("Investigation required: %d stuck mid run(s) are NOT explained by the implied bid/ask of trade prints.", anomalous)
		}
	}

	wf("# Mid vs trade %s analysis\n\n", symbol)
	wf("## Summary\n\n%s\n\n", verdictHeadline)
	if exact {
		wf("Exact verification mode: best bid / best ask captured alongside every mid emission (`meta.bid` / `meta.ask`). The mid equation is checked directly; trade prints are checked against the actual `[bid, ask]` of the locked BBO.\n\n")
	} else if mixedMode {
		wf("Mixed mode: %d/%d runs used exact verification (capture included `meta.bid` / `meta.ask`); the remainder fell back to the legacy tick-based heuristic.\n\n", exactRuns, len(runs))
	} else {
		wf("Legacy (inference) mode: the capture did not include `meta.bid` / `meta.ask`, so trades are checked against `mid +/- (tick + tol)` instead of the actual BBO.\n\n")
	}
	wf("- Stuck mid runs analysed (>= %d ticks): **%d**\n", 3, len(runs))
	wf("- EXPECTED: **%d** (of which **%d** include a single trade-through print)\n", expected, tradeThru)
	wf("- ANOMALOUS: **%d**\n", anomalous)
	if exact {
		wf("- NO_TRADES (no trade prints in run): **%d** — these are still verified because `mid == (bid+ask)/2` is checked from `meta`\n\n", noTrades)
	} else {
		wf("- NO_TRADES (no trade prints inside run, cannot verify from md alone): **%d**\n\n", noTrades)
	}

	wf("## Inputs\n\n")
	wf("| File | Capture start (UTC) | Capture end (UTC) | Messages | Inter-arrival ms (min/p50/p95/max) | Price range (min/max/last) |\n")
	wf("|------|---------------------|--------------------|----------|------------------------------------|----------------------------|\n")
	wf("| `%s` | %s | %s | %d | %s/%s/%s/%s | %s/%s/%s |\n",
		midPath, midHdr.startUTC, midHdr.endUTC, midHdr.msgCount,
		midHdr.interMin, midHdr.interP50, midHdr.interP95, midHdr.interMax,
		midHdr.priceMin, midHdr.priceMax, midHdr.priceLast)
	wf("| `%s` | %s | %s | %d | %s/%s/%s/%s | %s/%s/%s |\n\n",
		tradePath, tradeHdr.startUTC, tradeHdr.endUTC, tradeHdr.msgCount,
		tradeHdr.interMin, tradeHdr.interP50, tradeHdr.interP95, tradeHdr.interMax,
		tradeHdr.priceMin, tradeHdr.priceMax, tradeHdr.priceLast)

	wf("## Why the mid stays constant for many 50 ms ticks\n\n")
	wf("Three code facts determine the behaviour. References use the production server tree.\n\n")
	wf("1. **BBO is written only on `@bookTicker` events.** Binance emits this stream every time the top-of-book bid OR ask **changes** (price or size). If the top-of-book remains numerically the same, no event arrives, and the BBO snapshot keeps its previous values.\n")
	wf("   - `provider/binance.go` lines 455-477: unmarshal `@bookTicker`, validate via `MidPriceFromBestBidAsk`, write to `bbo.SnapshotStore.Update`.\n")
	wf("2. **The 50 ms emitter re-signs the LATEST stored snapshot.** It never recomputes from the trade stream. If bid/ask didn't change, mid doesn't change.\n")
	wf("   - `provider/bookmid_emitter.go` `tick()` lines 96-159 reads `e.store.Snapshot(ent.BboKey)` and submits `(bid+ask)/2`.\n")
	wf("3. **Trades do NOT move BBO unless they consume the entire top-of-book size.** A taker buy prints at the best ask; until the ask level's resting size hits zero, the ask price stays put.\n")
	wf("   - This is exchange semantics, not a code property. It's why two trade prints separated by milliseconds can be different (one taker buy at ask, one taker sell at bid) while the BBO mid is unchanged.\n\n")

	wf("So a stuck mid run means: between two `@bookTicker` events, the emitter fired N times and signed the same mid every 50 ms. Trades during that window contribute zero to the mid feed.\n\n")

	wf("## Decision rule per run\n\n")
	if exact {
		wf("Exact mode (best bid / best ask are recorded in the mid capture). For each maximal run of consecutive equal mid prices:\n\n")
		wf("1. **Mid equation:** verify `|(bid + ask) / 2 - mid| <= %g USD`. Failure ⇒ **ANOMALOUS** (book_mid emitter is inconsistent with its own bid/ask).\n", midEqualEps)
		wf("2. **Trade bounds:** for every trade `t` in the run, require `bid - %g <= t <= ask + %g` USD. The small slack absorbs micro-USD drift in the USDC/USDT rate between the trade and book_mid feeds.\n", tradeBoundEps, tradeBoundEps)
		wf("   - 0 trades outside → **EXPECTED**.\n")
		wf("   - 1 trade outside (with at least one trade in-bounds) → **EXPECTED (trade-through)**: a taker consumed the BBO level before the next `@bookTicker` arrived.\n")
		wf("   - ≥ 2 trades outside, **all on the same side** (all above ask, or all below bid) → **EXPECTED (trade-through sweep)**: a single market order consumed multiple resting levels before the next `@bookTicker` arrived. Mathematically equivalent to a single trade-through, just split across N matches.\n")
		wf("   - Trades on **both** sides outside `[bid, ask]` → **ANOMALOUS**: the locked BBO is inconsistent with both sides of the trade evidence — not a simple sweep.\n")
		wf("3. **No trades in run:** still **EXPECTED**, since step 1 alone is a complete verification — `mid == (bid+ask)/2` is what the emitter is supposed to produce.\n\n")
	} else {
		wf("For each maximal run of consecutive equal mid prices with at least one trade print inside:\n\n")
		wf("- For every trade `t` in the run, compute `dev_t = |t.price - mid|`.\n")
		wf("- The Binance ETHUSDT/BTCUSDT tick is `0.01 USDT` → after USDC/USDT conversion `tickUSD = %g`. A trade at the BBO bid or ask is at most `half-spread` from mid. For a 1-tick book (typical for ETHUSDT) half-spread is `0.005 USD`; for a 2-tick book it's `0.01 USD`. We allow trades to be within `%g + %g = %g USD` of mid before flagging.\n", tickUSD, tickUSD, toleranceUSD, tickUSD+toleranceUSD)
		wf("- **EXPECTED** if all trades satisfy `dev_t <= %g USD`. The mid is consistent with a stationary 1- or 2-tick BBO and trades hitting existing depth.\n", tickUSD+toleranceUSD)
		wf("- **EXPECTED (trade-through)** if exactly one trade violates this and at least one other trade in the run is within bounds. A trade-through is a taker order that swept through several resting levels before the next `@bookTicker` (BBO change) was delivered.\n")
		wf("- **ANOMALOUS** if two or more trades violate the bound. The locked mid is inconsistent with the trade evidence; needs root-cause analysis.\n\n")
	}

	wf("## Worked example (the window highlighted by the reporter)\n\n")
	if ex := findExampleRun(runs, classes); ex.priceStr != "" {
		wf("Stuck run at mid `%s` USD from `%d` to `%d` (%d consecutive 50 ms ticks, ~%d ms):\n\n",
			ex.priceStr, ex.startMs, ex.endMs, ex.count, ex.endMs-ex.startMs)
		wf("- Trade prints inside the run: %d\n", len(ex.tradeRows))
		c := exampleClass(runs, classes, ex)
		wf("- Distinct trade prices: %v\n", c.distinct)
		wf("- Min trade = %.6f, max trade = %.6f, mean = %.6f\n", minPrice(ex.tradeRows), maxPrice(ex.tradeRows), c.mean)
		wf("- |mean − mid| = %.9f USD (%.3f ppm)\n", c.deltaUSD, c.deltaPPM)
		wf("- Verdict: **%s**. %s\n\n", c.verdict, c.note)
		if len(ex.tradeRows) >= 2 {
			wf("Two adjacent trade prints from the run:\n\n")
			wf("| signed_at_ms | price | trade_id |\n|--------------|-------|----------|\n")
			wf("| %d | %s | %d |\n", ex.tradeRows[0].signedAt, ex.tradeRows[0].priceStr, ex.tradeRows[0].tradeID)
			wf("| %d | %s | %d |\n\n", ex.tradeRows[len(ex.tradeRows)-1].signedAt, ex.tradeRows[len(ex.tradeRows)-1].priceStr, ex.tradeRows[len(ex.tradeRows)-1].tradeID)
		}
	} else {
		wf("(no stuck run with trades found at the requested precision)\n\n")
	}

	wf("## Full-window per-run table\n\n")
	idx := indicesByDuration(runs)
	if exact {
		wf("Runs with at least 3 consecutive equal mid prints, sorted by descending duration. `outOfBand` is the count of trades that fall outside `[bid - %g, ask + %g]` USD.\n\n", tradeBoundEps, tradeBoundEps)
		wf("| # | start_ms | end_ms | duration_ms | run_len (ticks) | mid_price | bid | ask | trades | distinct | min_trade | max_trade | outOfBand | verdict |\n")
		wf("|---|----------|--------|-------------|------------------|-----------|-----|-----|--------|----------|-----------|-----------|-----------|---------|\n")
		for rank, i := range idx {
			r := runs[i]
			c := classes[i]
			minS := "-"
			maxS := "-"
			distinctS := "-"
			outOfBandS := "-"
			tradesIn := len(r.tradeRows)
			if tradesIn > 0 {
				minS = fmt.Sprintf("%.6f", minPrice(r.tradeRows))
				maxS = fmt.Sprintf("%.6f", maxPrice(r.tradeRows))
				distinctS = strconv.Itoa(len(c.distinct))
				outOfBandS = strconv.Itoa(c.anomalous)
			} else if c.verdict == "EXPECTED" {
				outOfBandS = "0"
			}
			verdictLabel := c.verdict
			if c.verdict == "EXPECTED" && c.tradeThru > 0 {
				verdictLabel = "EXPECTED (trade-through)"
			}
			wf("| %d | %d | %d | %d | %d | %s | %s | %s | %d | %s | %s | %s | %s | %s |\n",
				rank+1, r.startMs, r.endMs, r.endMs-r.startMs, r.count, r.priceStr,
				r.bidStr, r.askStr, tradesIn, distinctS, minS, maxS, outOfBandS, verdictLabel)
		}
		wf("\n")
	} else {
		wf("Runs with at least 3 consecutive equal mid prints, sorted by descending duration. `max|dev|` is the largest `|trade_price - mid|` seen in the run; `outliers` is the count of trades that exceed `tick + tol = %g USD`.\n\n", tickUSD+toleranceUSD)
		wf("| # | start_ms | end_ms | duration_ms | run_len (ticks) | mid_price | trades | distinct | min_trade | max_trade | max\\|dev\\| USD | outliers | verdict |\n")
		wf("|---|----------|--------|-------------|------------------|-----------|--------|----------|-----------|-----------|---------------|----------|---------|\n")
		for rank, i := range idx {
			r := runs[i]
			c := classes[i]
			minS := "-"
			maxS := "-"
			maxDevS := "-"
			distinctS := "-"
			outliersS := "-"
			tradesIn := len(r.tradeRows)
			if tradesIn > 0 {
				minS = fmt.Sprintf("%.6f", minPrice(r.tradeRows))
				maxS = fmt.Sprintf("%.6f", maxPrice(r.tradeRows))
				maxDevS = fmt.Sprintf("%.6f", c.maxDevUSD)
				distinctS = strconv.Itoa(len(c.distinct))
				outliersS = strconv.Itoa(c.anomalous)
			}
			verdictLabel := c.verdict
			if c.verdict == "EXPECTED" && c.tradeThru > 0 {
				verdictLabel = "EXPECTED (trade-through)"
			}
			wf("| %d | %d | %d | %d | %d | %s | %d | %s | %s | %s | %s | %s | %s |\n",
				rank+1, r.startMs, r.endMs, r.endMs-r.startMs, r.count, r.priceStr,
				tradesIn, distinctS, minS, maxS, maxDevS, outliersS, verdictLabel)
		}
		wf("\n")
	}

	wf("## Aggregate quantification\n\n")
	wf("- Total mid messages: %d (`%s`)\n", len(midRows), midPath)
	wf("- Total trade messages: %d (`%s`)\n", len(tradeRows), tradePath)
	wf("- Distinct mid prices: %d\n", countDistinct(midRows))
	wf("- Distinct trade prices: %d\n", countDistinct(tradeRows))
	wf("- Longest stuck mid run: %s\n", longestRunDescription(runs))
	wf("- EXPECTED runs: %d (%.1f%% of runs with trades), of which %d include exactly one trade-through print\n", expected, percentOfWithTrades(expected, len(runs), noTrades), tradeThru)
	wf("- ANOMALOUS runs: %d\n", anomalous)
	wf("- NO_TRADES runs (cannot verify from this data): %d\n\n", noTrades)

	wf("## Why the trade feed looks volatile in the same window\n\n")
	wf("- Each Binance `@trade` is one match. Multiple matches at the same level all print at the same price.\n")
	wf("- Taker-buy → print at best ask. Taker-sell → print at best bid. Until a level is fully consumed, BBO doesn't move.\n")
	wf("- Trade prints arrive on demand (bursty; p95 inter-arrival in this capture is %s ms); mid prints arrive on a fixed 50 ms cadence (p50 %s ms).\n", tradeHdr.interP95, midHdr.interP50)
	wf("- Both observations of the same exchange are therefore consistent: trades happened, but the top-of-book did not, so the mid stayed put.\n\n")

	wf("## Limitations\n\n")
	if exact {
		wf("- Verification is now direct: `mid == (bid + ask) / 2` is checked from `meta.bid` / `meta.ask` and each trade is checked against the actual `[bid, ask]` interval. No inference from trade prints is needed.\n")
		wf("- `meta` is sidecar observational metadata on the book_mid broadcast (USD-denominated, same currency as `price`). It is **not** part of the signed payload; ECDSA signature verification ignores it.\n")
		wf("- USDT→USD rate drift between the trade and book_mid feeds is absorbed by the `%g USD` bound slack. A future improvement would also stamp the rate in `meta` so the analysis can re-derive trade USDT prices for exact equality.\n\n", tradeBoundEps)
	} else {
		wf("- These reports do not log raw bid/ask, only the resulting mid. We infer the bid/ask of the locked BBO from trade prints, which works **only when both sides are hit inside the run**. Runs where only one side is hit cannot be uniquely verified by this method; they are still consistent with `mean == mid` if there is exactly one distinct trade price (since the BBO mid must lie within one tick of any executed price, the tolerance subsumes that case).\n")
		wf("- USDT→USD conversion uses a separately-fetched USDC/USDT rate. Tiny shifts in that rate over the window can shift the USD mid by ~1e-4 USD with constant USDT bid/ask. The tolerance %g USD is generous for that effect.\n\n", toleranceUSD)
	}

	if anomalous == 0 {
		wf("## Root cause and fix\n\n")
		if exact {
			wf("**No code change required.** Every stuck mid run satisfies `mid == (bid + ask) / 2` exactly (within %g USD). Trades outside `[bid - %g, ask + %g]` are limited to single trade-through events or same-side sweeps (one market order consumes multiple resting levels before the next `@bookTicker` arrives) — both are exchange-side latency between the `@trade` and `@bookTicker` streams, not a code defect. The behaviour matches the documented design:\n\n", midEqualEps, tradeBoundEps, tradeBoundEps)
		} else {
			wf("**No code change required.** Every stuck mid run with trade evidence was classified EXPECTED within the %g USD tolerance. The behaviour matches the documented design:\n\n", toleranceUSD)
		}
		wf("- `@bookTicker` updates the BBO snapshot (`provider/binance.go` lines 455-477).\n")
		wf("- The 50 ms emitter signs `(bid+ask)/2` from the latest snapshot (`provider/bookmid_emitter.go` lines 96-159).\n")
		wf("- Stationary BBO + non-depleting trades = stuck mid + fluctuating trade prints, exactly as observed.\n\n")
		wf("If a future capture shows ANOMALOUS runs, follow the root-cause matrix in the plan to localize:\n\n")
		wf("- **A** stale BBO snapshot (`bbo/store.go`).\n")
		wf("- **B** stale USDC/USDT rate (`provider/binance.go` converter + emitter lines 121-135).\n")
		wf("- **C** dropped/unsubscribed `@bookTicker` (`provider/binance.go` lines 366-367, 455-477).\n")
		wf("- **D** other (emitter ticker drift, queue full).\n\n")
	} else {
		wf("## Anomalies to investigate\n\n")
		wf("The runs marked ANOMALOUS in the per-run table need root-cause analysis. Walk the matrix in `mid_vs_trade_eth_analysis_350efab5.plan.md` step 3:\n\n")
		wf("1. Inspect `provider_ws_last_message_seconds{stream=\"bookTicker\"}` during each run; near-zero rate ⇒ branch C.\n")
		wf("2. Check whether trades drift monotonically while mid stays put ⇒ branch A.\n")
		wf("3. Check the converter rate over the run ⇒ branch B.\n")
		wf("4. Else ⇒ branch D (ad hoc).\n\n")
	}
	return b.String()
}

func findExampleRun(runs []stuckRun, classes []classification) stuckRun {
	const target = 2099.603295
	for i, r := range runs {
		if math.Abs(r.priceF-target) < 1e-6 && len(classes[i].distinct) > 0 {
			return r
		}
	}
	for i, r := range runs {
		if r.count >= 3 && len(classes[i].distinct) >= 2 {
			return r
		}
	}
	return stuckRun{}
}

func exampleClass(runs []stuckRun, classes []classification, target stuckRun) classification {
	for i, r := range runs {
		if r.startMs == target.startMs && r.endMs == target.endMs && r.priceStr == target.priceStr {
			return classes[i]
		}
	}
	return classification{}
}

func indicesByDuration(runs []stuckRun) []int {
	idx := make([]int, len(runs))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool {
		return (runs[idx[a]].endMs - runs[idx[a]].startMs) > (runs[idx[b]].endMs - runs[idx[b]].startMs)
	})
	return idx
}

func minPrice(rows []row) float64 {
	if len(rows) == 0 {
		return 0
	}
	m := rows[0].priceF
	for _, r := range rows[1:] {
		if r.priceF < m {
			m = r.priceF
		}
	}
	return m
}

func maxPrice(rows []row) float64 {
	if len(rows) == 0 {
		return 0
	}
	m := rows[0].priceF
	for _, r := range rows[1:] {
		if r.priceF > m {
			m = r.priceF
		}
	}
	return m
}

func countDistinct(rows []row) int {
	set := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		set[r.priceStr] = struct{}{}
	}
	return len(set)
}

func longestRunDescription(runs []stuckRun) string {
	if len(runs) == 0 {
		return "(none)"
	}
	longest := runs[0]
	for _, r := range runs[1:] {
		if r.endMs-r.startMs > longest.endMs-longest.startMs {
			longest = r
		}
	}
	return fmt.Sprintf("%d ticks (~%d ms) at mid=%s [%d..%d]",
		longest.count, longest.endMs-longest.startMs, longest.priceStr, longest.startMs, longest.endMs)
}

func percentOfWithTrades(numerator, totalRuns, noTrades int) float64 {
	denom := totalRuns - noTrades
	if denom == 0 {
		return 0
	}
	return float64(numerator) / float64(denom) * 100
}
