import { useGameStore } from '@/store/gameStore'
import { formatMoney, formatPrice } from '@/lib/format'
import type { DefaultAction } from '@/lib/protocol'
import { edgeRead, typicalMove } from '@/lib/edge'
import { useNow } from '@/lib/useNow'

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
  const sealClosed = useGameStore((s) => s.sealClosed)
  const prediction = useGameStore((s) => s.yourPrediction)
  const lastPrice = useGameStore((s) => s.priceHistory.at(-1)?.price ?? null)
  // On your turn the action panel below shows to-call / committed / stack — so this
  // panel drops the duplicated money figures and keeps only the seat reference.
  const yourTurn = useGameStore((s) => s.yourTurn)

  const decimals = terms?.decimals ?? 2
  const token = terms?.chipsToken ?? 'USDC'
  const predFloat = prediction != null ? prediction / 10 ** decimals : null
  const distance = predFloat != null && lastPrice != null ? lastPrice - predFloat : null
  const live = match?.phase === 'LIVE'
  // Edge: the gap to your call against how far the market typically travels before
  // settlement. Public data only — it says nothing about anyone else's call.
  const history = useGameStore((s) => s.priceHistory)
  const settlesAt = useGameStore((s) => s.streetSchedule?.at(-1)?.end ?? null)
  const now = useNow(1000)
  const secLeft = settlesAt != null ? Math.max(0, (settlesAt - now) / 1000) : null
  const move = live && secLeft != null && secLeft > 0 ? typicalMove(history, secLeft) : null
  const edge = distance != null && move != null ? edgeRead(distance, move) : null
  // The window closed and we never sealed — the prediction defaulted, and that
  // fact must persist through settlement so the final ranking stays explicable (§16).
  const defaulted = sealClosed && sealStatus !== 'sealed'
  const money = (v: number) =>
    v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

  return (
    <div className={`position panel ${defaulted ? 'position--defaulted' : ''}`}>
      <div className="panel-title">Your position</div>

      {defaulted && (
        <div className="position-defaulted-flag">
          <span aria-hidden="true">⚠</span> NOT SEALED — defaulted to market at close
        </div>
      )}

      <div className="position-pred">
        <span className="eyebrow">your sealed prediction</span>
        {sealStatus === 'sealed' && predFloat != null ? (
          <span className="position-pred-value mono">{formatPrice(predFloat)}</span>
        ) : (
          <span className="position-pred-empty eyebrow">
            {defaulted
              ? 'not sealed — you are playing the market price at close'
              : sealStatus === 'sealed'
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

      {edge && move != null && (
        <div className={`position-edge position-edge--${edge.level}`} title="How close the market is to your call, measured against how far it typically travels in the time left. It knows nothing about the other calls.">
          <div className="position-edge-head">
            <span className="eyebrow">your call</span>
            <span className="position-edge-label">{edge.label}</span>
          </div>
          <div className="position-edge-bar" aria-hidden="true"><span style={{ width: `${Math.round(edge.fill * 100)}%` }} /></div>
          <span className="position-edge-note eyebrow">
            typical move left ±${money(move)}
          </span>
          <span className="position-edge-tip">{edge.tip}</span>
        </div>
      )}

      {match?.yourSeat != null && (
        <div className="position-row eyebrow">
          <span>seat {match.yourSeat + 1}</span>
          {yourTurn == null && (
            <>
              {/* Stacks only exist once the hand is live; before that the seat holds its buy-in. */}
              <span className="mono">stack {formatMoney(match.phase === 'FILLING' || match.phase === 'SEALING' ? (terms?.buyIn ?? 0n) : (match.yourStack ?? 0), token)}</span>
              <span className="mono">committed {formatMoney(match.yourExposure ?? 0, token)}</span>
            </>
          )}
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
