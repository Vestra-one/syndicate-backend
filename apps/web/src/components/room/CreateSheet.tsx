import { useEffect, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'
import { formatChips } from '@/lib/format'
import { Coin } from './bits'

const BUYIN_PRESETS = [5, 10, 25, 50, 100]
const FILL_PRESETS_SEC = [20, 60, 300, 900, 3600]

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return sec % 60 === 0 ? `${sec / 60}m` : `${Math.floor(sec / 60)}m ${sec % 60}s`
  return sec % 3600 === 0 ? `${sec / 3600}h` : `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`
}

/**
 * The create sheet — every choice is a chip you press or a seat you tap, never a bare
 * form field, so it reads as dealing a table rather than filling out paperwork. Ends on
 * the same buy-in + entry = total disclosure as JoinSheet, before any wallet signature.
 */
export function CreateSheet() {
  const terms = useGameStore((s) => s.terms)
  const createLimits = useGameStore((s) => s.createLimits)
  const playResolving = useGameStore((s) => s.playResolving)
  const playError = useGameStore((s) => s.playError)
  const setCreateFeed = useGameStore((s) => s.setCreateFeed)
  const setCreateBuyIn = useGameStore((s) => s.setCreateBuyIn)
  const setCreateFillWindow = useGameStore((s) => s.setCreateFillWindow)
  const setCreateSeats = useGameStore((s) => s.setCreateSeats)
  const create = useGameStore((s) => s.createTable)
  const close = useGameStore((s) => s.closeRoomModal)
  const txProgress = useGameStore((s) => s.txProgress)
  const { connected } = useWallet()
  const { setVisible } = useWalletModal()

  const [buyInText, setBuyInText] = useState('')
  const [buyInError, setBuyInError] = useState<string | null>(null)
  const busy = !!txProgress

  useEffect(() => {
    if (terms) setBuyInText(String(Number(terms.buyIn) / 1e6))
  }, [terms?.buyIn]) // eslint-disable-line react-hooks/exhaustive-deps

  if (playResolving) {
    return (
      <Shell onClose={busy ? undefined : close}>
        <div className="sheet-spinner"><span className="sheet-spinner-dot" /></div>
      </Shell>
    )
  }

  if (playError && !terms) {
    return (
      <Shell onClose={close}>
        <div className="sheet-error">
          <div className="sheet-error-icon">✗</div>
          <div className="sheet-error-msg">{playError}</div>
          <button className="btn-gold" type="button" onClick={close}>Back to tables</button>
        </div>
      </Shell>
    )
  }

  if (!terms || !createLimits) return null

  const minTok = createLimits.buyInMin / 1e6
  const maxTok = createLimits.buyInMax / 1e6
  const buyInPresets = BUYIN_PRESETS.filter((p) => p >= minTok && p <= maxTok)
  const fillPresets = FILL_PRESETS_SEC.filter((s) => s >= createLimits.fillWindowMinSec && s <= createLimits.fillWindowMaxSec)
  const seatOptions = Array.from({ length: createLimits.playersMax - 1 }, (_, i) => i + 2) // 2..playersMax

  const commitBuyIn = (raw: string) => {
    setBuyInText(raw)
    const n = parseFloat(raw)
    if (!Number.isFinite(n) || n < minTok || n > maxTok) {
      setBuyInError(`Enter ${minTok.toLocaleString()}–${maxTok.toLocaleString()} USDC`)
      return
    }
    setBuyInError(null)
    setCreateBuyIn(Math.round(n * 1e6))
  }

  const total = terms.buyIn + terms.entryFee
  const potUpTo = terms.buyIn * BigInt(terms.maxPlayers)

  const handleCommit = () => {
    if (!connected) { setVisible(true); return }
    void create()
  }

  return (
    <Shell onClose={busy ? undefined : close}>
      <div className="sheet-head">
        <div className="sheet-title">
          <span className="eyebrow">deal a table · you're first in</span>
          <h3>Set the stakes — the room's yours.</h3>
        </div>
        {!busy && <button className="sheet-x" type="button" onClick={close} aria-label="Close">✕</button>}
      </div>
      <p className="sheet-sub">Others join before it goes live. You'll sit at seat 1.</p>

      <div className="pick">
        <span className="eyebrow">market</span>
        <div className="pickrow">
          {terms.supportedFeeds.map((feed) => {
            const [base] = feed.split('/')
            return (
              <button key={feed} type="button" className={`mchip ${feed === terms.priceFeedId ? 'on' : ''}`} onClick={() => setCreateFeed(feed)}>
                <Coin base={base} sm />{feed}
              </button>
            )
          })}
        </div>
      </div>

      <div className="pick">
        <span className="eyebrow">buy-in · usdc</span>
        <div className="pickrow">
          {buyInPresets.map((p) => (
            <button key={p} type="button" className={`room-chip ${Number(terms.buyIn) === p * 1e6 ? 'on' : ''}`} onClick={() => commitBuyIn(String(p))}>{p}</button>
          ))}
        </div>
        <div className="pick-field">
          <input
            type="number"
            inputMode="decimal"
            value={buyInText}
            onChange={(e) => commitBuyIn(e.target.value)}
          />
          {buyInError && <div className="pick-field-error">{buyInError}</div>}
        </div>
        <p className="pick-hint">+ {formatChips(terms.entryFee)} entry · refunded if the table never fills</p>
      </div>

      <div className="pick">
        <span className="eyebrow">seats — tap to set the table</span>
        <div className="seatpips">
          <button className="seatpip you" type="button" disabled aria-label="Seat 1 — yours">1</button>
          {seatOptions.map((n) => (
            <button
              key={n}
              type="button"
              className={`seatpip ${n <= terms.maxPlayers ? 'f' : ''}`}
              aria-label={`Seat ${n}`}
              onClick={() => setCreateSeats(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="pick-hint">seat 1 is yours · deals at {terms.minPlayers}, plays best at full</p>
      </div>

      <div className="pick">
        <span className="eyebrow">fill window — how long the door stays open</span>
        <div className="pickrow">
          {fillPresets.map((s) => (
            <button key={s} type="button" className={`room-chip ${terms.fillWindowSec === s ? 'on' : ''}`} onClick={() => setCreateFillWindow(s)}>
              {fmtDuration(s)}
            </button>
          ))}
        </div>
      </div>

      <div className="setup">
        <span>you're setting up</span>
        <b>
          {terms.priceFeedId} <i>·</i> {terms.maxPlayers} seats <i>·</i> {formatChips(terms.buyIn)} USDC buy-in <i>·</i>{' '}
          pot up to {formatChips(potUpTo)} USDC <i>·</i> rake {(terms.rakeBps / 100).toFixed(2)}% <i>·</i>{' '}
          fills in {fmtDuration(terms.fillWindowSec ?? 0)}
        </b>
      </div>

      <div className="total">
        <span className="part">{formatChips(terms.buyIn)}<em>buy-in</em></span>
        <span className="op">+</span>
        <span className="part">{formatChips(terms.entryFee)}<em>entry</em></span>
        <span className="op">=</span>
        <span className="sum">{formatChips(total)} <em>USDC</em></span>
      </div>

      {playError && <div className="sheet-inline-error">{playError}</div>}

      <button className="btn-gold" type="button" disabled={busy || !!buyInError} onClick={handleCommit}>
        {connected ? `Deal & take seat 1 · deposit ${formatChips(total)} USDC` : 'Connect wallet to continue'}
      </button>
      <p className="sheet-fine">one wallet approval after this</p>
      {!busy && <button className="sheet-back" type="button" onClick={close}>← Back to tables</button>}
    </Shell>
  )
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div
      className="veil"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (onClose && e.target === e.currentTarget) onClose() }}
    >
      <div className="sheet">{children}</div>
    </div>
  )
}
