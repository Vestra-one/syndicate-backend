import { useRef } from 'react'
import { useGameStore } from '@/store/gameStore'
import { formatPrice, formatSigned } from '@/lib/format'

export function PriceTicker() {
  const market = useGameStore((s) => s.market)
  const price = useGameStore((s) => s.price)
  const history = useGameStore((s) => s.priceHistory)

  // direction of the most recent move, for the up/down tint
  const prev = useRef<number | null>(null)
  const last = history.length ? history[history.length - 1].price : null
  const dir = last != null && prev.current != null ? Math.sign(last - prev.current) : 0
  if (last != null) prev.current = last

  const first = history.length ? history[0].price : null
  const change = first != null && price != null ? ((price - first) / first) * 100 : 0

  return (
    <div className="ticker panel">
      <div className="ticker-market">
        <span className="eyebrow">market</span>
        <span className="ticker-symbol">{market}</span>
      </div>
      <div className={`ticker-price mono ${dir > 0 ? 'up' : dir < 0 ? 'down' : ''}`}>
        {formatPrice(price, 'USD')}
      </div>
      <div className={`ticker-change mono ${change >= 0 ? 'up' : 'down'}`}>
        {formatSigned(change)}%
      </div>
    </div>
  )
}
