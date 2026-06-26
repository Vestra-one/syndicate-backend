import { useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { formatPrice } from '@/lib/format'
import { seatAlias } from '@/lib/seats'

/**
 * The resolution ceremony — a premium moment, not an instant pop (§10.6).
 * On SETTLED: open the settlement price, reveal every prediction (incl. folders,
 * §10.2) ranked by closeness, crown the winner, and enable claim.
 * On VOID: a reassuring full-refund path (§9, §10.4) — never framed as a loss.
 */
export function Resolution() {
  const settlement = useGameStore((s) => s.settlement)
  const voided = useGameStore((s) => s.voided)
  const reviewing = useGameStore((s) => s.reviewing)
  if (!settlement && !voided) return null
  if (reviewing) return <ReviewBar />
  return voided ? <VoidCeremony reason={voided.reason} /> : <SettledCeremony />
}

/** Shared footer: leave to inspect the final table, or jump into a fresh match. */
function CeremonyActions() {
  const setReviewing = useGameStore((s) => s.setReviewing)
  const playAgain = useGameStore((s) => s.playAgain)
  return (
    <div className="ceremony-actions">
      <button className="ghost-btn" onClick={() => setReviewing(true)}>
        Review table
      </button>
      <button className="ghost-btn ghost-btn--primary" onClick={() => playAgain()}>
        Play again
      </button>
    </div>
  )
}

/** When the ceremony is dismissed, a slim bar keeps the exits one click away. */
function ReviewBar() {
  const setReviewing = useGameStore((s) => s.setReviewing)
  const playAgain = useGameStore((s) => s.playAgain)
  return (
    <div className="review-bar panel">
      <span className="eyebrow">match over</span>
      <button className="ghost-btn" onClick={() => setReviewing(false)}>
        Show results
      </button>
      <button className="ghost-btn ghost-btn--primary" onClick={() => playAgain()}>
        Play again
      </button>
    </div>
  )
}

function SettledCeremony() {
  const settlement = useGameStore((s) => s.settlement)!
  const match = useGameStore((s) => s.match)
  const terms = useGameStore((s) => s.terms)
  const claim = useGameStore((s) => s.claim)
  const [tx, setTx] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)

  const decimals = terms?.decimals ?? 2
  const toFloat = (p: number) => p / 10 ** decimals
  const settlePrice = toFloat(settlement.settlementPrice)
  const yourSeat = match?.yourSeat
  const yourAward = settlement.awards.find((a) => a.seat === yourSeat)?.amount ?? 0
  const won = yourAward > 0
  const winnerSeat = settlement.awards[0]?.seat

  const foldedSeats = new Set(match?.seats.filter((s) => s.folded).map((s) => s.seat))
  const ranked = [...settlement.revealedPredictions]
    .map((r) => ({
      ...r,
      dist: Math.abs(toFloat(r.prediction) - settlePrice),
      folded: foldedSeats.has(r.seat),
    }))
    .sort((a, b) => a.dist - b.dist)

  const onClaim = async () => {
    setClaiming(true)
    setTx(await claim())
    setClaiming(false)
  }

  return (
    <div className="ceremony">
      <div className="ceremony-card panel">
        <div className="ceremony-eyebrow eyebrow">settlement · {terms?.priceFeedId ?? 'BTC/USD'}</div>
        <div className="ceremony-price mono">{formatPrice(settlePrice)}</div>
        <div className="ceremony-sub eyebrow">the closest conviction takes the pot</div>

        <ul className="reveal-list">
          {ranked.map((r, i) => (
            <li
              key={r.seat}
              className={`reveal-row ${r.seat === winnerSeat ? 'reveal-row--win' : ''} ${r.folded ? 'reveal-row--folded' : ''}`}
              style={{ animationDelay: `${i * 320 + 400}ms` }}
            >
              <span className="reveal-rank mono">{r.seat === winnerSeat ? '♛' : i + 1}</span>
              <span className="reveal-name">
                {seatAlias(r.seat, yourSeat)}
                {r.folded && <span className="reveal-folded"> folded</span>}
              </span>
              <span className="reveal-pred mono">{formatPrice(toFloat(r.prediction))}</span>
              <span className="reveal-dist mono">±{r.dist.toFixed(decimals)}</span>
            </li>
          ))}
        </ul>

        <div className={`ceremony-result ${won ? 'ceremony-result--win' : ''}`}>
          {won ? `You won the pot — ${yourAward} ${terms?.chipsToken ?? 'USDC'}` : 'No award this match'}
        </div>

        {won && (
          <button className="seal-btn ceremony-claim" onClick={onClaim} disabled={claiming || !!tx}>
            {tx ? 'Claimed ✓' : claiming ? 'Claiming…' : `Claim ${yourAward}`}
          </button>
        )}

        <CeremonyActions />
      </div>
    </div>
  )
}

function VoidCeremony({ reason }: { reason: string }) {
  const refund = useGameStore((s) => s.refund)
  const [tx, setTx] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onRefund = async () => {
    setBusy(true)
    setTx(await refund())
    setBusy(false)
  }

  return (
    <div className="ceremony">
      <div className="ceremony-card panel">
        <div className="ceremony-eyebrow eyebrow">match voided</div>
        <div className="ceremony-void-title">Your funds are safe</div>
        <p className="ceremony-void-note">
          The match was voided ({reason}). Your buy-in and entry fee are returned in full — this is
          not a loss.
        </p>
        <button className="seal-btn ceremony-claim" onClick={onRefund} disabled={busy || !!tx}>
          {tx ? 'Refunded ✓' : busy ? 'Refunding…' : `Refund deposit + entry fee`}
        </button>

        <CeremonyActions />
      </div>
    </div>
  )
}
