import { useEffect, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'
import { PAST_FILLING_PHASES } from '@/lib/protocol'

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

  const { connected, connecting } = useWallet()
  const { setVisible } = useWalletModal()
  const [submitting, setSubmitting] = useState(false)

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

  return (
    <div className="lobby">
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
          </div>
        </div>

        {/* Host-editable table settings — buy-in and fill window (§4) */}
        {isCreate && createLimits && (
          <div className="lobby-create-opts">
            <BuyInField
              token={terms.chipsToken}
              valueBase={terms.buyIn}
              limits={createLimits}
              onChange={setCreateBuyIn}
            />
            <FillWindowField
              valueSec={terms.fillWindowSec ?? createLimits.fillWindowMinSec}
              limits={createLimits}
              onChange={setCreateFillWindow}
            />
          </div>
        )}

        <div className="lobby-grid">
          {!isCreate && <Term label="buy-in" value={`${fmt(terms.buyIn)} ${terms.chipsToken}`} />}
          <Term label="entry fee" value={`${fmt(terms.entryFee)} ${terms.chipsToken}`} />
          <Term label="blinds" value={`${fmt(terms.smallBlind)} / ${fmt(terms.bigBlind)}`} />
          <Term label="rake" value={`${terms.rakeBps / 100}% · cap ${fmt(terms.rakeCap)}`} />
          <Term label="rounds" value={`${terms.roundCount} betting rounds`} />
          <Term
            label="action timer"
            value={`${terms.actionTimerSec}s + ${terms.timeBankSec}s bank`}
          />
        </div>

        {/* Cost disclosure — always shown before any commitment (§10.1) */}
        <div className="lobby-cost">
          <span className="eyebrow">total to take your seat</span>
          <span className="lobby-cost-amount mono">
            {fmt(total)} {terms.chipsToken}
          </span>
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
            <button className="seal-btn lobby-join" onClick={handleCommit} disabled={submitting}>
              {submitting
                ? 'Confirming on-chain…'
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
              disabled={connecting}
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

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="lobby-term">
      <span className="eyebrow">{label}</span>
      <span className="lobby-term-value mono">{value}</span>
    </div>
  )
}

type Limits = { buyInMin: number; buyInMax: number; fillWindowMinSec: number; fillWindowMaxSec: number }

/** Editable buy-in amount (whole tokens) with the template's allowed range. */
function BuyInField({
  token,
  valueBase,
  limits,
  onChange,
}: {
  token: string
  valueBase: number
  limits: Limits
  onChange: (baseUnits: number) => void
}) {
  // Local text state so the user can clear/type freely; commit (clamp) on blur.
  const [text, setText] = useState(() => String(valueBase / 1e6))
  // Keep the field in sync when the store clamps the value under us.
  useEffect(() => { setText(String(valueBase / 1e6)) }, [valueBase])

  const commit = () => {
    const n = parseFloat(text)
    if (Number.isFinite(n)) onChange(Math.round(n * 1e6))
    else setText(String(valueBase / 1e6))
  }
  const money = (base: number) => (base / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })

  return (
    <label className="lobby-field">
      <span className="eyebrow">buy-in ({token})</span>
      <div className="lobby-field-input">
        <input
          type="number"
          inputMode="decimal"
          min={limits.buyInMin / 1e6}
          max={limits.buyInMax / 1e6}
          step={0.1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
        <span className="lobby-field-unit">{token}</span>
      </div>
      <span className="lobby-field-hint eyebrow">
        {money(limits.buyInMin)} – {money(limits.buyInMax)} {token}
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

/** Editable fill window (seconds) with quick presets + the template's allowed range. */
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
  useEffect(() => { setText(String(valueSec)) }, [valueSec])

  const commit = () => {
    const n = parseInt(text, 10)
    if (Number.isFinite(n)) onChange(n)
    else setText(String(valueSec))
  }
  const presets = FILL_PRESETS_SEC.filter(
    (s) => s >= limits.fillWindowMinSec && s <= limits.fillWindowMaxSec,
  )

  return (
    <label className="lobby-field">
      <span className="eyebrow">fill window</span>
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
      {presets.length > 0 && (
        <div className="lobby-field-presets">
          {presets.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${s === valueSec ? 'chip--active' : ''}`}
              onClick={() => onChange(s)}
            >
              {fmtDuration(s)}
            </button>
          ))}
        </div>
      )}
      <span className="lobby-field-hint eyebrow">
        min {fmtDuration(limits.fillWindowMinSec)} · max {fmtDuration(limits.fillWindowMaxSec)}
      </span>
    </label>
  )
}
