import { useGameStore } from '@/store/gameStore'
import type { MatchPhase } from '@/lib/protocol'
import { useWaiting, WaitingStake } from './WaitingRoom'

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

  // Pre-game: "pot 0 / current bet 0" is meaningless — show the committed-stake recap instead.
  if (waiting) return <WaitingStake />

  if (!match) {
    return (
      <div className="round panel">
        <span className="eyebrow">match</span>
        <div className="round-label">Waiting for the table…</div>
      </div>
    )
  }

  const label =
    match.phase === 'LIVE'
      ? `Round ${match.round} of ${terms?.roundCount ?? match.round}`
      : PHASE_COPY[match.phase]

  return (
    <div>
      <div className={`round panel round--${match.phase.toLowerCase()}`}>
        <div className="round-head">
          <span className="eyebrow">{PHASE_COPY[match.phase]}</span>
          <span className="round-clock mono">{match.pot}</span>
        </div>
        <div className="round-label">{label}</div>
        <div className="round-prices mono">
          <span>pot {match.pot}</span>
          <span>current bet {match.currentBet}</span>
        </div>
      </div>
    </div>
  )
}
