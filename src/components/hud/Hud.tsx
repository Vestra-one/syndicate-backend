import { Brand } from './Brand'
import { WalletBadge } from './WalletBadge'
import { RoundStatus } from './RoundStatus'
import { BettingPanel } from './BettingPanel'
import { YourPosition } from './YourPosition'
import './hud.css'

/**
 * The 2D overlay layer. Three rows (top / spacer / bottom) so the table stays
 * visible and centered. The market chart lives on the 3D board itself.
 */
export function Hud() {
  return (
    <div className="hud">
      <header className="hud-top">
        <Brand />
        <WalletBadge />
      </header>

      <div className="hud-mid" />

      <footer className="hud-bottom">
        <YourPosition />
        <BettingPanel />
        <RoundStatus />
      </footer>
    </div>
  )
}
