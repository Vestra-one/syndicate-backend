import { useEffect, useRef, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { addFibs, adoptServerFibs, levelOf, readStats } from '@/lib/sessionStats'
import { getFibsBoard, reportFibs } from '@/lib/api'
import { playCue } from '@/lib/sound'
import { useNow } from '@/lib/useNow'

const WINDOW_MS = 12_000
const BASE_FIBS = 10

type Pick = { dir: 'up' | 'down'; entry: number; endsAt: number }
type Outcome = { won: boolean | null; fibs: number; move: number; until: number }

/**
 * Quick call — something to play while the table makes you wait. Call the next twelve
 * seconds of the market, higher or lower; right calls pay Fibs, and a streak multiplies
 * them. Fibs set your level. It never touches your chips or your sealed call.
 */
export function QuickCall() {
  const wallet = useGameStore((s) => s.walletAddress)
  const price = useGameStore((s) => s.priceHistory.at(-1)?.price ?? null)
  const phase = useGameStore((s) => s.match?.phase)
  const seated = useGameStore((s) => s.match?.yourSeat != null || s.seated)
  const myTurn = useGameStore((s) => s.yourTurn != null)
  const settled = useGameStore((s) => s.settlement != null || s.voided != null)
  const now = useNow(250)
  const [pick, setPick] = useState<Pick | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [streak, setStreak] = useState(0)
  const [fibs, setFibs] = useState(() => readStats(wallet).fibs ?? 0)
  const priceRef = useRef(price)
  priceRef.current = price

  useEffect(() => {
    setFibs(readStats(wallet).fibs ?? 0)
    if (!wallet) return
    // Your level follows you: pick up the server's total when it is ahead of this device.
    void getFibsBoard(wallet)
      .then((b) => { if (b.you) setFibs(adoptServerFibs(wallet, b.you.fibs).fibs ?? 0) })
      .catch(() => {})
  }, [wallet])

  // Resolve the open call when its window runs out.
  useEffect(() => {
    if (!pick || now < pick.endsAt) return
    const last = priceRef.current
    if (last == null) return
    const move = last - pick.entry
    const won = move === 0 ? null : (move > 0) === (pick.dir === 'up')
    const nextStreak = won ? streak + 1 : won === false ? 0 : streak
    const earned = won ? BASE_FIBS * Math.min(nextStreak, 5) : 0
    if (earned > 0) {
      setFibs(addFibs(wallet, earned).fibs ?? 0)
      void reportFibs(earned).catch(() => {})
    }
    setStreak(nextStreak)
    setOutcome({ won, fibs: earned, move, until: Date.now() + 2600 })
    setPick(null)
    if (won != null) playCue(won ? 'chip' : 'tick')
  }, [now, pick, streak, wallet])

  useEffect(() => {
    if (outcome && now >= outcome.until) setOutcome(null)
  }, [now, outcome])

  const waiting = seated && !settled && (phase === 'FILLING' || phase === 'SEALING' || phase === 'LIVE')
  if (!waiting || price == null) return null
  // Your turn comes first: an open call keeps running, but nothing new is offered.
  if (myTurn && !pick && !outcome) return null

  const lvl = levelOf(fibs)
  const left = pick ? Math.max(0, Math.ceil((pick.endsAt - now) / 1000)) : 0
  const delta = pick ? price - pick.entry : 0
  const ahead = pick ? (delta > 0) === (pick.dir === 'up') && delta !== 0 : false
  const start = (dir: 'up' | 'down') => setPick({ dir, entry: price, endsAt: Date.now() + WINDOW_MS })
  const money = (v: number) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div className="quick-call panel">
      <div className="quick-call-head">
        <span className="eyebrow">quick call</span>
        <span className="quick-call-level" title={`${fibs} Fibs — ${lvl.span - lvl.into} to the next level`}>
          Lv {lvl.level} · {lvl.title}
        </span>
      </div>
      <div className="quick-call-bar" aria-hidden="true"><span style={{ width: `${Math.round((lvl.into / lvl.span) * 100)}%` }} /></div>

      {outcome ? (
        <div className={`quick-call-result quick-call-result--${outcome.won ? 'win' : outcome.won === false ? 'loss' : 'push'}`}>
          {outcome.won ? `Right — +${outcome.fibs} Fibs` : outcome.won === false ? 'Wrong way' : 'Flat — no call'}
          <small>{outcome.move >= 0 ? '+' : '−'}${money(outcome.move)}{outcome.won && streak >= 2 ? ` · ${streak} in a row` : ''}</small>
        </div>
      ) : pick ? (
        <div className={`quick-call-live ${ahead ? 'quick-call-live--ahead' : delta !== 0 ? 'quick-call-live--behind' : ''}`}>
          <b>{pick.dir === 'up' ? 'Higher' : 'Lower'}</b> in {left}s
          <small>{delta >= 0 ? '+' : '−'}${money(delta)} so far</small>
        </div>
      ) : (
        <>
          <div className="quick-call-ask">Where is the market in 12 seconds?</div>
          <div className="quick-call-btns">
            <button type="button" className="quick-call-btn quick-call-btn--up" onClick={() => start('up')}>Higher</button>
            <button type="button" className="quick-call-btn quick-call-btn--down" onClick={() => start('down')}>Lower</button>
          </div>
          <div className="quick-call-foot eyebrow">
            {streak >= 1 ? `${streak} in a row · next pays ${BASE_FIBS * Math.min(streak + 1, 5)} Fibs` : `pays ${BASE_FIBS} Fibs · streaks pay more`}
          </div>
        </>
      )}
    </div>
  )
}
