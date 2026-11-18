import { useGameStore } from '@/store/gameStore'

/**
 * The flat table (lite mode): a felt, and the live price with your sealed call drawn on
 * it — the one picture a hand is decided by. Plain SVG, no 3D, so it costs nothing to
 * draw and the game stays responsive on any machine.
 */
export function FlatTable() {
  const view = useGameStore((s) => s.view)
  const history = useGameStore((s) => s.priceHistory)
  const feed = 'BTC/USD'
  const call = useGameStore((s) => s.yourPrediction)
  const scale = 10 ** (useGameStore((s) => s.terms?.decimals) ?? 2)
  const pts = history.slice(-180)
  const last = pts.at(-1)?.price
  const callPx = call != null ? Number(call) / scale : null

  let chart = null
  if (view === 'table' && pts.length >= 2 && last != null) {
    const W = 600
    const H = 200
    const prices = pts.map((p) => p.price)
    let lo = Math.min(...prices)
    let hi = Math.max(...prices)
    // Keep your call on the picture when it is within reach of the market.
    if (callPx != null && Math.abs(callPx - last) < (hi - lo || last * 0.001) * 3) {
      lo = Math.min(lo, callPx)
      hi = Math.max(hi, callPx)
    }
    const pad = (hi - lo || last * 0.0005) * 0.15
    lo -= pad
    hi += pad
    const t0 = pts[0].ts
    const span = Math.max(1, pts.at(-1)!.ts - t0)
    const x = (ts: number) => ((ts - t0) / span) * W
    const y = (p: number) => H - ((p - lo) / (hi - lo)) * H
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.price).toFixed(1)}`).join(' ')
    const up = last >= pts[0].price
    const callY = callPx != null && callPx >= lo && callPx <= hi ? y(callPx) : null
    const money = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    chart = (
      <div className="flat-chart">
        <div className="flat-chart-head">
          <span className="eyebrow">{feed} · live</span>
          <b className={`mono ${up ? 'flat-up' : 'flat-down'}`}>${money(last)}</b>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="flat-chart-svg" aria-hidden="true">
          <path d={`${line} L${W} ${H} L0 ${H} Z`} className={up ? 'flat-area-up' : 'flat-area-down'} />
          <path d={line} className={up ? 'flat-line-up' : 'flat-line-down'} />
          {callY != null && <line x1="0" x2={W} y1={callY} y2={callY} className="flat-call" />}
        </svg>
        {callPx != null && (
          <div className="flat-chart-foot eyebrow">
            <span className="flat-call-key" /> your call ${money(callPx)}
            {callY == null ? (callPx > last ? ' · above the picture' : ' · below the picture') : ''}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="flat-table" aria-hidden="true">
      <div className="flat-felt" />
      {chart}
    </div>
  )
}
