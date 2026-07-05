import { useEffect, useMemo, useRef, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { useNow } from '@/lib/useNow'
import { formatChips, formatCountdown } from '@/lib/format'
import { seatAlias } from '@/lib/seats'
import type { BettingAction } from '@/lib/protocol'
import { TimerRing } from './TimerRing'
import { useWaiting } from './WaitingRoom'
import { useRoundGate } from './useRoundGate'

/** A pre-selected action armed while it's not your turn — auto-fires when the turn lands (§13.3). */
type Armed = 'fold' | 'check_call' | null

/**
 * The action surface. Its contents follow the match phase:
 *   SEALING -> seal your secret prediction (once, §6)
 *   LIVE + your turn -> legal poker actions with exposure shown first (§10.1)
 * Resolution (claim/refund) lives in RoundStatus.
 *
 * The pre-action queue (arm Fold / Check-or-Call while waiting) is owned here so
 * the choice survives the WaitingPanel → ActionPanel swap when your turn opens.
 */
export function BettingPanel() {
  const match = useGameStore((s) => s.match)
  const terms = useGameStore((s) => s.terms)
  const sealStatus = useGameStore((s) => s.sealStatus)
  const sealClosed = useGameStore((s) => s.sealClosed)
  const queued = useGameStore((s) => s.queuedPrediction)
  const yourTurn = useGameStore((s) => s.yourTurn)
  const act = useGameStore((s) => s.act)
  const { active: waiting } = useWaiting()
  const gate = useRoundGate()

  const [armed, setArmed] = useState<Armed>(null)

  // The turn just opened and something is armed: fire it once, then disarm. Held while
  // the round's betting window is still closed — the server rejects acts in that gap.
  const firedFor = useRef<number | null>(null)
  useEffect(() => {
    if (!yourTurn || !armed || !gate.open) return
    if (firedFor.current === yourTurn.deadline) return
    firedFor.current = yourTurn.deadline
    if (armed === 'fold') act({ type: 'fold' })
    else act(yourTurn.toCall === 0 ? { type: 'check' } : { type: 'call' })
    setArmed(null)
  }, [yourTurn, armed, act, gate.open])

  const phase = match?.phase

  // Pre-game you may lock in your prediction early; once sealed, a calm "you're set" state.
  if (phase === 'SEALING' || waiting) {
    if (sealStatus === 'sealed') return <SealedWaitingPanel />
    if (phase === 'SEALING' && sealClosed) return <SealClosedPanel />
    if (waiting && queued != null) return <QueuedPanel />
    return <SealPanel waiting={waiting && phase !== 'SEALING'} />
  }
  if (phase === 'LIVE') {
    // Turn assigned but the round's wall-clock window hasn't opened: acting now would be
    // rejected ("betting_closed"), so present the queued state instead of live buttons.
    if (yourTurn && !gate.open && gate.opensAt != null) {
      return <RoundGapPanel round={gate.round} opensAt={gate.opensAt} />
    }
    return yourTurn ? <ActionPanel /> : <WaitingPanel armed={armed} setArmed={setArmed} />
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

/** Your turn is queued but the round's betting window hasn't opened yet. */
function RoundGapPanel({ round, opensAt }: { round: number; opensAt: number }) {
  const now = useNow(500)
  return (
    <div className="betpanel panel">
      <div className="betpanel-head">
        <span className="panel-title">Live</span>
        <span className="betpanel-locked eyebrow">round {round} betting hasn’t opened yet</span>
      </div>
      <p className="seal-note eyebrow">
        Your turn is queued — betting opens in{' '}
        <b className="mono">{formatCountdown(Math.max(0, opensAt - now))}</b>. Nothing to do until then.
      </p>
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

// ---------------------------------------------------------------------------
// Seal window
// ---------------------------------------------------------------------------

/** The relative offsets the quick-chips set the call to, around the live price. */
const SEAL_OFFSETS = [-0.01, -0.005, 0, 0.005, 0.01] as const
const offsetLabel = (o: number) => (o === 0 ? 'now' : `${o > 0 ? '+' : ''}${(o * 100).toFixed(o % 0.01 === 0 ? 0 : 1)}%`)

/** How far off spot a sealed call may sit before we block it as a fat-finger (§14.4). */
const SEAL_BOUND = 0.5

function SealPanel({ waiting }: { waiting?: boolean }) {
  const terms = useGameStore((s) => s.terms)
  const sealStatus = useGameStore((s) => s.sealStatus)
  const lastPrice = useGameStore((s) => s.priceHistory.at(-1)?.price ?? null)
  const sealDeadline = useGameStore((s) => s.sealDeadline)
  const seal = useGameStore((s) => s.sealPrediction)
  // Seal failures set `playError`, but that toast only renders in the Lobby/Dashboard —
  // in-match it would vanish, making a failed seal look like a dead button. Surface it here.
  const sealError = useGameStore((s) => s.playError)
  const [text, setText] = useState('')
  const now = useNow(500)

  // seed the input with the live price once
  useEffect(() => {
    if (text === '' && lastPrice != null) setText(lastPrice.toFixed(terms?.decimals ?? 2))
  }, [lastPrice, terms, text])

  const decimals = terms?.decimals ?? 2
  const value = Number(text)
  const finite = Number.isFinite(value) && value > 0
  const sealing = sealStatus === 'sealing'

  // Instant click feedback: `sealStatus` only flips to 'sealing' after the async guard
  // passes (round ready, wallet prompt, …), which can lag a click or never happen if the
  // call just queues. A local `busy` flag set synchronously on click makes the button
  // respond immediately; the store's own state takes over as soon as it moves.
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!busy) return
    // Store took over (sealing/sealed) or surfaced a message — let those drive the UI now.
    if (sealStatus !== 'unsealed' || sealError) { setBusy(false); return }
    const t = setTimeout(() => setBusy(false), 6000) // safety release if nothing moved
    return () => clearTimeout(t)
  }, [busy, sealStatus, sealError])
  const working = busy || sealing

  // Validation: sane bounds around spot so an absurd call can't be sealed by mistake.
  const outOfBounds =
    finite && lastPrice != null && Math.abs(value - lastPrice) > lastPrice * SEAL_BOUND
  const valid = finite && !outOfBounds
  const error = !finite && text !== '' ? 'Enter a price above 0.' : outOfBounds ? `Too far from market — stay within ±${SEAL_BOUND * 100}% of ${lastPrice?.toLocaleString('en-US', { maximumFractionDigits: decimals })}.` : null

  const delta = finite && lastPrice != null ? value - lastPrice : null

  // Seal-window clock (the deadline that voids your prediction) — the last 10s warn amber.
  const remaining = sealDeadline != null ? Math.max(0, sealDeadline - now) : null
  const closingSoon = remaining != null && remaining <= 10_000 && remaining > 0

  const setOffset = (o: number) => {
    if (lastPrice == null) return
    setText((lastPrice * (1 + o)).toFixed(decimals))
  }

  const submit = () => {
    if (!valid || working) return
    setBusy(true)
    if (sealError) useGameStore.setState({ playError: null }) // clear stale message for a clean attempt
    seal(Math.round(value * 10 ** decimals))
  }

  return (
    <div className={`betpanel panel seal-panel ${closingSoon ? 'seal-panel--closing' : ''} ${working ? 'seal-panel--sealing' : ''}`}>
      <div className="betpanel-head">
        <span className="panel-title">{waiting ? 'Lock in your prediction' : 'Seal your prediction'}</span>
        <span className="eyebrow">{terms?.priceFeedId ?? 'BTC/USD'} at match end</span>
      </div>

      {remaining != null && !waiting && (
        <div className={`seal-window ${closingSoon ? 'seal-window--soon' : ''}`}>
          <span className="seal-window-icon" aria-hidden="true">{closingSoon ? '⚠' : '⏳'}</span>
          Seal window closes in <b className="mono">{formatCountdown(remaining)}</b>
        </div>
      )}

      <div className="seal-input-row">
        <span className="seal-currency mono">$</span>
        <input
          className="seal-input mono"
          inputMode="decimal"
          value={text}
          onChange={(e) => { setText(e.target.value); if (sealError) useGameStore.setState({ playError: null }) }}
          placeholder="price"
          aria-label="Sealed prediction price"
          aria-invalid={!!error}
        />
      </div>

      {delta != null && !error && (
        <div className={`seal-delta ${delta >= 0 ? 'up' : 'down'}`}>
          {delta === 0 ? 'at market' : `${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${delta > 0 ? 'above' : 'below'} market`}
        </div>
      )}
      {error && <div className="seal-error">{error}</div>}
      {!error && sealError && <div className="seal-error">{sealError}</div>}

      <div className="seal-offsets">
        {SEAL_OFFSETS.map((o) => (
          <button
            key={o}
            className="seal-offset-chip"
            onClick={() => setOffset(o)}
            disabled={lastPrice == null}
            type="button"
          >
            {offsetLabel(o)}
          </button>
        ))}
      </div>

      <p className="seal-note eyebrow">
        {waiting
          ? 'Saved on your device only — it seals automatically the moment the table locks.'
          : 'Encrypted on your device — no one, not even the server, can read it until the match ends.'}
        {' '}
        <button type="button" className="seal-how seal-how--btn" title="Your call is time-lock encrypted to the match-end drand round, so it stays secret until settlement.">how it works ↗</button>
      </p>

      <button className="seal-btn" onClick={submit} disabled={!valid || working}>
        <span className="seal-btn-lock" aria-hidden="true">{working ? '⏳' : '🔒'}</span>
        {working ? 'Sealing…' : waiting ? 'Lock in prediction' : 'Seal prediction'}
      </button>

      {working && <div className="seal-ritual" aria-hidden="true"><span className="seal-wax">✦</span></div>}
    </div>
  )
}

/** A compact row of dots — one per seat — that lock as each player seals (§15.3). Anonymous. */
export function SealStatusStrip() {
  const sealed = useGameStore((s) => s.sealedSeats)
  const max = useGameStore((s) => s.terms?.maxPlayers ?? s.match?.seats.length ?? 0)
  const sealClosed = useGameStore((s) => s.sealClosed)
  const sealDeadline = useGameStore((s) => s.sealDeadline)
  const now = useNow(500)
  if (max <= 0) return null
  const count = sealed.length
  const remaining = sealDeadline != null ? Math.max(0, sealDeadline - now) : null

  return (
    <div className="seal-strip">
      <div className="seal-strip-dots">
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={`seal-dot ${i < count ? 'seal-dot--locked' : ''}`} aria-hidden="true">
            {i < count ? '🔒' : ''}
          </span>
        ))}
      </div>
      <div className="seal-strip-label eyebrow">
        {count}/{max} sealed
        {sealClosed ? ' · window closed' : remaining != null ? ` · closes ${formatCountdown(remaining)}` : ''}
      </div>
    </div>
  )
}

/** An early lock-in is queued — it seals (two quick wallet prompts) once the table locks. */
function QueuedPanel() {
  const terms = useGameStore((s) => s.terms)
  const queued = useGameStore((s) => s.queuedPrediction)
  const clear = useGameStore((s) => s.clearQueuedPrediction)
  const decimals = terms?.decimals ?? 2
  return (
    <div className="betpanel panel">
      <div className="betpanel-head">
        <span className="panel-title">Prediction locked in</span>
        <span className="seal-lock" aria-hidden="true">🕐</span>
      </div>
      <p className="seal-note eyebrow">
        {queued != null ? `$${(queued / 10 ** decimals).toFixed(decimals)} — ` : ''}
        saved on this device only. When the table locks, your wallet will ask you to confirm
        the seal (an on-chain commitment plus a signature).
      </p>
      <button className="seal-btn" onClick={clear}>Change prediction</button>
    </div>
  )
}

/** The seal window closed before this seat sealed. */
function SealClosedPanel() {
  const terms = useGameStore((s) => s.terms)
  const lastPrice = useGameStore((s) => s.priceHistory.at(-1)?.price ?? null)
  const decimals = terms?.decimals ?? 2
  const defaulted = lastPrice != null
    ? `$${lastPrice.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
    : 'the market price at seal close'
  return (
    <div className="betpanel panel seal-missed">
      <div className="betpanel-head">
        <span className="panel-title">Seal window closed</span>
        <span className="seal-lock" aria-hidden="true">⚠</span>
      </div>
      <p className="seal-note eyebrow">
        You didn’t seal in time — your prediction defaults to the market price at seal close
        ({defaulted}). You stay in the hand and can still win the pot on poker play, but you
        can’t take the prediction rank.
      </p>
      <SealStatusStrip />
    </div>
  )
}

/**
 * Prediction locked — a full reassurance card for the first 5s, then it collapses to a
 * slim bar so it stops hogging the bottom-centre for the rest of the phase (§15.5).
 */
function SealedWaitingPanel() {
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setCollapsed(true), 5000)
    return () => clearTimeout(t)
  }, [])

  if (collapsed) {
    return (
      <div className="betpanel panel seal-sealed-bar">
        <span className="seal-lock" aria-hidden="true">🔒</span>
        <span className="seal-sealed-bar-text">Prediction sealed — secret until the hand ends</span>
        <SealStatusStrip />
      </div>
    )
  }
  return (
    <div className="betpanel panel">
      <div className="betpanel-head">
        <span className="panel-title">Prediction sealed</span>
        <span className="seal-lock" aria-hidden="true">🔒</span>
      </div>
      <p className="seal-note eyebrow">
        Your call is time-locked and encrypted. It stays secret from everyone —
        including the server — until the hand ends.
      </p>
      <SealStatusStrip />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live play
// ---------------------------------------------------------------------------

/**
 * Not your move — name WHO the table is waiting on, and let you arm a Fold or
 * Check/Call that auto-fires the instant the turn reaches you (§13.3). Your own
 * stack/committed already live in YourPosition, so they aren't repeated here.
 */
function WaitingPanel({ armed, setArmed }: { armed: Armed; setArmed: (a: Armed) => void }) {
  const toActSeat = useGameStore((s) => s.match?.toActSeat)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  const seats = useGameStore((s) => s.match?.seats)
  const folded = useGameStore((s) => s.match?.seats.find((x) => x.seat === s.match?.yourSeat)?.folded)
  const alias = toActSeat != null ? seatAlias(toActSeat, yourSeat) : null
  const toggle = (a: Exclude<Armed, null>) => setArmed(armed === a ? null : a)

  // All but one player folded and nobody is to act: betting is over for good —
  // "waiting for the next turn…" would be a lie. Say what actually happens next.
  const alive = seats?.filter((x) => !x.folded).length ?? 0
  if (toActSeat == null && (seats?.length ?? 0) > 0 && alive <= 1) {
    return (
      <div className="betpanel panel">
        <div className="betpanel-head">
          <span className="panel-title">Live</span>
          <span className="betpanel-locked eyebrow">
            {folded ? 'you folded — betting is over' : 'everyone else folded — betting is over'}
          </span>
        </div>
        <p className="seal-note eyebrow">
          The match runs to its scheduled end, then settles automatically
          {folded ? '.' : ' — the pot comes to you.'}
        </p>
      </div>
    )
  }

  return (
    <div className="betpanel panel">
      <div className="betpanel-head">
        <span className="panel-title">Live</span>
        <span className="betpanel-locked eyebrow">
          {alias ? `${alias} is deciding…` : 'waiting for the next turn…'}
        </span>
      </div>
      {!folded && (
        <>
          <div className="prearm-label eyebrow">arm your next move</div>
          <div className="prearm-row">
            <button
              className={`prearm-btn prearm-fold ${armed === 'fold' ? 'prearm-btn--on' : ''}`}
              onClick={() => toggle('fold')}
            >
              Fold
            </button>
            <button
              className={`prearm-btn prearm-call ${armed === 'check_call' ? 'prearm-btn--on' : ''}`}
              onClick={() => toggle('check_call')}
            >
              Check / Call any
            </button>
          </div>
          {armed && <div className="prearm-hint eyebrow">Fires the moment the turn reaches you — tap again to disarm.</div>}
        </>
      )}
    </div>
  )
}

/** Raise presets — set the raise-to level relative to the pot (§12.6). */
const RAISE_PRESETS: { key: string; label: string }[] = [
  { key: 'min', label: 'min' },
  { key: 'half', label: '½ pot' },
  { key: 'pot', label: 'pot' },
  { key: 'max', label: 'all-in' },
]

function ActionPanel() {
  const match = useGameStore((s) => s.match)!
  const yourTurn = useGameStore((s) => s.yourTurn)!
  const act = useGameStore((s) => s.act)
  const actPending = useGameStore((s) => s.actPending)
  const terms = useGameStore((s) => s.terms)
  const now = useNow()

  const token = terms?.chipsToken ?? 'USDC'
  // The raise slider math runs in NUMBER base units (bounded USDC-6, exact as a float); the
  // Chips bigints (stack/pot/currentBet) convert here at the edge, and the chosen raise-to
  // converts back to bigint when the signed action is built.
  const stack = Number(match.yourStack ?? 0n)
  const currentBet = Number(match.currentBet)
  const potNum = Number(match.pot)
  const { toCall, minRaiseTo, deadline } = yourTurn
  const remaining = Math.max(0, deadline - now)
  const totalMs = (terms?.actionTimerSec ?? 20) * 1000

  const maxRaiseTo = currentBet + stack // shove level
  const clampRaise = (v: number) => Math.max(minRaiseTo, Math.min(maxRaiseTo, v))

  // raiseTo is kept in token base units (what the engine speaks); the input
  // edits it in whole-token terms so the player types "0.02", never "20000".
  const [raiseTo, setRaiseTo] = useState(minRaiseTo)
  useEffect(() => setRaiseTo(clampRaise(minRaiseTo)), [minRaiseTo, maxRaiseTo]) // eslint-disable-line react-hooks/exhaustive-deps
  const step = Number(terms?.bigBlind ?? 10_000n)

  const presetValue = useMemo(() => ({
    min: minRaiseTo,
    half: clampRaise(currentBet + Math.round(potNum * 0.5)),
    pot: clampRaise(currentBet + potNum),
    max: maxRaiseTo,
  }), [minRaiseTo, maxRaiseTo, currentBet, potNum]) // eslint-disable-line react-hooks/exhaustive-deps

  // While an action is being signed+sent, lock the panel and narrate it — clicking again
  // would burn a nonce. `pending` is set the instant a button is tapped (before the wallet).
  const pending = actPending != null
  const pendingType = actPending?.type
  const send = (action: BettingAction) => { if (!pending) act(action) }
  const canRaise = stack > toCall
  const raiseValid = raiseTo >= minRaiseTo && raiseTo <= maxRaiseTo
  const isShove = raiseTo >= maxRaiseTo

  return (
    <div className="betpanel panel action-panel">
      <div className="betpanel-head">
        <span className="panel-title">Your turn</span>
        <TimerRing remainingMs={remaining} totalMs={totalMs} label={`${Math.ceil(remaining / 1000)}`} />
      </div>

      <div className="exposure">
        <Exposure label="to call" value={toCall} token={token} accent />
        <Exposure label="committed" value={Number(match.yourExposure ?? 0n)} token={token} />
        <Exposure label="stack" value={stack} token={token} />
      </div>

      <div className={`poker-actions ${pending ? 'poker-actions--pending' : ''}`}>
        <button className={`pk-btn pk-fold ${pendingType === 'fold' ? 'pk-btn--busy' : ''}`} onClick={() => send({ type: 'fold' })} disabled={pending} aria-busy={pendingType === 'fold'}>
          {pendingType === 'fold' ? 'Folding…' : 'Fold'}
        </button>
        {toCall === 0 ? (
          <button className={`pk-btn pk-call ${pendingType === 'check' ? 'pk-btn--busy' : ''}`} onClick={() => send({ type: 'check' })} disabled={pending} aria-busy={pendingType === 'check'}>
            {pendingType === 'check' ? 'Checking…' : 'Check'}
          </button>
        ) : (
          <button
            className={`pk-btn pk-call ${pendingType === 'call' ? 'pk-btn--busy' : ''}`}
            onClick={() => send({ type: 'call' })}
            disabled={pending || stack === 0}
            aria-busy={pendingType === 'call'}
          >
            {pendingType === 'call' ? 'Sending…' : `Call ${formatChips(toCall)}`}
          </button>
        )}
        <button className={`pk-btn pk-allin ${pendingType === 'allIn' ? 'pk-btn--busy' : ''}`} onClick={() => send({ type: 'allIn' })} disabled={pending} aria-busy={pendingType === 'allIn'}>
          {pendingType === 'allIn' ? 'Sending…' : `All-in ${formatChips(stack)}`}
        </button>
      </div>

      {canRaise && (
        <div className="raise-block">
          <div className="raise-presets">
            {RAISE_PRESETS.map((p) => {
              const v = presetValue[p.key as keyof typeof presetValue]
              return (
                <button
                  key={p.key}
                  className={`raise-preset ${raiseTo === v ? 'raise-preset--on' : ''}`}
                  onClick={() => setRaiseTo(v)}
                  type="button"
                >
                  {p.label}
                </button>
              )
            })}
          </div>
          <input
            className="raise-slider"
            type="range"
            min={minRaiseTo}
            max={maxRaiseTo}
            step={step}
            value={raiseTo}
            aria-label="Raise-to amount"
            onChange={(e) => setRaiseTo(clampRaise(Number(e.target.value)))}
          />
          <div className="raise-row">
            <input
              className="raise-input mono"
              type="number"
              min={minRaiseTo / 1e6}
              step={step / 1e6}
              value={raiseTo / 1e6}
              aria-label="Raise-to amount"
              onChange={(e) => setRaiseTo(clampRaise(Math.round(Number(e.target.value) * 1e6)))}
            />
            <button
              className="pk-btn pk-raise"
              onClick={() => send(isShove ? { type: 'allIn' } : { type: 'raiseTo', amount: BigInt(raiseTo) })}
              disabled={!raiseValid || pending}
            >
              {pendingType === 'raiseTo' || (pendingType === 'allIn' && isShove)
                ? 'Sending…'
                : isShove ? `All-in ${formatChips(stack)}` : `Raise to ${formatChips(raiseTo)}`}
            </button>
          </div>
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
