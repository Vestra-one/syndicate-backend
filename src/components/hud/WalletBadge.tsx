import { useGameStore } from '@/store/gameStore'

/** Connected wallet identity + on-chain chip balance (§3, §7). */
export function WalletBadge() {
  const address = useGameStore((s) => s.walletAddress)
  const balance = useGameStore((s) => s.chipBalance)
  const token = useGameStore((s) => s.terms?.chipsToken ?? 'USDC')

  const short = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : 'not connected'

  return (
    <div className="wallet panel">
      <span className="eyebrow mono">{short}</span>
      <span className="wallet-amount mono">
        {balance != null ? `${balance} ${token}` : '—'}
      </span>
    </div>
  )
}
