import { useState, useEffect } from 'react'
import { Brand } from './Brand'
import { WalletBadge } from './WalletBadge'
import { RoundStatus } from './RoundStatus'
import { BettingPanel } from './BettingPanel'
import { YourPosition } from './YourPosition'
import { Seats } from './Seats'
import { ActionFeed } from './ActionFeed'
import { Resolution } from './Resolution'
import { Lobby } from './Lobby'
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
  return (
    <div className="hud">
      <Seats />

      <header className="hud-top">
        <Brand />
        <WalletBadge />
      </header>

      <div className="hud-mid">
        <ActionFeed />
      </div>

      <footer className="hud-bottom">
        <YourPosition />
        <BettingPanel />
        <RoundStatus />
      </footer>

      <TxBanner />
      <Lobby />
      <Resolution />
    </div>
  )
}
