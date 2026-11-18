import { TableTalk } from '@/components/hud/TableTalk'
import { QuickCall } from '@/components/hud/QuickCall'
import { SoundCues } from '@/components/hud/SoundCues'
import { useState, useEffect } from 'react'
import { Brand } from './Brand'
import { WalletMenu } from './WalletMenu'
import { RoundStatus } from './RoundStatus'
import { BettingPanel } from './BettingPanel'
import { YourPosition } from './YourPosition'
import { Seats } from './Seats'
import { TurnBanner } from './TurnBanner'
import { ActionFeed } from './ActionFeed'
import { Resolution } from './Resolution'
import { WaitingRoom, useWaiting } from './WaitingRoom'
import { PriceBoardTabs } from './PriceBoardTabs'
import { PriceChartOverlay } from './PriceChartOverlay'
import { useGameStore } from '@/store/gameStore'
import { explorerTxUrl } from '@/lib/network'
import './hud.css'
import { hasHouseBots } from '@/lib/houseBots'
import { isGuestWallet } from '@/lib/guestWallet'

/**
 * Read-only stand-in for YourPosition + BettingPanel when the viewer holds no seat
 * at this match (Room's "Watch →" spectate path, unauthenticated). Those two panels
 * assume a seated viewer throughout (seal input, fold/call buttons, timeout default)
 * — showing them to a spectator makes a purely observational visit look actionable.
 */
function SpectatorPanel() {
  const phase = useGameStore((s) => s.match?.phase)
  // A player who has deposited is NOT a spectator. For a few seconds after the table
  // locks their engine seat is still being resolved; telling someone who just paid in
  // that they are "spectating" reads as "your deposit didn't count".
  const seated = useGameStore((s) => s.seated && !s.settlement && !s.voided)
  if (seated) {
    return (
      <div className="betpanel panel">
        <div className="panel-title">Taking your seat…</div>
        <p className="seal-note eyebrow">Your deposit is in. The table just locked — your seat opens in a moment.</p>
      </div>
    )
  }
  const hint =
    phase === 'SEALING' ? 'Predictions are sealing — no one can see a call until reveal.'
    : phase === 'LIVE' ? 'Predictions stay sealed until the hand ends.'
    : 'Watching this hand.'
  return (
    <div className="betpanel panel">
      <div className="panel-title">Spectating</div>
      <p className="seal-note eyebrow">{hint}</p>
    </div>
  )
}

/** Something went wrong with the player's seat at this table — say it where they are looking. */
function TableNotice() {
  const msg = useGameStore((s) => (s.view === 'table' && !s.seated && !s.settlement ? s.playError : null))
  if (!msg) return null
  return (
    <div className="table-notice panel" role="alert">
      <span>{msg}</span>
      <button className="ghost-btn ghost-btn--primary" onClick={() => { useGameStore.setState({ playError: null }); void useGameStore.getState().playHouse({ sit: true }) }}>
        Next table
      </button>
      <button className="ghost-btn" onClick={() => useGameStore.setState({ playError: null })}>Keep watching</button>
    </div>
  )
}

/**
 * Out of the hand before it ends — folded, or everyone folded to us. Nothing is left to
 * decide, so offer the next hand now instead of a minute of watching the clock; the chips
 * from this one are collected automatically when it settles.
 */
function EarlyExit() {
  const state = useGameStore((s) => {
    const m = s.match
    if (!m || m.phase !== 'LIVE' || m.yourSeat == null || s.settlement || s.voided || !s.seated) return null
    const live = m.seats.filter((x) => !x.folded)
    const me = m.seats.find((x) => x.seat === m.yourSeat)
    if (me?.folded) return 'folded'
    if (live.length === 1 && live[0].seat === m.yourSeat && m.seats.length > 1) return 'won'
    return null
  })
  const guest = isGuestWallet(useGameStore((s) => s.walletAddress))
  const moveOn = useGameStore((s) => s.moveOn)
  const [stay, setStay] = useState<string | null>(null)
  const matchId = useGameStore((s) => s.match?.matchId ?? null)
  if (!state || !hasHouseBots() || stay === matchId) return null
  return (
    <div className={`early-exit panel early-exit--${state}`} role="status">
      <div className="early-exit-title">
        {state === 'won' ? 'Everyone folded — the pot is yours' : 'You folded this one'}
      </div>
      <div className="early-exit-sub">
        {state === 'won'
          ? 'It pays out when the hand closes on-chain.'
          : 'The rest of your stack comes back when the hand closes on-chain.'}
        {guest ? ' It lands in your balance by itself — no need to wait here.' : ' You will find it under Collect in the lobby.'}
      </div>
      <div className="early-exit-actions">
        <button className="ghost-btn" onClick={() => setStay(matchId)}>Watch it finish</button>
        <button className="ghost-btn ghost-btn--primary" onClick={() => void moveOn()}>Next hand now</button>
      </div>
    </div>
  )
}

/** A way out that is always there. Mid-hand it asks once, because walking away costs turns. */
function LeaveButton() {
  const inHand = useGameStore((s) => {
    const m = s.match
    if (!s.seated || !m || s.settlement || s.voided) return false
    if (m.phase !== 'SEALING' && m.phase !== 'LIVE') return false
    const me = m.seats.find((x) => x.seat === m.yourSeat)
    return !me?.folded
  })
  const show = useGameStore((s) => s.view === 'table' && (s.match?.phase === 'SEALING' || s.match?.phase === 'LIVE'))
  const leaveHand = useGameStore((s) => s.leaveHand)
  const [asking, setAsking] = useState(false)
  if (!show) return null
  if (asking) {
    return (
      <div className="leave-ask panel" role="alertdialog">
        <span>Leave mid-hand? Your chips stay in play and your turns are checked or folded for you.</span>
        <button className="ghost-btn" onClick={() => setAsking(false)}>Stay</button>
        <button className="ghost-btn ghost-btn--primary" onClick={leaveHand}>Leave</button>
      </div>
    )
  }
  return (
    <button className="leave-btn" onClick={() => (inHand ? setAsking(true) : leaveHand())}>← Lobby</button>
  )
}

function TxBanner() {
  const lastTx = useGameStore((s) => s.lastTx)
  const resultUp = useGameStore((s) => (s.settlement != null || s.voided != null) && !s.reviewing)
  const atTable = useGameStore((s) => s.view === 'table')
  const [dismissed, setDismissed] = useState(false)

  // Reset dismissed when a new tx comes in, then auto-dismiss after 10s so the
  // banner doesn't linger on top of the table once the confirmation has landed.
  useEffect(() => {
    if (!lastTx) return
    setDismissed(false)
    const t = setTimeout(() => setDismissed(true), 10_000)
    return () => clearTimeout(t)
  }, [lastTx])

  // The result card says "Claimed ✓" itself; a banner on top of it only covers the buttons.
  // …and at the table the seat ceremony has already said the deposit landed.
  if (!lastTx || dismissed || resultUp || (atTable && lastTx.label.startsWith('Deposit'))) return null

  const explorerUrl = explorerTxUrl(lastTx.sig)

  return (
    <div className="tx-banner">
      <span className="tx-banner-dot" />
      <span className="tx-banner-text">{lastTx.label}</span>
      <a
        className="tx-banner-link"
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        View tx ↗
      </a>
      <button className="tx-banner-close" onClick={() => setDismissed(true)} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}

/**
 * The 2D overlay layer. Three rows (top / spacer / bottom) so the table stays
 * visible and centered. Opponents arc across the top of the mid row; the action
 * feed sits to the side; the resolution ceremony takes over full-screen on
 * settle/void. The market chart lives on the 3D board itself.
 */
export function Hud() {
  // While the table is filling, the full-surface WaitingRoom console owns the
  // screen (its own rails, seat ring, dock). Suppress the in-match chrome so the
  // two layouts don't stack; the brand + wallet header stays put in both.
  //
  // The join/create sheet lives on the Room page (discovery view), so a seated
  // player always arrives here already seated. But Room's "Watch →" (LiveNow)
  // also routes here to spectate someone else's hand, unauthenticated — `match
  // .yourSeat` is only set when a seat's wallet matches ours, so it's the ground
  // truth for "do I actually hold a seat here" regardless of how we arrived.
  const { active: waiting } = useWaiting()
  const inMatch = !waiting
  // Seated = you paid in. The engine seat number arrives a moment after the table locks;
  // the player panels must not wait for it — the seal box in particular has to be there the
  // instant sealing opens (a call entered before the seat resolves is held and sealed for you).
  // While the result card is up it owns the screen: the seat panels behind it only clutter
  // (they return for "Review table").
  const resultUp = useGameStore((s) => (s.settlement != null || s.voided != null) && !s.reviewing)
  const seatedHere = useGameStore((s) => s.match?.yourSeat != null || (s.seated && !s.settlement && !s.voided))
  return (
    <div className="hud">
      <SoundCues />
      {inMatch && <TableTalk />}
      <QuickCall />
      {inMatch && <Seats />}
      {inMatch && <TurnBanner />}

      <header className="hud-top">
        <Brand />
        <WalletMenu />
      </header>

      <PriceBoardTabs />

      {inMatch && (
        <div className="hud-mid">
          <ActionFeed />
        </div>
      )}

      {inMatch && !resultUp && (
        <footer className="hud-bottom">
          {seatedHere ? (
            <>
              <YourPosition />
              <BettingPanel />
            </>
          ) : (
            <SpectatorPanel />
          )}
          <RoundStatus />
        </footer>
      )}

      <WaitingRoom />
      <TxBanner />
      <TableNotice />
      <EarlyExit />
      <LeaveButton />
      <Resolution />
      <PriceChartOverlay />
    </div>
  )
}
