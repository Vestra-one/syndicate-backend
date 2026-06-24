import { Brand } from './Brand'
import { PriceTicker } from './PriceTicker'
import { WalletBadge } from './WalletBadge'
import { RoundStatus } from './RoundStatus'
import { BettingPanel } from './BettingPanel'
import { MyBets } from './MyBets'
import './hud.css'

/**
 * The 2D overlay layer. Structured as three rows (top / spacer / bottom) so the
 * table stays visible and centered. New gameplay surfaces (chat, leaderboard,
 * seat actions) slot into these regions as we build the table up step by step.
 */
export function Hud() {
  return (
    <div className="hud">
      <header className="hud-top">
        <Brand />
        <PriceTicker />
        <WalletBadge />
      </header>

      <div className="hud-mid" />

      <footer className="hud-bottom">
        <MyBets />
        <BettingPanel />
        <RoundStatus />
      </footer>
    </div>
  )
}
