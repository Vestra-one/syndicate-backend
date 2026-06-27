import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { useGameStore } from '@/store/gameStore'
import { seatAlias } from '@/lib/seats'
import { projectPot, projectSeatAngle, seatAngles, type ScreenPoint } from '@/three/table/tableView'
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
  // Opponents in stable seat order, laid out symmetrically for this table size
  // so the arrangement stays composed whether 1 or 4 of them are seated.
  const others = match.seats
    .filter((s) => s.seat !== match.yourSeat)
    .sort((a, b) => a.seat - b.seat)
  const angles = seatAngles(others.length)

  return (
    <div className="table-seats">
      {others.map((s, i) => (
        <SeatMedallion
          key={s.seat}
          seat={s}
          angle={angles[i]}
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

/**
 * Each named persona is struck with its own engraved sigil rather than a bare
 * initial — gold line-emblems that read as part of the antique table rather
 * than a modern avatar letter. Unknown aliases fall back to a monogram.
 */
function SeatEmblem({ alias }: { alias: string }) {
  const sigil = SIGILS[alias]
  if (!sigil) return <span className="seat-monogram">{monogram(alias)}</span>
  return (
    <svg className="seat-sigil" viewBox="0 0 32 32" aria-hidden="true">
      {sigil}
    </svg>
  )
}

const SIGILS: Record<string, ReactElement> = {
  // Duchess — a coronet
  'The Duchess': (
    <g fill="currentColor">
      <path d="M4 23l2-12 5 6 5-9 5 9 5-6 2 12z" />
      <rect x="4" y="22.5" width="24" height="4" rx="1.2" />
      <circle cx="6" cy="9" r="1.7" />
      <circle cx="16" cy="6" r="1.7" />
      <circle cx="26" cy="9" r="1.7" />
    </g>
  ),
  // Cardinal — a Latin cross
  'The Cardinal': (
    <path
      fill="currentColor"
      d="M13.4 4h5.2v7.4H26v5.2h-7.4V28h-5.2V16.6H6v-5.2h7.4z"
    />
  ),
  // Banker — a balance scale
  'The Banker': (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 6v20" />
      <path d="M8 27h16" />
      <path d="M6 11h20" />
      <circle cx="16" cy="5" r="1.8" fill="currentColor" stroke="none" />
      <path d="M6 11v5" />
      <path d="M26 11v5" />
      <path d="M1.5 16a4.5 3 0 0 0 9 0" />
      <path d="M21.5 16a4.5 3 0 0 0 9 0" />
    </g>
  ),
  // Stranger — a domino mask (eye holes punched via even-odd)
  'The Stranger': (
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M4 11c5-2 19-2 24 0 1 6-3 11-8 11-2 0-3-1-4-2-1 1-2 2-4 2-5 0-9-5-8-11zM9 13a3 2.2 0 1 0 6 0 3 2.2 0 1 0-6 0zM17 13a3 2.2 0 1 0 6 0 3 2.2 0 1 0-6 0z"
    />
  ),
  // Marquis — a fleur-de-lis
  'The Marquis': (
    <g fill="currentColor">
      <path d="M16 3c-2 3-2.5 7 0 10 2.5-3 2-7 0-10z" />
      <path d="M16 10c-3 0-7 1.5-7 6 0 3 2 5 4 5-2-2-2-5 3-7z" />
      <path d="M16 10c3 0 7 1.5 7 6 0 3-2 5-4 5 2-2 2-5-3-7z" />
      <rect x="11" y="19" width="10" height="3" rx="1" />
      <path d="M16 22c-1 4-1 5 0 7 1-2 1-3 0-7z" />
    </g>
  ),
}

function SeatMedallion({
  seat,
  angle,
  toAct,
  dealer,
  yourSeat,
}: {
  seat: SeatView
  angle: number
  toAct: boolean
  dealer: boolean
  yourSeat?: number
}) {
  const idx = seat.seat
  const ref = useAnchor(useCallback(() => projectSeatAngle(angle), [angle]))
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
        <SeatEmblem alias={alias} />
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
  return (
    <div ref={ref} className="table-pot" style={{ opacity: 0 }}>
      <div className="pot-chips">
        <span className="pot-chip" />
        <span className="pot-chip" />
        <span className="pot-chip" />
      </div>
      <div className="pot-amount mono">{amount}</div>
      <div className="pot-eyebrow eyebrow">pot</div>
    </div>
  )
}
