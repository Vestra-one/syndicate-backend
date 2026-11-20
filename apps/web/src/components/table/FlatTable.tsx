import { useGameStore } from '@/store/gameStore'
import { seatAlias } from '@/lib/seats'

/**
 * The flat table (lite mode): a felt, and the live price with your sealed call drawn on
 * it — the one picture a hand is decided by. Plain SVG, no 3D, so it costs nothing to
 * draw and the game stays responsive on any machine.
 */
export function FlatTable() {
  const view = useGameStore((s) => s.view)
  const history = useGameStore((s) => s.priceHistory)
  const feed = useGameStore((st) => st.terms?.priceFeedId ?? 'BTC/USD')
  const call = useGameStore((s) => s.yourPrediction)
  const scale = 10 ** (useGameStore((s) => s.terms?.decimals) ?? 2)
  const pts = history.slice(-180)
  const last = pts.at(-1)?.price
  const callPx = call != null ? Number(call) / scale : null
  // While you are choosing a number the seal box takes the lower half of the screen —
  // the chart moves up out of its way instead of hiding behind it.
  const sealing = useGameStore((st) => st.match?.phase === 'SEALING' || st.match?.phase === 'FILLING' || (!st.match && st.view === 'table'))
  // Your own seat, at the near edge of the table like everyone else's.
  const seatedAs = useGameStore((st) => (st.view === 'table' && st.match?.yourSeat != null && (st.match.phase === 'SEALING' || st.match.phase === 'LIVE') ? `You · seat ${st.match.yourSeat + 1}` : null))
  // Once the hand settles, every call goes on the chart against the print: this is the
  // picture of the hand — who was where when the clock ran out.
  const settlement = useGameStore((s) => s.settlement)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  const reveals = settlement
    ? settlement.revealedPredictions.map((r) => ({ seat: r.seat, px: Number(r.prediction) / scale }))
    : []
  const settlePx = settlement ? Number(settlement.settlementPrice) / scale : null

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
    for (const r of reveals) { lo = Math.min(lo, r.px); hi = Math.max(hi, r.px) }
    if (settlePx != null && settlePx > 0) { lo = Math.min(lo, settlePx); hi = Math.max(hi, settlePx) }
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
    // Calls that landed close together would print their names on top of each other:
    // keep each label at least a line apart, top to bottom.
    const labelTops = reveals
      .map((r) => ({ r, top: (y(r.px) / H) * 100 }))
      .sort((p, q) => p.top - q.top)
    for (let i = 1; i < labelTops.length; i++) {
      if (labelTops[i].top - labelTops[i - 1].top < 9) labelTops[i].top = labelTops[i - 1].top + 9
    }
    chart = (
      <div className={`flat-chart ${sealing ? 'flat-chart--sealing' : ''} ${settlement ? 'flat-chart--settled' : ''}`}>
        <div className="flat-chart-head">
          <span className="eyebrow">{feed} · live</span>
          <b className={`mono ${up ? 'flat-up' : 'flat-down'}`}>${money(last)}</b>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="flat-chart-svg" aria-hidden="true">
          <path d={`${line} L${W} ${H} L0 ${H} Z`} className={up ? 'flat-area-up' : 'flat-area-down'} />
          <path d={line} className={up ? 'flat-line-up' : 'flat-line-down'} />
          {callY != null && reveals.length === 0 && <line x1="0" x2={W} y1={callY} y2={callY} className="flat-call" />}
          {reveals.map((r) => (
            <line key={r.seat} x1="0" x2={W} y1={y(r.px)} y2={y(r.px)} className={`flat-reveal ${r.seat === yourSeat ? 'flat-reveal--you' : ''}`} />
          ))}
          {settlePx != null && settlePx > 0 && <line x1="0" x2={W} y1={y(settlePx)} y2={y(settlePx)} className="flat-settle" />}
        </svg>
        {reveals.length > 0 && (
          <div className="flat-reveal-labels">
            {labelTops.map(({ r, top }) => (
              <span key={r.seat} className={`flat-reveal-label ${r.seat === yourSeat ? 'flat-reveal-label--you' : ''}`} style={{ top: `${top}%` }}>
                {seatAlias(r.seat, yourSeat ?? undefined)} · ${money(r.px)}
              </span>
            ))}
            {settlePx != null && settlePx > 0 && (
              <span className="flat-reveal-label flat-reveal-label--settle" style={{ top: `${(y(settlePx) / H) * 100}%` }}>settled ${money(settlePx)}</span>
            )}
          </div>
        )}
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
      {seatedAs && <div className="flat-you">{seatedAs}</div>}
      {chart}
    </div>
  )
}
