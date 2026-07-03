import { useGameStore } from '@/store/gameStore'
import { formatChips } from '@/lib/format'
import { seatAlias } from '@/lib/seats'
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
  const { active: waiting } = useWaiting()

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
  const roundCount = terms?.roundCount ?? match.round
  const token = terms?.chipsToken ?? 'USDC'
  const label = live ? `Round ${match.round} of ${roundCount}` : PHASE_COPY[match.phase]

  // Whose move it is, phrased from your side of the felt.
  const toAct =
    live && match.toActSeat != null
      ? match.toActSeat === match.yourSeat
        ? 'Your move'
        : `${seatAlias(match.toActSeat, match.yourSeat)} to act`
      : null

  return (
    <div>
      <div className={`round panel round--${match.phase.toLowerCase()}`}>
        <div className="round-head">
          <span className="eyebrow">{PHASE_COPY[match.phase]}</span>
          {live && roundCount > 1 && (
            <span className="round-pips" aria-label={label}>
              {Array.from({ length: roundCount }, (_, i) => (
                <i key={i} className={i < match.round ? 'round-pip round-pip--done' : 'round-pip'} />
              ))}
            </span>
          )}
        </div>
        <div className="round-label">{label}</div>
        {toAct && <div className="round-toact eyebrow">{toAct}</div>}
        <div className="round-prices mono">
          <span>pot {formatChips(match.pot)} {token}</span>
          <span>bet {formatChips(match.currentBet)} {token}</span>
        </div>
      </div>
    </div>
  )
}
