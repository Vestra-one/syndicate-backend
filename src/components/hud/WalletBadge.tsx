import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'

/**
 * Top-right wallet panel.
 *
 * Disconnected  → "Connect wallet" button (opens the Solana wallet modal).
 * Connected     → abbreviated address + on-chain chip balance.
 */
export function WalletBadge() {
  const address = useGameStore((s) => s.walletAddress)
  const balance = useGameStore((s) => s.chipBalance)
  const token = useGameStore((s) => s.terms?.chipsToken ?? 'USDC')

  const { connected, connecting, disconnecting } = useWallet()
  const { setVisible } = useWalletModal()

  const short = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : null

  // Not yet connected — show the connect button
  if (!connected && !connecting) {
    return (
      <button
        className="wallet-connect-btn panel"
        onClick={() => setVisible(true)}
        aria-label="Connect Solana wallet"
      >
        <span className="wallet-connect-icon">◎</span>
        Connect wallet
      </button>
    )
  }

  // In-flight states
  if (connecting || disconnecting) {
    return (
      <div className="wallet panel wallet--pending">
        <span className="eyebrow mono">{connecting ? 'Connecting…' : 'Disconnecting…'}</span>
      </div>
    )
  }

  // Connected
  return (
    <div className="wallet panel wallet--connected">
      <span className="wallet-addr mono">{short}</span>
      <span className="wallet-amount mono">
        {balance != null ? `${balance.toLocaleString()} ${token}` : '— ' + token}
      </span>
    </div>
  )
}
