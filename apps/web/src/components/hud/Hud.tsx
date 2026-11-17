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
  const seated = useGameStore((s) => s.seated)
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

function TxBanner() {
  const lastTx = useGameStore((s) => s.lastTx)
  const [dismissed, setDismissed] = useState(false)

  // Reset dismissed when a new tx comes in, then auto-dismiss after 10s so the
  // banner doesn't linger on top of the table once the confirmation has landed.
  useEffect(() => {
    if (!lastTx) return
    setDismissed(false)
    const t = setTimeout(() => setDismissed(true), 10_000)
    return () => clearTimeout(t)
  }, [lastTx])

  if (!lastTx || dismissed) return null

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
  const seatedHere = useGameStore((s) => s.match?.yourSeat != null)
  return (
    <div className="hud">
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

      {inMatch && (
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
      <Resolution />
      <PriceChartOverlay />
    </div>
  )
}
