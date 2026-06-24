import { useGameStore } from '@/store/gameStore'
import { useNow } from '@/lib/useNow'
import { formatClock, formatPrice } from '@/lib/format'
import type { RoundPhase } from '@/lib/types'

const PHASE_COPY: Record<RoundPhase, { label: string; sub: string }> = {
  OPEN: { label: 'Place your bets', sub: 'closes in' },
  LOCKED: { label: 'Bets locked', sub: 'settles in' },
  SETTLED: { label: 'Round settled', sub: 'next round' },
}

export function RoundStatus() {
  const round = useGameStore((s) => s.round)
  const now = useNow()

  if (!round) {
    return (
      <div className="round panel">
        <span className="eyebrow">round</span>
        <div className="round-label">Waiting for the table…</div>
      </div>
    )
  }

  const copy = PHASE_COPY[round.phase]
  const target =
    round.phase === 'OPEN' ? round.locksAt : round.phase === 'LOCKED' ? round.settlesAt : round.settlesAt
  const remaining = Math.max(0, target - now)
  const span = round.locksAt - round.opensAt
  const progress =
    round.phase === 'OPEN' ? 1 - Math.min(1, (round.locksAt - now) / span) : 1

  return (
    <div className={`round panel round--${round.phase.toLowerCase()}`}>
      <div className="round-head">
        <span className="eyebrow">{copy.sub}</span>
        <span className="round-clock mono">{formatClock(remaining)}</span>
      </div>
      <div className="round-label">{copy.label}</div>

      <div className="round-bar">
        <div className="round-bar-fill" style={{ transform: `scaleX(${progress})` }} />
      </div>

      {round.phase !== 'OPEN' && round.lockPrice != null && (
        <div className="round-prices mono">
          <span>lock {formatPrice(round.lockPrice)}</span>
          {round.settlePrice != null && (
            <span className={round.result === 'UP' ? 'up' : 'down'}>
              {round.result} {formatPrice(round.settlePrice)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
