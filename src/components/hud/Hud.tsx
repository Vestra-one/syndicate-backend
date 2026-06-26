import { Brand } from './Brand'
import { WalletBadge } from './WalletBadge'
import { RoundStatus } from './RoundStatus'
import { BettingPanel } from './BettingPanel'
import { YourPosition } from './YourPosition'
import { Seats } from './Seats'
import { ActionFeed } from './ActionFeed'
import { Resolution } from './Resolution'
import { Lobby } from './Lobby'
import './hud.css'

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

      <Lobby />
      <Resolution />
    </div>
  )
}
