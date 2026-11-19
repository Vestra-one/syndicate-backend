import { useEffect, useMemo, useRef, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { heldMove } from '@/lib/edge'
import { useNow } from '@/lib/useNow'
import { formatChips, formatCountdown } from '@/lib/format'
import { seatAlias } from '@/lib/seats'
import type { BettingAction } from '@/lib/protocol'
import { TimerRing } from './TimerRing'
import { useWaiting } from './WaitingRoom'
import { useRoundGate } from './useRoundGate'
import { readStats } from '@/lib/sessionStats'

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
  const over = useGameStore((s) => s.settlement != null || s.voided != null)
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
    // An armed fold never throws away a free look: with nothing to call it checks.
    if (armed === 'fold') act(yourTurn.toCall === 0 ? { type: 'check' } : { type: 'fold' })
    else act(yourTurn.toCall === 0 ? { type: 'check' } : { type: 'call' })
    setArmed(null)
  }, [yourTurn, armed, act, gate.open])

  const phase = match?.phase

  // Pre-game you may lock in your prediction early; once sealed, a calm "you're set" state.
  // The hand is over: the "match over" bar owns this spot.
  if (over) return null
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
/**
 * Quick picks, in typical moves from the market (how far the price usually travels by
 * settlement). Percent offsets were a trap: on a three-minute hand ±0.5% is many typical
 * moves away — a call that almost never wins.
 */
const SEAL_PICKS = [-1, -0.5, 0, 0.5, 1] as const

/** How far off spot a sealed call may sit before we block it as a fat-finger (§14.4). */
const SEAL_BOUND = 0.5

function SealPanel({ waiting }: { waiting?: boolean }) {
  // The first few hands get the rules in two lines, right where the decision is.
  const newcomer = readStats(useGameStore.getState().walletAddress).hands < 3
  const terms = useGameStore((s) => s.terms)
  const sealStatus = useGameStore((s) => s.sealStatus)
  const lastPrice = useGameStore((s) => s.priceHistory.at(-1)?.price ?? null)
  const sealDeadline = useGameStore((s) => s.sealDeadline)
  const seal = useGameStore((s) => s.sealPrediction)
  // Seal failures set `playError`, but that toast only renders in the Lobby/Dashboard —
  // in-match it would vanish, making a failed seal look like a dead button. Surface it here.
  const sealError = useGameStore((s) => s.playError)
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const now = useNow(500)

  // seed the input with the live price once
  useEffect(() => {
    // Until the player types or picks, the box tracks the market (a stale prefill reads as a view).
    if (!touched && lastPrice != null) setText(lastPrice.toFixed(terms?.decimals ?? 2))
  }, [lastPrice, terms, touched])

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

  // How far the market typically travels between now and settlement: the rest of the seal
  // window, then every street with its pause.
  const history = useGameStore((s) => s.priceHistory)
  const handSec =
    (remaining != null ? remaining / 1000 : 0) +
    (terms?.roundDurationsSec ?? []).reduce((a, b) => a + b + 10, 0)
  // Measured once when the seal box opens and then held: buttons whose numbers change every
  // second cannot be aimed at.
  const handKey = useGameStore((s) => s.terms?.onchainMatchId ?? s.match?.matchId ?? null)
  const sealSpan = useRef<number | null>(null)
  if (sealSpan.current == null && handSec > 0) sealSpan.current = handSec // the clock ticks; the buttons must not
  const move = heldMove(handKey != null ? String(handKey) : null, history, sealSpan.current ?? handSec)
  const fmtMove = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : 0 })
  const moveText = move != null ? `$${fmtMove(move)}` : null

  const setPick = (k: number) => {
    if (lastPrice == null) return
    setTouched(k !== 0)
    setText((lastPrice + k * (move ?? 0)).toFixed(decimals))
  }
  const pickLabel = (k: number) =>
    k === 0 || move == null ? 'market' : `${k > 0 ? '+' : '−'}$${fmtMove(Math.abs(k * move))}`

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
          onFocus={(e) => e.currentTarget.select()}
          inputMode="decimal"
          value={text}
          onChange={(e) => { setTouched(true); setText(e.target.value); if (sealError) useGameStore.setState({ playError: null }) }}
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
        {SEAL_PICKS.map((k) => (
          <button
            key={k}
            className="seal-offset-chip"
            onClick={() => setPick(k)}
            disabled={lastPrice == null}
            type="button"
          >
            {pickLabel(k)}
          </button>
        ))}
      </div>

      {newcomer && (
        <p className="seal-guide seal-guide--how">
          <b>How this works:</b> guess where the price will be when this hand ends, about two minutes from now, and seal it.
          Then bet on your guess like a poker hand. The closest guess still in at the end takes the pot.
        </p>
      )}
      {moveText && (
        <p className="seal-guide">
          The market typically moves about <b className="mono">±{moveText}</b> by settlement.
          Sit on the market and you share it with everyone who did the same; step far out and you need a big move.
        </p>
      )}

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
  return (
    <div className="betpanel panel seal-missed">
      <div className="betpanel-head">
        <span className="panel-title">Seal window closed</span>
        <span className="seal-lock" aria-hidden="true">⚠</span>
      </div>
      <p className="seal-note eyebrow">
        You didn’t seal in time, so your call is the market price at the moment the seal window closed.
        You are still in the hand and can win it like anyone else — but the whole table can
        work out your number, so you are playing with your call face up.
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
  const sealDeadline = useGameStore((s) => s.sealDeadline)
  const now = useNow(500)
  const startsIn = sealDeadline != null && sealDeadline > now ? sealDeadline - now : null
  useEffect(() => {
    const t = setTimeout(() => setCollapsed(true), 5000)
    return () => clearTimeout(t)
  }, [])

  if (collapsed) {
    return (
      <div className="betpanel panel seal-sealed-bar">
        <span className="seal-lock" aria-hidden="true">🔒</span>
        <span className="seal-sealed-bar-text">
          Prediction sealed — secret until the hand ends
          {startsIn != null && <> · betting starts in <b className="mono">{formatCountdown(startsIn)}</b></>}
        </span>
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
  // Nobody has a decision left (everyone still in is all-in, or we are): nothing to arm.
  // This is the sweat — say so, instead of offering buttons that cannot do anything.
  const me = seats?.find((x) => x.seat === yourSeat)
  const canAct = seats?.filter((x) => !x.folded && !x.allIn).length ?? 0
  if (alive > 1 && (me?.allIn || canAct <= 1) && toActSeat == null) {
    return (
      <div className="betpanel panel">
        <div className="betpanel-head">
          <span className="panel-title">Showdown</span>
          <span className="betpanel-locked eyebrow">{me?.allIn ? 'you are all in' : 'all the chips are in'}</span>
        </div>
        <p className="seal-note eyebrow">
          No more betting. {alive} calls are still in — the closest to the price when the clock runs out takes the pot.
        </p>
      </div>
    )
  }
  if (me?.folded && alive > 1) {
    return (
      <div className="betpanel panel">
        <div className="betpanel-head">
          <span className="panel-title">Live</span>
          <span className="betpanel-locked eyebrow">you folded — {alive} still in</span>
        </div>
      </div>
    )
  }
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
              Check / Fold
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
  const [sure, setSure] = useState(false)
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
    // Whole cents: a half-cent bet makes stack + committed disagree on screen.
    half: clampRaise(Math.floor((currentBet + potNum * 0.5) / 10_000) * 10_000),
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
  // No chips wagered this round → the aggressive action opens betting and must be a `bet_to`;
  // otherwise it raises an existing bet (`raise_to`). Sending the wrong one is rejected by the
  // engine (MustBetNotRaise / MustRaiseNotBet). Note this is `currentBet === 0`, NOT `toCall === 0`:
  // preflop the big blind has toCall 0 but a posted blind, so its aggressive action is still a raise.
  const isOpen = currentBet === 0

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
        {/* When calling already takes the whole stack, a second button for the same thing only invites a misclick. */}
        {!(toCall > 0n && toCall >= stack) && (
        <button className={`pk-btn pk-allin ${pendingType === 'allIn' ? 'pk-btn--busy' : ''} ${sure ? 'pk-allin--sure' : ''}`} onClick={() => (sure ? send({ type: 'allIn' }) : setSure(true))} disabled={pending} aria-busy={pendingType === 'allIn'}>
          {pendingType === 'allIn' ? 'Sending…' : sure ? `Confirm all-in ${formatChips(stack)}` : `All-in ${formatChips(stack)}`}
        </button>
        )}
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
              onClick={() => send(isShove ? { type: 'allIn' } : { type: isOpen ? 'betTo' : 'raiseTo', amount: BigInt(raiseTo) })}
              disabled={!raiseValid || pending}
            >
              {pendingType === 'betTo' || pendingType === 'raiseTo' || (pendingType === 'allIn' && isShove)
                ? 'Sending…'
                : isShove ? `All-in ${formatChips(stack)}` : isOpen ? `Bet ${formatChips(raiseTo)}` : `Raise to ${formatChips(raiseTo)}`}
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
