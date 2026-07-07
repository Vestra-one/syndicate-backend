import { useGameStore } from '@/store/gameStore'
import { formatChips, formatCountdown } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import type { MatchPhase } from '@/lib/protocol'
import { useWaiting } from './WaitingRoom'

const PHASE_COPY: Record<MatchPhase, string> = {
  FILLING: 'Filling table',
  SEALING: 'Sealing predictions',
  LIVE: 'Live',
  SETTLEMENT_WINDOW: 'Settlement window',
  DECRYPT: 'Opening time-lock',
  SETTLED: 'Settled',
  VOID: 'Voided',
}

/**
 * Match lifecycle + pot at a glance. Resolution (the settled/void ceremony with
 * claim/refund) is a separate full-screen overlay (Resolution.tsx, §10.6).
 */
export function RoundStatus() {
  const match = useGameStore((s) => s.match)
  const terms = useGameStore((s) => s.terms)
  const schedule = useGameStore((s) => s.streetSchedule)
  const { active: waiting } = useWaiting()
  const now = useNow(500)

  // Pre-game: the full-surface waiting console (WaitingRoom) owns this state; the
  // footer is suppressed by the HUD while filling, so there's nothing to show here.
  if (waiting) return null

  if (!match) {
    return (
      <div className="round panel">
        <span className="eyebrow">match</span>
        <div className="round-label">Waiting for the table…</div>
      </div>
    )
  }

  const live = match.phase === 'LIVE'
  const token = terms?.chipsToken ?? 'USDC'
  // Streets advance purely on the schedule fixed at lock, so the schedule is the honest
  // round clock — the server's `round` field drifts out of sync with it on devnet (seen
  // frozen at 1 while the schedule was in street 3, and seen leading past the final street,
  // which produced the impossible "Round 4 of 3"), and no WS frame marks the transition.
  // When we have a schedule, trust it for BOTH the total and the current round, and never
  // let either overflow it.
  const roundCount = live && schedule?.length ? schedule.length : (terms?.roundCount ?? match.round)
  const scheduleRound =
    live && schedule?.length
      ? ((schedule.find((e) => now < e.end) ?? schedule[schedule.length - 1]).street + 1)
      : 0
  const round = Math.min(roundCount, Math.max(match.round, scheduleRound))
  const label = live ? `Round ${round} of ${roundCount}` : PHASE_COPY[match.phase]

  // Whose-move-it-is lives solely in the top TurnBanner now — this card is the
  // calm round/pot reference, so it no longer repeats the turn (was a third,
  // redundant "Your move" competing with the banner and the action panel).

  // Streets advance on the server's street schedule, not on betting — so a matched pot
  // with nobody to act is a WAIT, not a stall. Count the window down so it reads that way.
  let clock: string | null = null
  if (live && schedule) {
    const cur = schedule.find((e) => now < e.end)
    if (cur) {
      clock = now < cur.close
        ? `betting closes in ${formatCountdown(cur.close - now)}`
        : `observing price — round ends in ${formatCountdown(cur.end - now)}`
    }
  }

  return (
    <div>
      <div className={`round panel round--${match.phase.toLowerCase()}`}>
        <div className="round-head">
          <span className="eyebrow">{PHASE_COPY[match.phase]}</span>
          {live && roundCount > 1 && (
            <span className="round-pips" aria-label={label}>
              {Array.from({ length: roundCount }, (_, i) => (
                <i key={i} className={i < round ? 'round-pip round-pip--done' : 'round-pip'} />
              ))}
            </span>
          )}
        </div>
        <div className="round-label">{label}</div>
        {clock && <div className="round-toact eyebrow mono">{clock}</div>}
        <div className="round-prices mono">
          <span>pot {formatChips(match.pot)} {token}</span>
          <span>bet {formatChips(match.currentBet)} {token}</span>
        </div>
      </div>
    </div>
  )
}
