import { useState, useEffect } from 'react'
import { Brand } from './Brand'
import { WalletMenu } from './WalletMenu'
import { RoundStatus } from './RoundStatus'
import { BettingPanel } from './BettingPanel'
import { YourPosition } from './YourPosition'
import { Seats } from './Seats'
import { ActionFeed } from './ActionFeed'
import { Resolution } from './Resolution'
import { Lobby } from './Lobby'
import { TxCeremony } from './TxCeremony'
import { WaitingRoom, useWaiting } from './WaitingRoom'
import { useGameStore } from '@/store/gameStore'
import './hud.css'

function TxBanner() {
  const lastTx = useGameStore((s) => s.lastTx)
  const [dismissed, setDismissed] = useState(false)

  // Reset dismissed when a new tx comes in
  useEffect(() => {
    if (lastTx) setDismissed(false)
  }, [lastTx])

  if (!lastTx || dismissed) return null

  const explorerUrl = `https://explorer.solana.com/tx/${lastTx.sig}?cluster=devnet`

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
  const { active: waiting } = useWaiting()
  return (
    <div className="hud">
      {!waiting && <Seats />}

      <header className="hud-top">
        <Brand />
        <WalletMenu />
      </header>

      {!waiting && (
        <div className="hud-mid">
          <ActionFeed />
        </div>
      )}

      {!waiting && (
        <footer className="hud-bottom">
          <YourPosition />
          <BettingPanel />
          <RoundStatus />
        </footer>
      )}

      <WaitingRoom />
      <TxBanner />
      <Lobby />
      <TxCeremony />
      <Resolution />
    </div>
  )
}
