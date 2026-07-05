import { useGameStore } from '@/store/gameStore'
import { seatAlias } from '@/lib/seats'
import { useNow } from '@/lib/useNow'
import { useWaiting } from './WaitingRoom'

/**
 * The single, unmistakable "whose move is it" banner — pinned top-centre over the
 * felt during LIVE play. The per-pod rings and the action panel's own title already
 * carry this, but they're small / 3D-projected / off to one side; this is the one
 * always-in-eyeline answer to "is it my turn or theirs?".
 *
 *   your turn      -> bright, pulsing "Your turn" + a nudge to the action panel below
 *   someone else   -> "{alias} to act" with a thinking pulse (and a folded note if you're out)
 *
 * Hidden outside LIVE, in the waiting room, and between streets (no seat to act).
 */
export function TurnBanner() {
  const match = useGameStore((s) => s.match)
  const yourTurn = useGameStore((s) => s.yourTurn)
  const { active: waiting } = useWaiting()
  const now = useNow(500)

  if (!match || match.phase !== 'LIVE' || waiting) return null

  const yourSeat = match.yourSeat
  const toAct = match.toActSeat
  // The `your_turn` frame is the authoritative "it's you" signal — trust it even when
  // toActSeat/yourSeat haven't caught up (yourSeat is filled by a separate REST refresh,
  // so it can still be undefined the instant the turn frame lands).
  const mine = yourTurn != null || (toAct != null && yourSeat != null && toAct === yourSeat)

  if (mine) {
    const remaining = yourTurn ? Math.max(0, yourTurn.deadline - now) : null
    return (
      <div className="turn-banner turn-banner--you" role="status" aria-live="polite">
        <span className="turn-banner-label">Your turn</span>
        <span className="turn-banner-sub">
          choose an action below ↓
          {/* aria-hidden: the countdown ticks every 500ms — keeping it out of the live region
              stops screen readers from re-announcing the whole banner twice a second. */}
          {remaining != null && (
            <span aria-hidden="true">{` · ${Math.ceil(remaining / 1000)}s left`}</span>
          )}
        </span>
      </div>
    )
  }

  if (toAct == null) return null // between streets and not your turn — nobody to name

  const folded = match.seats.find((s) => s.seat === yourSeat)?.folded
  const alias = seatAlias(toAct, yourSeat)
  return (
    <div className="turn-banner turn-banner--other" role="status" aria-live="polite">
      <span className="turn-banner-label">
        {alias} to act
        <span className="turn-banner-dots" aria-hidden="true"><i /><i /><i /></span>
      </span>
      <span className="turn-banner-sub">
        {folded ? 'you folded — watching the hand' : 'waiting on their move'}
      </span>
    </div>
  )
}
