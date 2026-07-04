import { useEffect, useState, type ReactNode } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'
import { PAST_FILLING_PHASES } from '@/lib/protocol'
import { seatAlias, seatTag } from '@/lib/seats'
import { SeatPod } from './SeatPod'
import { personaEmblem } from './Seats'
import { SeatSlot, waitingSeatAngles } from './WaitingRoom'

/**
 * The pre-seat "join preview" — is the join/create card currently the active
 * surface? Shared with the HUD so the live-table chrome (opponent pods, betting
 * panel, your-position) is suppressed while you're only *previewing* a table,
 * and with the seat ring so both appear under exactly the same conditions.
 *
 * `yourSeatIndex` is the first open chair you'd take (seats fill front-to-back),
 * so the preview can highlight "you'll sit at seat N".
 */
export function useLobbyPreview() {
  const terms = useGameStore((s) => s.terms)
  const match = useGameStore((s) => s.match)
  const seated = useGameStore((s) => s.seated)
  const lobbySeated = useGameStore((s) => s.lobbySeated)
  const playMode = useGameStore((s) => s.playMode)
  const playResolving = useGameStore((s) => s.playResolving)

  const open =
    !!terms &&
    !seated &&
    !!playMode &&
    !playResolving &&
    !(match && PAST_FILLING_PHASES.includes(match.phase))
  const filled = Math.max(match?.seats.length ?? 0, lobbySeated ?? 0)
  const max = terms?.maxPlayers ?? 0
  const yourSeatIndex = Math.min(filled, Math.max(0, max - 1))
  return { open, filled, max, yourSeatIndex, terms, match }
}

/**
 * The lobby (§4) — the bridge between "Play Now" and a seated player.
 *
 * Resolving → a calm "finding you a table" state while we check the lobby.
 * Resolved   → the table terms + the explicit commit:
 *                join   → deposit into an existing open table
 *                create → open a new table on-chain and seat yourself
 *
 * The full cost is always shown BEFORE any wallet signature (§10.1).
 */
export function Lobby() {
  const terms = useGameStore((s) => s.terms)
  const match = useGameStore((s) => s.match)
  const seated = useGameStore((s) => s.seated)
  const lobbySeated = useGameStore((s) => s.lobbySeated)
  const playMode = useGameStore((s) => s.playMode)
  const playResolving = useGameStore((s) => s.playResolving)
  const playError = useGameStore((s) => s.playError)
  const join = useGameStore((s) => s.joinTable)
  const create = useGameStore((s) => s.createTable)
  const createLimits = useGameStore((s) => s.createLimits)
  const setCreateBuyIn = useGameStore((s) => s.setCreateBuyIn)
  const setCreateFillWindow = useGameStore((s) => s.setCreateFillWindow)
  const setCreateFeed = useGameStore((s) => s.setCreateFeed)

  const { connected, connecting } = useWallet()
  const { setVisible } = useWalletModal()
  const [submitting, setSubmitting] = useState(false)
  // Inline buy-in validation lives here (not in the field) so it can also gate the CTA.
  const [buyInError, setBuyInError] = useState<string | null>(null)

  // Resolving: connecting wallet + gateway — brief spinner
  if (playResolving) {
    return (
      <div className="lobby">
        <div className="lobby-card panel lobby-card--resolving">
          <div className="lobby-spinner" aria-hidden="true" />
          <div className="lobby-resolving-title">Getting ready…</div>
        </div>
      </div>
    )
  }

  // Game creation failed — show error card so the user isn't left staring at a blank table.
  if (playError && !playMode && !seated) {
    return (
      <div className="lobby">
        <div className="lobby-card panel lobby-card--error">
          <div className="lobby-error-icon" aria-hidden="true">✗</div>
          <div className="lobby-error-title">Couldn't create table</div>
          <div className="lobby-error-msg">{playError}</div>
          <button
            className="seal-btn lobby-error-dismiss"
            onClick={() => useGameStore.setState({ playError: null })}
          >
            Dismiss
          </button>
        </div>
      </div>
    )
  }

  // Nothing to commit to yet, or already seated → hide.
  if (!terms || seated || !playMode) return null
  // If we have a live match that's past filling, the lobby is done.
  if (match && PAST_FILLING_PHASES.includes(match.phase)) return null

  // The gateway's subscribe response for a still-FILLING room returns seats: [], so prefer
  // the seat count from the resolved lobby listing (which reflects the creator + any joiners).
  const filled = Math.max(match?.seats.length ?? 0, lobbySeated ?? 0)
  const total = terms.buyIn + terms.entryFee
  const isCreate = playMode === 'create'
  const walletReady = connected

  const handleCommit = async () => {
    if (!walletReady) {
      setVisible(true)
      return
    }
    setSubmitting(true)
    try {
      if (isCreate) await create()
      else await join()
    } finally {
      setSubmitting(false)
    }
  }

  // Display amounts in whole tokens (USDC has 6 decimals; price decimals differ).
  const fmt = (base: number) => (base / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })

  const preview = { filled, max: terms.maxPlayers, yourSeatIndex: Math.min(filled, Math.max(0, terms.maxPlayers - 1)), terms, match: match ?? null }

  return (
    <div className="lobby">
      <LobbySeatRing {...preview} />
      <div className="lobby-card panel">
        <button className="lobby-back" onClick={() => useGameStore.getState().backToDashboard()}>
          ← Back to tables
        </button>
        <div className="lobby-head">
          <div>
            <div className="eyebrow">
              {isCreate ? 'create table' : 'join table'} · {terms.priceFeedId}
            </div>
            <div className="lobby-feed">
              {isCreate
                ? "You'll be first in — others can join before it goes live."
                : terms.tableId}
            </div>
          </div>
          <div className="lobby-players">
            <span className="lobby-players-count mono">
              {filled}/{terms.maxPlayers}
            </span>
            <span className="eyebrow">seated</span>
            <span className="lobby-your-seat">You'll sit at seat {preview.yourSeatIndex + 1}</span>
          </div>
        </div>

        {isCreate && createLimits ? (
          /* Host-editable table settings — the creator's primary inputs (§5). */
          <>
            <PairSelector
              feeds={terms.supportedFeeds}
              value={terms.priceFeedId}
              onChange={setCreateFeed}
            />
            <div className="lobby-create-opts">
              <BuyInField
                token={terms.chipsToken}
                valueBase={terms.buyIn}
                limits={createLimits}
                onChange={setCreateBuyIn}
                onError={setBuyInError}
              />
              <FillWindowField
                valueSec={terms.fillWindowSec ?? createLimits.fillWindowMinSec}
                limits={createLimits}
                onChange={setCreateFillWindow}
              />
            </div>
            <CreateSummary terms={terms} fmt={fmt} />
            <TableRules terms={terms} fmt={fmt} />
          </>
        ) : (
          <div className="lobby-grid">
            <Term
              label="buy-in"
              value={`${fmt(terms.buyIn)} ${terms.chipsToken}`}
              hint="The chips you bring to the table — they become your starting stack. Refunded in full if the table voids."
            />
            <DerivedTerms terms={terms} fmt={fmt} />
          </div>
        )}

        {/* Cost disclosure — always shown before any commitment (§10.1), with the
            buy-in + entry fee addition made explicit above the total. */}
        <div className="lobby-cost">
          <span className="eyebrow">total to take your seat</span>
          <div className="lobby-cost-eq mono">
            <span className="lobby-cost-part">
              {fmt(terms.buyIn)}<i>buy-in</i>
            </span>
            <span className="lobby-cost-op">+</span>
            <span className="lobby-cost-part">
              {fmt(terms.entryFee)}<i>entry</i>
            </span>
            <span className="lobby-cost-op">=</span>
            <span className="lobby-cost-amount">
              {fmt(total)} {terms.chipsToken}
            </span>
          </div>
        </div>

        {/* A failed deposit leaves playMode set (so the Lobby stays open to retry) —
            surface it here, not just in the pre-Lobby error card above. */}
        {playError && (
          <div className="dash-play-error eyebrow">
            {playError}{' '}
            <button
              className="lobby-error-dismiss"
              onClick={() => useGameStore.setState({ playError: null })}
            >
              Dismiss
            </button>
          </div>
        )}

        {walletReady ? (
          <>
            <button
              className="seal-btn lobby-join"
              onClick={handleCommit}
              disabled={submitting || (isCreate && !!buyInError)}
            >
              {submitting
                ? 'Confirming on-chain…'
                : isCreate && buyInError
                  ? 'Fix buy-in to continue'
                  : isCreate
                  ? `Create table · deposit ${fmt(total)} ${terms.chipsToken}`
                  : `Take your seat · deposit ${fmt(total)} ${terms.chipsToken}`}
            </button>
            <p className="lobby-note eyebrow">
              {isCreate
                ? "You'll be the host and first seat. Entry fee is refunded if the table voids."
                : 'Entry fee is refunded if the table voids or you leave before it goes live.'}
            </p>
          </>
        ) : (
          <>
            <button
              className="seal-btn lobby-join lobby-connect"
              onClick={handleCommit}
              disabled={connecting || (isCreate && !!buyInError)}
            >
              {connecting ? 'Connecting wallet…' : '◎ Connect wallet to continue'}
            </button>
            <p className="lobby-note eyebrow">
              You'll approve one transaction of {fmt(total)} {terms.chipsToken} after connecting.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Term({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="lobby-term">
      <span className="eyebrow lobby-term-label">
        {label}
        {hint && <InfoDot text={hint} />}
      </span>
      <span className="lobby-term-value mono">{value}</span>
    </div>
  )
}

/**
 * The five feed-derived, non-editable terms (entry fee, blinds, rake, rounds,
 * action timer). Shared by the join grid and the create-mode 'Table rules'
 * accordion so both stay in lockstep.
 */
function DerivedTerms({
  terms,
  fmt,
}: {
  terms: ReturnType<typeof useGameStore.getState>['terms']
  fmt: (base: number) => string
}) {
  if (!terms) return null
  return (
    <>
      <Term
        label="entry fee"
        value={`${fmt(terms.entryFee)} ${terms.chipsToken}`}
        hint="A flat fee to reserve your seat, on top of the buy-in. Refunded if the table voids or you leave before it goes live."
      />
      <Term
        label="blinds"
        value={`${fmt(terms.smallBlind)} / ${fmt(terms.bigBlind)}`}
        hint="Forced bets that seed each hand — small blind / big blind. They rotate around the table so everyone posts them over time."
      />
      <Term
        label="rake"
        value={`${terms.rakeBps / 100}% · cap ${fmt(terms.rakeCap)}`}
        hint={`The house's cut of each pot: ${terms.rakeBps / 100}% of the pot, never more than ${fmt(terms.rakeCap)} ${terms.chipsToken} per hand.`}
      />
      <Term
        label="rounds"
        value={`${terms.roundCount} betting rounds`}
        hint="Betting reopens each round as the market runs; after the last round, sealed predictions settle for the pot."
      />
      <Term
        label="action timer"
        value={`${terms.actionTimerSec}s + ${terms.timeBankSec}s bank`}
        hint={`You get ${terms.actionTimerSec}s to act on each turn. Run it out and you dip into a one-time ${terms.timeBankSec}s bank; empty the bank and your timeout default is applied automatically.`}
      />
    </>
  )
}

/**
 * Create-mode market picker — the FIRST choice a host makes (§5). Segmented
 * chips over the config's supported feeds, switching the whole table's market.
 */
function PairSelector({
  feeds,
  value,
  onChange,
}: {
  feeds: string[]
  value: string
  onChange: (feed: string) => void
}) {
  if (feeds.length <= 1) return null
  return (
    <label className="lobby-field lobby-pair">
      <span className="eyebrow">market</span>
      <div className="lobby-pair-chips">
        {feeds.map((feed) => (
          <button
            key={feed}
            type="button"
            className={`chip ${feed === value ? 'chip--active' : ''}`}
            onClick={() => onChange(feed)}
          >
            {feed}
          </button>
        ))}
      </div>
    </label>
  )
}

/**
 * Live stakes summary (§5) — the one-glance readout of what the host is setting
 * up, updating as buy-in / market / seats change.
 */
function CreateSummary({
  terms,
  fmt,
}: {
  terms: NonNullable<ReturnType<typeof useGameStore.getState>['terms']>
  fmt: (base: number) => string
}) {
  const parts = [
    `${terms.maxPlayers} seats`,
    `${fmt(terms.buyIn)} ${terms.chipsToken}`,
    `pot up to ${fmt(terms.buyIn * terms.maxPlayers)} ${terms.chipsToken}`,
    `rake ${terms.rakeBps / 100}%`,
  ]
  return (
    <div className="lobby-summary">
      <span className="eyebrow lobby-summary-label">you're setting up</span>
      <div className="lobby-summary-line">
        {parts.map((p, i) => (
          <span key={i} className="lobby-summary-part">
            {p}
          </span>
        ))}
      </div>
    </div>
  )
}

/** The derived terms tucked into a collapsed 'Table rules' accordion (§5). */
function TableRules({
  terms,
  fmt,
}: {
  terms: NonNullable<ReturnType<typeof useGameStore.getState>['terms']>
  fmt: (base: number) => string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`lobby-rules ${open ? 'lobby-rules--open' : ''}`}>
      <button
        type="button"
        className="lobby-rules-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="eyebrow">Table rules</span>
        <span className="lobby-rules-caret" aria-hidden="true">
          {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <div className="lobby-grid lobby-grid--rules">
          <DerivedTerms terms={terms} fmt={fmt} />
        </div>
      )}
    </div>
  )
}

/** A small ⓘ that reveals an explanatory tooltip on hover/focus. */
function InfoDot({ text }: { text: string }) {
  return (
    <span className="info-dot" tabIndex={0} role="button" aria-label={text}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="4.6" r="0.95" fill="currentColor" />
        <rect x="7.2" y="6.6" width="1.6" height="5.2" rx="0.8" fill="currentColor" />
      </svg>
      <span className="info-tip" role="tooltip">{text}</span>
    </span>
  )
}

/**
 * The join preview's seat ring: ALL chairs rendered in their real positions
 * around the felt (anchored to the 3D table, never floating) — seated players as
 * pods, your first open chair highlighted as "you'll sit here", the rest as
 * locked OPEN SEAT markers. Same anchors/pods as the waiting room, so the layout
 * is continuous once you actually sit down.
 */
function LobbySeatRing({
  filled,
  max,
  yourSeatIndex,
  terms,
}: Omit<ReturnType<typeof useLobbyPreview>, 'open'>) {
  if (!terms || max <= 0) return null
  // You aren't seated yet, so no chair is "you" and there are no committed seat
  // rows to trust (FILLING snapshots carry none anyway). Render the confirmed
  // count as anonymous "Seated" pods in the first chairs, the chair you'd take as
  // the highlighted "you'll sit here" marker, and the rest as locked open seats.
  const angles = waitingSeatAngles(max)

  return (
    <div className="wr-seats lobby-seats" aria-hidden="true">
      {angles.map((angle, seat) => {
        const side: 'left' | 'right' = angle < 0 ? 'left' : 'right'
        let pod: ReactNode
        if (seat < filled) {
          pod = (
            <SeatPod
              size="compact"
              side={side}
              name={seatAlias(seat, undefined)}
              seatNo={seat + 1}
              emblem={personaEmblem(seatAlias(seat, undefined))}
              status={{ text: 'Seated', tone: 'seated' }}
              tag={seatTag(seat, undefined)}
            />
          )
        } else if (seat === yourSeatIndex) {
          pod = (
            <SeatPod
              size="compact"
              side={side}
              reserved
              name="You'll sit here"
              seatNo={seat + 1}
              status={{ text: 'Your seat', tone: 'turn' }}
            />
          )
        } else {
          pod = <SeatPod size="compact" side={side} empty name="Open seat" seatNo={seat + 1} />
        }
        return (
          <SeatSlot key={seat} angle={angle} side={side}>
            {pod}
          </SeatSlot>
        )
      })}
    </div>
  )
}

type Limits = { buyInMin: number; buyInMax: number; fillWindowMinSec: number; fillWindowMaxSec: number }

const BUYIN_PRESETS = [5, 10, 25, 50, 100]

/**
 * Editable buy-in with quick presets (the primary input) plus a free-type field.
 * Presets always land in-range; typing can go out of bounds, in which case we
 * surface an inline error and report it up via `onError` so the CTA can disable
 * (§5) — we deliberately DON'T silently clamp, so the host sees why they're stuck.
 */
function BuyInField({
  token,
  valueBase,
  limits,
  onChange,
  onError,
}: {
  token: string
  valueBase: number
  limits: Limits
  onChange: (baseUnits: number) => void
  onError: (msg: string | null) => void
}) {
  const money = (base: number) => (base / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })
  const minTok = limits.buyInMin / 1e6
  const maxTok = limits.buyInMax / 1e6
  const rangeMsg = `Enter ${money(limits.buyInMin)}–${money(limits.buyInMax)} ${token}`

  const [text, setText] = useState(() => String(valueBase / 1e6))
  const [error, setError] = useState<string | null>(null)
  // Keep the field in sync when the store changes the value under us (e.g. presets).
  useEffect(() => { setText(String(valueBase / 1e6)); setError(null); onError(null) }, [valueBase, onError])
  // Clear any lingering error when the field unmounts (switching to join, etc.).
  useEffect(() => () => onError(null), [onError])

  const validate = (raw: string) => {
    const n = parseFloat(raw)
    if (!Number.isFinite(n) || n < minTok || n > maxTok) {
      setError(rangeMsg)
      onError(rangeMsg)
      return
    }
    setError(null)
    onError(null)
    onChange(Math.round(n * 1e6))
  }

  const presets = BUYIN_PRESETS.filter((p) => p >= minTok && p <= maxTok)
  const activePreset = valueBase / 1e6

  return (
    <label className="lobby-field">
      <span className="eyebrow">buy-in ({token})</span>
      {presets.length > 0 && (
        <div className="lobby-field-presets">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              className={`chip ${p === activePreset && !error ? 'chip--active' : ''}`}
              onClick={() => { setText(String(p)); setError(null); onError(null); onChange(Math.round(p * 1e6)) }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
      <div className={`lobby-field-input ${error ? 'lobby-field-input--error' : ''}`}>
        <input
          type="number"
          inputMode="decimal"
          min={minTok}
          max={maxTok}
          step={0.1}
          value={text}
          onChange={(e) => { setText(e.target.value); validate(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
        <span className="lobby-field-unit">{token}</span>
      </div>
      <span className={`lobby-field-hint eyebrow ${error ? 'lobby-field-hint--error' : ''}`}>
        {error ?? `${money(limits.buyInMin)} – ${money(limits.buyInMax)} ${token}`}
      </span>
    </label>
  )
}

const FILL_PRESETS_SEC = [20, 60, 300, 900, 3600]

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return sec % 60 === 0 ? `${sec / 60}m` : `${Math.floor(sec / 60)}m ${sec % 60}s`
  return sec % 3600 === 0 ? `${sec / 3600}h` : `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`
}

/**
 * Fill window as preset chips (the primary control), with the raw seconds input
 * demoted behind an 'Advanced' disclosure (§5) — most hosts just pick 5m.
 */
function FillWindowField({
  valueSec,
  limits,
  onChange,
}: {
  valueSec: number
  limits: Limits
  onChange: (sec: number) => void
}) {
  const [text, setText] = useState(() => String(valueSec))
  const [advanced, setAdvanced] = useState(false)
  useEffect(() => { setText(String(valueSec)) }, [valueSec])

  const commit = () => {
    const n = parseInt(text, 10)
    if (Number.isFinite(n)) onChange(n)
    else setText(String(valueSec))
  }
  const presets = FILL_PRESETS_SEC.filter(
    (s) => s >= limits.fillWindowMinSec && s <= limits.fillWindowMaxSec,
  )
  // A value that isn't one of the presets can only have come from the raw field.
  const isCustom = !presets.includes(valueSec)

  return (
    <label className="lobby-field">
      <span className="eyebrow">fill window</span>
      {presets.length > 0 && (
        <div className="lobby-field-presets">
          {presets.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${s === valueSec ? 'chip--active' : ''}`}
              onClick={() => { onChange(s); setAdvanced(false) }}
            >
              {fmtDuration(s)}
            </button>
          ))}
        </div>
      )}
      {(advanced || isCustom) ? (
        <div className="lobby-field-input">
          <input
            type="number"
            inputMode="numeric"
            min={limits.fillWindowMinSec}
            max={limits.fillWindowMaxSec}
            step={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
          <span className="lobby-field-unit">sec</span>
        </div>
      ) : (
        <button type="button" className="lobby-field-advanced" onClick={() => setAdvanced(true)}>
          Set exact seconds
        </button>
      )}
      <span className="lobby-field-hint eyebrow">
        min {fmtDuration(limits.fillWindowMinSec)} · max {fmtDuration(limits.fillWindowMaxSec)}
      </span>
    </label>
  )
}
