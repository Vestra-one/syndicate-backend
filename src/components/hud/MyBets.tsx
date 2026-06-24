import { useGameStore } from '@/store/gameStore'
import { formatAmount } from '@/lib/format'

export function MyBets() {
  const bets = useGameStore((s) => s.myBets)
  const recent = [...bets].reverse().slice(0, 6)

  return (
    <div className="mybets panel">
      <div className="panel-title">Your bets</div>
      {recent.length === 0 ? (
        <div className="mybets-empty eyebrow">no bets yet — pick a side</div>
      ) : (
        <ul className="mybets-list">
          {recent.map((b) => {
            const state = b.won == null ? 'pending' : b.won ? 'won' : 'lost'
            return (
              <li key={b.id} className={`mybets-row mybets-row--${state}`}>
                <span className={`tag tag--${b.direction.toLowerCase()}`}>{b.direction}</span>
                <span className="mono">{formatAmount(b.amount, '')}</span>
                <span className={`mybets-result mono ${state}`}>
                  {b.won == null
                    ? '…'
                    : b.won
                      ? `+${Math.round(b.payout ?? 0)}`
                      : '—'}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
