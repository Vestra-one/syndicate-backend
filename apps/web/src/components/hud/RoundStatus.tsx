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
  const sealDeadline = useGameStore((s) => s.sealDeadline)
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
  // The street the CLOCK is in. The engine's own round runs ahead of it: the moment a
  // street's betting completes it advances, while the next street only opens on schedule.
  // Showing the engine round here produced "Round 2 of 2 · betting closes in 0:24" while
  // the banner said round 2 had not opened — the title and the countdown were about
  // different rounds.
  const cur = live && schedule?.length ? (schedule.find((e) => now < e.end) ?? schedule[schedule.length - 1]) : null
  const round = cur ? Math.min(roundCount, cur.street + 1) : Math.min(roundCount, match.round)
  const label = live ? `Round ${round} of ${roundCount}` : PHASE_COPY[match.phase]

  // Streets advance on the schedule, not on betting — so a finished street is a WAIT with
  // a known end, not a stall. Always say what is being waited for and for how long.
  let clock: string | null = null
  if (cur) {
    const bettingDone = match.round > round || now >= cur.close
    const next = schedule?.[cur.street + 1]
    if (!bettingDone) clock = `betting closes in ${formatCountdown(cur.close - now)}`
    else if (next) clock = `betting done · round ${round + 1} opens in ${formatCountdown(next.open - now)}`
    else clock = `betting done · price settles in ${formatCountdown(cur.end - now)}`
  } else if (match.phase === 'SEALING' && sealDeadline != null && sealDeadline > now) {
    clock = `betting starts in ${formatCountdown(sealDeadline - now)}`
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
