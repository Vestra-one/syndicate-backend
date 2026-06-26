import { useGameStore } from '@/store/gameStore'
import { seatAlias } from '@/lib/seats'
import type { SeatView } from '@/lib/protocol'

/**
 * The opponents around the table. A poker contest is invisible without seeing
 * who's in, who's acting, who folded, and who's committed. Seat-indexed and
 * pseudonymous (§8) — never a wallet. "You" is rendered in YourPosition.
 */
export function Seats() {
  const match = useGameStore((s) => s.match)
  if (!match) return null
  const others = match.seats.filter((s) => s.seat !== match.yourSeat)

  return (
    <div className="seats">
      {others.map((s) => (
        <SeatCard key={s.seat} seat={s} toAct={match.toActSeat === s.seat} yourSeat={match.yourSeat} />
      ))}
    </div>
  )
}

function SeatCard({
  seat,
  toAct,
  yourSeat,
}: {
  seat: SeatView
  toAct: boolean
  yourSeat?: number
}) {
  const cls = [
    'seat-card',
    'panel',
    toAct ? 'seat-card--acting' : '',
    seat.folded ? 'seat-card--folded' : '',
    seat.allIn ? 'seat-card--allin' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls}>
      <div className="seat-name">{seatAlias(seat.seat, yourSeat)}</div>
      <div className="seat-stack mono">{seat.stack}</div>
      <div className="seat-meta">
        {seat.folded ? (
          <span className="seat-tag seat-tag--folded">folded</span>
        ) : seat.allIn ? (
          <span className="seat-tag seat-tag--allin">all-in</span>
        ) : seat.committedThisStreet > 0 ? (
          <span className="seat-bet mono">bet {seat.committedThisStreet}</span>
        ) : toAct ? (
          <span className="seat-tag seat-tag--acting">thinking…</span>
        ) : (
          <span className="seat-bet mono seat-bet--idle">in</span>
        )}
      </div>
    </div>
  )
}
