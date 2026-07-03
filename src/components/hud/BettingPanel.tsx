import { useEffect, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { useNow } from '@/lib/useNow'
import { formatChips, formatClock } from '@/lib/format'
import { seatAlias } from '@/lib/seats'
import type { BettingAction } from '@/lib/protocol'
import { useWaiting } from './WaitingRoom'

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
  const { active: waiting } = useWaiting()

  const phase = match?.phase

  // Pre-game you may lock in your prediction early; once sealed, a calm "you're set" state.
  if (phase === 'SEALING' || (waiting && sealStatus === 'unsealed')) {
    return <SealPanel />
  }
  if (waiting) return <SealedWaitingPanel />
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

/** Prediction locked, table still filling — reassure and set expectations, no dead "waiting…". */
function SealedWaitingPanel() {
  return (
    <div className="betpanel panel">
      <div className="betpanel-head">
        <span className="panel-title">Prediction sealed</span>
        <span className="seal-lock" aria-hidden="true">🔒</span>
      </div>
      <p className="seal-note eyebrow">
        Your call is time-locked on your device. It stays secret from everyone —
        including the server — until the hand ends. The table begins once it fills.
      </p>
    </div>
  )
}

/**
 * Not your move — say WHO the table is waiting on instead of a dead
 * "waiting…" (your own stack/committed already live in YourPosition, so
 * repeating them here was pure noise).
 */
function WaitingPanel() {
  const toActSeat = useGameStore((s) => s.match?.toActSeat)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  const alias = toActSeat != null ? seatAlias(toActSeat, yourSeat) : null
  return (
    <div className="betpanel panel">
      <div className="panel-title">Live</div>
      <div className="betpanel-locked eyebrow">
        {alias ? `${alias} is deciding…` : 'waiting for the next turn…'}
      </div>
    </div>
  )
}

function ActionPanel() {
  const match = useGameStore((s) => s.match)!
  const yourTurn = useGameStore((s) => s.yourTurn)!
  const act = useGameStore((s) => s.act)
  const terms = useGameStore((s) => s.terms)
  const now = useNow()

  const token = terms?.chipsToken ?? 'USDC'
  const stack = match.yourStack ?? 0
  const exposure = match.yourExposure ?? 0
  const { toCall, minRaiseTo, deadline } = yourTurn
  const remaining = Math.max(0, deadline - now)

  // raiseTo is kept in token base units (what the engine speaks); the input
  // edits it in whole-token terms so the player types "0.02", never "20000".
  const [raiseTo, setRaiseTo] = useState(minRaiseTo)
  useEffect(() => setRaiseTo(minRaiseTo), [minRaiseTo])
  const step = terms?.bigBlind ?? 10_000

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
        <Exposure label="to call" value={toCall} token={token} accent />
        <Exposure label="committed" value={exposure} token={token} />
        <Exposure label="stack" value={stack} token={token} />
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
            Call {formatChips(toCall)}
          </button>
        )}
        <button className="pk-btn pk-allin" onClick={() => send({ type: 'allIn' })}>
          All-in {formatChips(stack)}
        </button>
      </div>

      {canRaise && (
        <div className="raise-row">
          <input
            className="raise-input mono"
            type="number"
            min={minRaiseTo / 1e6}
            step={step / 1e6}
            value={raiseTo / 1e6}
            onChange={(e) => setRaiseTo(Math.round(Number(e.target.value) * 1e6))}
          />
          <button
            className="pk-btn pk-raise"
            onClick={() => send({ type: 'raiseTo', amount: raiseTo })}
            disabled={!raiseValid}
          >
            Raise to {formatChips(raiseTo)}
          </button>
        </div>
      )}
    </div>
  )
}

function Exposure({ label, value, token, accent }: { label: string; value: number; token: string; accent?: boolean }) {
  return (
    <div className="exposure-item">
      <span className="eyebrow">{label}</span>
      <span className={`mono exposure-value ${accent ? 'exposure-value--accent' : ''}`}>
        {formatChips(value)} <span className="exposure-token">{token}</span>
      </span>
    </div>
  )
}
