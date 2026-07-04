import { useGameStore } from '@/store/gameStore'
import { formatMoney, formatPrice } from '@/lib/format'
import type { DefaultAction } from '@/lib/protocol'

/**
 * "Your position" — the self-centric panel (replaces the old per-bet list).
 * Shows your sealed prediction (visible ONLY to you, §10.2), live distance to
 * conviction, exposure, and the pre-signed timeout default (§10.3).
 * Cross-match history is a separate surface (§8).
 */
export function YourPosition() {
  const terms = useGameStore((s) => s.terms)
  const match = useGameStore((s) => s.match)
  const sealStatus = useGameStore((s) => s.sealStatus)
  const prediction = useGameStore((s) => s.yourPrediction)
  const lastPrice = useGameStore((s) => s.priceHistory.at(-1)?.price ?? null)

  const decimals = terms?.decimals ?? 2
  const token = terms?.chipsToken ?? 'USDC'
  const predFloat = prediction != null ? prediction / 10 ** decimals : null
  const distance = predFloat != null && lastPrice != null ? lastPrice - predFloat : null
  const live = match?.phase === 'LIVE'
  const money = (v: number) =>
    v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

  return (
    <div className="position panel">
      <div className="panel-title">Your position</div>

      <div className="position-pred">
        <span className="eyebrow">your sealed prediction</span>
        {sealStatus === 'sealed' && predFloat != null ? (
          <span className="position-pred-value mono">{formatPrice(predFloat)}</span>
        ) : (
          <span className="position-pred-empty eyebrow">
            {sealStatus === 'sealed'
              ? '🔒 sealed' // recovered after a reload — the plaintext never leaves the old device
              : sealStatus === 'sealing'
                ? 'sealing…'
                : 'not sealed yet'}
          </span>
        )}
      </div>

      {distance != null && (
        <div className="position-dist">
          <span className="eyebrow">market vs. your call</span>
          <span className={`mono ${distance >= 0 ? 'up' : 'down'}`}>
            ${money(Math.abs(distance))} {distance >= 0 ? 'above' : 'below'}
          </span>
        </div>
      )}

      {match?.yourSeat != null && (
        <div className="position-row eyebrow">
          <span>seat {match.yourSeat + 1}</span>
          <span className="mono">stack {formatMoney(match.yourStack ?? 0, token)}</span>
          <span className="mono">committed {formatMoney(match.yourExposure ?? 0, token)}</span>
        </div>
      )}

      {live && <DefaultToggle />}
    </div>
  )
}

const DEFAULTS: { key: DefaultAction; label: string }[] = [
  { key: 'check_fold', label: 'Check / Fold' },
  { key: 'check_call_any', label: 'Check / Call' },
]

function DefaultToggle() {
  const current = useGameStore((s) => s.defaultAction)
  const setDefault = useGameStore((s) => s.setDefault)
  return (
    <div className="position-default">
      <span className="eyebrow">if you time out</span>
      <div className="default-chips">
        {DEFAULTS.map((d) => (
          <button
            key={d.key}
            className={`chip ${current === d.key ? 'chip--active' : ''}`}
            onClick={() => setDefault(d.key)}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>
  )
}
