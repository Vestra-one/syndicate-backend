import { useGameStore } from '@/store/gameStore'
import { formatAmount } from '@/lib/format'

export function WalletBadge() {
  const wallet = useGameStore((s) => s.wallet)
  return (
    <div className="wallet panel">
      <span className="eyebrow">balance</span>
      <span className="wallet-amount mono">{formatAmount(wallet.balance, wallet.currency)}</span>
    </div>
  )
}
