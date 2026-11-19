/**
 * How live is your call? The only thing that decides a hand is where the price ends
 * relative to the sealed calls, so the useful read is the gap between the market and your
 * call measured against how far the market typically travels in the time left.
 *
 * Everything here is arithmetic on public data (the price tape and the clock). It knows
 * nothing about anyone else's call and says nothing about them.
 */
export interface PricePoint { price: number; ts: number }

/** BTC-like fallback when the tape is too short: ~50% annualised ≈ 0.009% per √second. */
const FALLBACK_VOL_PER_SQRT_SEC = 0.00009

/** Realised volatility of the tape, in price units per √second. */
export function volPerSqrtSec(history: PricePoint[]): number | null {
  if (history.length < 2) return null
  let sumSq = 0
  let sumDt = 0
  for (let i = 1; i < history.length; i++) {
    const dt = (history[i].ts - history[i - 1].ts) / 1000
    if (dt <= 0) continue
    const dp = history[i].price - history[i - 1].price
    sumSq += dp * dp
    sumDt += dt
  }
  // Under ~20s of tape the estimate is noise; let the caller fall back.
  if (sumDt < 20 || sumSq === 0) return null
  return Math.sqrt(sumSq / sumDt)
}

/** One standard deviation of price travel over `seconds`, in price units. */
export function typicalMove(history: PricePoint[], seconds: number): number | null {
  const last = history.at(-1)?.price
  if (last == null || seconds <= 0) return null
  const vol = volPerSqrtSec(history) ?? last * FALLBACK_VOL_PER_SQRT_SEC
  const walk = vol * Math.sqrt(seconds)
  // Tick-to-tick volatility scaled by √time assumes the market wanders without direction.
  // When it trends, that badly understates how far it travels — so also measure what the
  // price has actually covered over spans of this length, and never claim less than that.
  const observed = observedMove(history, seconds)
  return observed != null ? Math.max(walk, observed) : walk
}

/** RMS distance the price has actually travelled over windows of ~`seconds` (or the longest
 *  window the history allows, scaled up), from the recent tape. */
function observedMove(history: PricePoint[], seconds: number): number | null {
  if (history.length < 8) return null
  const pts = history.slice(-1800)
  const span = (pts.at(-1)!.ts - pts[0].ts) / 1000
  if (span < 10) return null
  const window = Math.min(seconds, span / 2)
  const w = window * 1000
  let j = 0
  let sumSq = 0
  let n = 0
  for (let i = 0; i < pts.length; i++) {
    while (j < pts.length && pts[j].ts - pts[i].ts < w) j++
    if (j >= pts.length) break
    const d = pts[j].price - pts[i].price
    sumSq += d * d
    n++
  }
  if (n < 3) return null
  return Math.sqrt(sumSq / n) * Math.sqrt(seconds / window)
}

export type EdgeLevel = 'in-range' | 'needs-move' | 'long-shot'
export interface EdgeRead {
  level: EdgeLevel
  label: string
  /** Gap in typical moves (0 = the market is sitting on your call). */
  moves: number
  /** Plain advice for this read — how a player would use it. */
  tip: string
  /** 0–1 bar fill: full when the market is on your call, empty at 3+ typical moves. */
  fill: number
}

export function edgeRead(gap: number, move: number): EdgeRead {
  const moves = move > 0 ? Math.abs(gap) / move : Infinity
  const level: EdgeLevel = moves <= 0.75 ? 'in-range' : moves <= 2 ? 'needs-move' : 'long-shot'
  const label = level === 'in-range' ? 'In range' : level === 'needs-move' ? 'Needs a move' : 'Long shot'
  const tip =
    level === 'in-range'
      ? (moves <= 0.2 ? 'The market is sitting on your call. This is the time to bet.' : 'Your call is within reach of the market. A good spot to bet — it can still drift away.')
      : level === 'needs-move'
        ? 'You need the market to come back. Call small bets, fold to big ones.'
        : 'The market has run away from your call. Fold to a bet — or bluff.'
  return { level, label, moves, tip, fill: Math.max(0, Math.min(1, 1 - moves / 3)) }
}
