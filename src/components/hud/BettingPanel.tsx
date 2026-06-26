import { useEffect, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { useNow } from '@/lib/useNow'
import { formatClock } from '@/lib/format'
import type { BettingAction } from '@/lib/protocol'

/**
 * The action surface. Its contents follow the match phase:
 *   SEALING -> seal your secret prediction (once, §6)
 *   LIVE + your turn -> legal poker actions with exposure shown first (§10.1)
 * Resolution (claim/refund) lives in RoundStatus.
 */
export function BettingPanel() {
  const match = useGameStore((s) => s.match)
  const terms = useGameStore((s) => s.terms)
  const sealStatus = useGameStore((s) => s.sealStatus)
  const yourTurn = useGameStore((s) => s.yourTurn)

  const phase = match?.phase

  if (phase === 'SEALING' || (phase === 'FILLING' && sealStatus === 'unsealed')) {
    return <SealPanel />
  }
  if (phase === 'LIVE') {
    return yourTurn ? <ActionPanel /> : <WaitingPanel />
  }
  return (
    <div className="betpanel panel">
      <div className="panel-title">Table</div>
      <div className="betpanel-locked eyebrow">
        {phaseHint(phase) || (terms ? 'waiting for the table…' : 'connecting…')}
      </div>
    </div>
  )
}

function phaseHint(phase: string | undefined): string | null {
  switch (phase) {
    case 'FILLING':
      return 'seats filling…'
    case 'SETTLEMENT_WINDOW':
      return 'sampling the settlement price…'
    case 'DECRYPT':
      return 'opening the time-lock…'
    case 'SETTLED':
      return 'match settled'
    case 'VOID':
      return 'match voided'
    default:
      return null
  }
}

function SealPanel() {
  const terms = useGameStore((s) => s.terms)
  const sealStatus = useGameStore((s) => s.sealStatus)
  const lastPrice = useGameStore((s) => s.priceHistory.at(-1)?.price ?? null)
  const seal = useGameStore((s) => s.sealPrediction)
  const [text, setText] = useState('')

  // seed the input with the live price once
  useEffect(() => {
    if (text === '' && lastPrice != null) setText(lastPrice.toFixed(terms?.decimals ?? 2))
  }, [lastPrice, terms, text])

  const decimals = terms?.decimals ?? 2
  const value = Number(text)
  const valid = Number.isFinite(value) && value > 0
  const sealing = sealStatus === 'sealing'

  const submit = () => {
    if (!valid || sealing) return
    seal(Math.round(value * 10 ** decimals))
  }

  return (
    <div className="betpanel panel">
      <div className="betpanel-head">
        <span className="panel-title">Seal your prediction</span>
        <span className="eyebrow">{terms?.priceFeedId ?? 'BTC/USD'} at match end</span>
      </div>
      <p className="seal-note eyebrow">
        Encrypted on your device — no one, not even the server, can read it until the match ends.
      </p>
      <div className="seal-input-row">
        <span className="seal-currency mono">$</span>
        <input
          className="seal-input mono"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="price"
        />
      </div>
      <button className="seal-btn" onClick={submit} disabled={!valid || sealing}>
        {sealing ? 'Sealing…' : 'Seal prediction'}
      </button>
    </div>
  )
}

function WaitingPanel() {
  const exposure = useGameStore((s) => s.match?.yourExposure ?? 0)
  const stack = useGameStore((s) => s.match?.yourStack ?? 0)
  return (
    <div className="betpanel panel">
      <div className="panel-title">Live</div>
      <div className="betpanel-locked eyebrow">waiting for your turn…</div>
      <div className="exposure">
        <Exposure label="committed" value={exposure} />
        <Exposure label="stack" value={stack} />
      </div>
    </div>
  )
}

function ActionPanel() {
  const match = useGameStore((s) => s.match)!
  const yourTurn = useGameStore((s) => s.yourTurn)!
  const act = useGameStore((s) => s.act)
  const now = useNow()

  const stack = match.yourStack ?? 0
  const exposure = match.yourExposure ?? 0
  const { toCall, minRaiseTo, deadline } = yourTurn
  const remaining = Math.max(0, deadline - now)

  const [raiseTo, setRaiseTo] = useState(minRaiseTo)
  useEffect(() => setRaiseTo(minRaiseTo), [minRaiseTo])

  const send = (action: BettingAction) => act(action)
  const canRaise = stack > toCall
  const raiseValid = raiseTo >= minRaiseTo && raiseTo - match.currentBet <= stack

  return (
    <div className="betpanel panel">
      <div className="betpanel-head">
        <span className="panel-title">Your turn</span>
        <span className="round-clock mono">{formatClock(remaining)}</span>
      </div>

      <div className="exposure">
        <Exposure label="to call" value={toCall} accent />
        <Exposure label="committed" value={exposure} />
        <Exposure label="stack" value={stack} />
      </div>

      <div className="poker-actions">
        <button className="pk-btn pk-fold" onClick={() => send({ type: 'fold' })}>
          Fold
        </button>
        {toCall === 0 ? (
          <button className="pk-btn pk-call" onClick={() => send({ type: 'check' })}>
            Check
          </button>
        ) : (
          <button
            className="pk-btn pk-call"
            onClick={() => send({ type: 'call' })}
            disabled={stack === 0}
          >
            Call {toCall}
          </button>
        )}
        <button className="pk-btn pk-allin" onClick={() => send({ type: 'allIn' })}>
          All-in {stack}
        </button>
      </div>

      {canRaise && (
        <div className="raise-row">
          <input
            className="raise-input mono"
            type="number"
            min={minRaiseTo}
            value={raiseTo}
            onChange={(e) => setRaiseTo(Number(e.target.value))}
          />
          <button
            className="pk-btn pk-raise"
            onClick={() => send({ type: 'raiseTo', amount: raiseTo })}
            disabled={!raiseValid}
          >
            Raise to {raiseTo}
          </button>
        </div>
      )}
    </div>
  )
}

function Exposure({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="exposure-item">
      <span className="eyebrow">{label}</span>
      <span className={`mono exposure-value ${accent ? 'exposure-value--accent' : ''}`}>{value}</span>
    </div>
  )
}
