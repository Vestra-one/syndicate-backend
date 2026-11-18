import { useEffect, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { getFibsBoard, type FibsBoard as Board } from '@/lib/api'
import { levelOf } from '@/lib/sessionStats'

/** Today's Fibs board: who has played and called best today, bots included and labelled. */
export function FibsBoard() {
  const wallet = useGameStore((s) => s.walletAddress)
  const [board, setBoard] = useState<Board | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => void getFibsBoard(wallet).then((b) => { if (alive) setBoard(b) }).catch(() => {})
    load()
    const t = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [wallet])
  if (!board) return null
  const name = (l: Board['leaders'][number]) => l.handle?.replace(/_/g, ' ') ?? `${l.wallet.slice(0, 4)}…${l.wallet.slice(-4)}`
  return (
    <div className="rail-panel">
      <div className="panel-eyebrow">
        <span className="eyebrow">today's fibs</span>
        {board.you && <span className="fibs-you">you · #{board.you.rank} · Lv {levelOf(board.you.fibs).level}</span>}
      </div>
      {board.leaders.length === 0 ? (
        <div className="lb-empty">Nobody has played today. The first hand takes the top spot.</div>
      ) : (
        <ol className="fibs-list">
          {board.leaders.slice(0, 8).map((l) => (
            <li key={l.wallet} className={`fibs-row ${l.wallet === wallet ? 'fibs-row--you' : ''}`}>
              <span className="fibs-rank mono">{l.rank}</span>
              <span className="fibs-name">
                {l.wallet === wallet ? 'You' : name(l)}
                {l.bot && <small> bot</small>}
              </span>
              <span className="fibs-amt mono">{l.fibs.toLocaleString('en-US')}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="fibs-foot eyebrow">20 a hand · 50 for the pot · quick calls pay too</div>
    </div>
  )
}
