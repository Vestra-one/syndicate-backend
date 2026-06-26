import { useCallback, useEffect, useRef } from 'react'
import { useGameStore } from '@/store/gameStore'
import { seatAlias } from '@/lib/seats'
import { projectPot, projectSeat, type ScreenPoint } from '@/three/table/tableView'
import type { SeatView } from '@/lib/protocol'

/**
 * Players seated around the table's OUTER RING, plus the pot at the centre of
 * the felt. Each element is pinned to a 3D world anchor and re-projected to
 * screen space every frame (see tableView), so they ride the table as the
 * camera sways rather than hovering in screen space.
 *
 * "You" sit at the front and are represented by YourPosition + the betting
 * panel, so only opponents get a table medallion.
 */
export function Seats() {
  const match = useGameStore((s) => s.match)
  if (!match) return null
  const others = match.seats.filter((s) => s.seat !== match.yourSeat)

  return (
    <div className="table-seats">
      {others.map((s) => (
        <SeatMedallion
          key={s.seat}
          seat={s}
          toAct={match.toActSeat === s.seat}
          dealer={match.buttonSeat === s.seat}
          yourSeat={match.yourSeat}
        />
      ))}
      {match.pot > 0 && <Pot amount={match.pot} />}
    </div>
  )
}

/** Pin a DOM node to a projected 3D anchor, updated every animation frame. */
function useAnchor(project: () => ScreenPoint | null) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = ref.current
      if (!el) return
      const p = project()
      if (!p || p.behind) {
        el.style.opacity = '0'
        return
      }
      el.style.opacity = ''
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [project])
  return ref
}

function monogram(alias: string): string {
  return alias.replace(/^The\s+/, '').charAt(0).toUpperCase()
}

function SeatMedallion({
  seat,
  toAct,
  dealer,
  yourSeat,
}: {
  seat: SeatView
  toAct: boolean
  dealer: boolean
  yourSeat?: number
}) {
  const idx = seat.seat
  const ref = useAnchor(useCallback(() => projectSeat(idx), [idx]))
  const alias = seatAlias(idx, yourSeat)

  const cls = [
    'table-seat',
    toAct ? 'table-seat--acting' : '',
    seat.folded ? 'table-seat--folded' : '',
    seat.allIn ? 'table-seat--allin' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={ref} className={cls} style={{ opacity: 0 }}>
      {seat.committedThisStreet > 0 && !seat.folded && (
        <span className="seat-chip mono">{seat.committedThisStreet}</span>
      )}
      <div className="seat-medallion">
        <span className="seat-monogram">{monogram(alias)}</span>
        {dealer && <span className="seat-dealer" title="dealer button">D</span>}
      </div>
      <div className="seat-label">
        <span className="seat-alias">{alias}</span>
        <span className="seat-stack mono">
          {seat.folded ? 'folded' : seat.allIn ? 'all-in' : seat.stack}
        </span>
      </div>
    </div>
  )
}

function Pot({ amount }: { amount: number }) {
  const ref = useAnchor(useCallback(() => projectPot(), []))
  // Chips are now real 3D geometry in the Three.js scene; the HUD only carries
  // the amount label, floated just above the pile.
  return (
    <div ref={ref} className="table-pot" style={{ opacity: 0 }}>
      <div className="pot-eyebrow eyebrow">pot</div>
      <div className="pot-amount mono">{amount}</div>
    </div>
  )
}
