import { useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { formatAmount } from '@/lib/format'
import type { Direction } from '@/lib/types'

const CHIPS = [10, 25, 100, 250]

export function BettingPanel() {
  const round = useGameStore((s) => s.round)
  const wallet = useGameStore((s) => s.wallet)
  const placeBet = useGameStore((s) => s.placeBet)
  const [amount, setAmount] = useState(25)

  const open = round?.phase === 'OPEN'
  const canBet = open && amount > 0 && amount <= wallet.balance

  const bet = (direction: Direction) => {
    if (!canBet) return
    placeBet(direction, amount)
  }

  const pool = round?.pool ?? { UP: 0, DOWN: 0 }
  const total = pool.UP + pool.DOWN
  const pct = (side: Direction) => (total > 0 ? Math.round((pool[side] / total) * 100) : 50)

  return (
    <div className="betpanel panel">
      <div className="betpanel-head">
        <span className="panel-title">Your stake</span>
        <span className="betpanel-amount mono">{formatAmount(amount, wallet.currency)}</span>
      </div>

      <div className="chips">
        {CHIPS.map((c) => (
          <button
            key={c}
            className={`chip ${amount === c ? 'chip--active' : ''}`}
            onClick={() => setAmount(c)}
            disabled={c > wallet.balance}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="bet-actions">
        <button
          className="bet-btn bet-btn--down"
          onClick={() => bet('DOWN')}
          disabled={!canBet}
        >
          <span className="bet-btn-dir">DOWN</span>
          <span className="bet-btn-pct mono">{pct('DOWN')}%</span>
        </button>
        <button className="bet-btn bet-btn--up" onClick={() => bet('UP')} disabled={!canBet}>
          <span className="bet-btn-dir">UP</span>
          <span className="bet-btn-pct mono">{pct('UP')}%</span>
        </button>
      </div>

      {!open && <div className="betpanel-locked eyebrow">betting is closed</div>}
    </div>
  )
}
