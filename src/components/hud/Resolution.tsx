import { useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { formatPrice, formatMoney, formatChips } from '@/lib/format'
import { seatAlias } from '@/lib/seats'
import type { VoidReason } from '@/lib/protocol'

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

/** Shared footer: review the final table, leave to the lobby, or rematch. */
function CeremonyActions({ primary = 'again' }: { primary?: 'again' }) {
  const setReviewing = useGameStore((s) => s.setReviewing)
  const playAgain = useGameStore((s) => s.playAgain)
  const leave = useGameStore((s) => s.leaveToDiscovery)
  return (
    <div className="ceremony-actions">
      <button className="ghost-btn" onClick={() => setReviewing(true)}>
        Review table
      </button>
      <button className="ghost-btn" onClick={() => leave()}>
        Live tables
      </button>
      <button className={`ghost-btn ${primary === 'again' ? 'ghost-btn--primary' : ''}`} onClick={() => playAgain()}>
        Deal a new table
      </button>
    </div>
  )
}

/** When the ceremony is dismissed, a slim bar keeps the exits one click away. */
function ReviewBar() {
  const setReviewing = useGameStore((s) => s.setReviewing)
  const playAgain = useGameStore((s) => s.playAgain)
  const leave = useGameStore((s) => s.leaveToDiscovery)
  return (
    <div className="review-bar panel">
      <span className="eyebrow">match over</span>
      <button className="ghost-btn" onClick={() => setReviewing(false)}>
        Show results
      </button>
      <button className="ghost-btn" onClick={() => leave()}>
        Live tables
      </button>
      <button className="ghost-btn ghost-btn--primary" onClick={() => playAgain()}>
        Deal a new table
      </button>
    </div>
  )
}

interface RankedRow {
  seat: number
  prediction: number
  dist: number
  dir: 'above' | 'below' | 'exact'
  folded: boolean
  payout: number
}

function SettledCeremony() {
  const settlement = useGameStore((s) => s.settlement)!
  const match = useGameStore((s) => s.match)
  const terms = useGameStore((s) => s.terms)
  const claim = useGameStore((s) => s.claim)
  const [tx, setTx] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [claimError, setClaimError] = useState<string | null>(null)

  const decimals = terms?.decimals ?? 2
  const toFloat = (p: number) => p / 10 ** decimals
  const settlePrice = toFloat(settlement.settlementPrice)
  const yourSeat = match?.yourSeat
  const yourAward = settlement.awards.find((a) => a.seat === yourSeat)?.amount ?? 0
  const won = yourAward > 0

  const token = terms?.chipsToken ?? 'USDC'
  const payoutBySeat = new Map(settlement.awards.map((a) => [a.seat, a.amount]))
  const foldedSeats = new Set(match?.seats.filter((s) => s.folded).map((s) => s.seat))

  const ranked: RankedRow[] = [...settlement.revealedPredictions]
    .map((r) => {
      const predFloat = toFloat(r.prediction)
      return {
        seat: r.seat,
        prediction: r.prediction,
        dist: Math.abs(predFloat - settlePrice),
        dir: (predFloat > settlePrice ? 'above' : predFloat < settlePrice ? 'below' : 'exact') as RankedRow['dir'],
        folded: foldedSeats.has(r.seat),
        payout: payoutBySeat.get(r.seat) ?? 0,
      }
    })
    .sort((a, b) => a.dist - b.dist)

  const active = ranked.filter((r) => !r.folded)
  const folded = ranked.filter((r) => r.folded)

  // Crown the paid seat when payout amounts are known; otherwise the closest active
  // conviction (the REST/on-chain recovery may know the reveal but not every seat's amount).
  const winnerSeat = settlement.awards[0]?.seat ?? active[0]?.seat

  // Rake transparency: the pot everyone contributed, what the house took, what was paid out.
  const paid = settlement.awards.reduce((s, a) => s + a.amount, 0)
  const rake = settlement.rakeCollected ?? 0
  const pot = paid + rake

  const onClaim = async () => {
    setClaiming(true)
    setClaimError(null)
    try {
      setTx(await claim())
    } catch (e) {
      // A declined wallet prompt or failed tx must never brick the button on "Claiming…".
      setClaimError(e instanceof Error ? e.message : 'Claim failed — please try again.')
    } finally {
      setClaiming(false)
    }
  }

  return (
    <div className="ceremony">
      <div className="ceremony-card panel">
        <div className="ceremony-eyebrow eyebrow">settlement · {terms?.priceFeedId ?? 'BTC/USD'}</div>
        <div className="ceremony-price mono">{formatPrice(settlePrice)}</div>
        <div className="ceremony-sub eyebrow">the closest conviction takes the pot</div>

        <div className="reveal-head">
          <span className="reveal-col-rank">#</span>
          <span className="reveal-col-name">Player</span>
          <span className="reveal-col-pred">Sealed call</span>
          <span className="reveal-col-dist">Δ from settle</span>
          <span className="reveal-col-pay">Payout</span>
        </div>

        <ul className="reveal-list">
          {active.map((r, i) => (
            <RevealRow key={r.seat} r={r} rank={i + 1} winner={r.seat === winnerSeat} yourSeat={yourSeat} decimals={decimals} token={token} delay={i * 280 + 400} />
          ))}
        </ul>

        {folded.length > 0 && (
          <div className="reveal-folded-section">
            <div className="reveal-folded-head eyebrow">Folded — forfeited pot share</div>
            <ul className="reveal-list">
              {folded.map((r) => (
                <RevealRow key={r.seat} r={r} rank={null} winner={false} yourSeat={yourSeat} decimals={decimals} token={token} delay={0} />
              ))}
            </ul>
          </div>
        )}

        <div className="ceremony-rake eyebrow">
          Pot <span className="mono">{formatChips(pot, token)}</span>
          <span className="ceremony-rake-sep">·</span>
          rake <span className="mono">{formatChips(rake, token)}</span>
          <span className="ceremony-rake-sep">·</span>
          paid <span className="mono">{formatChips(paid, token)} {token}</span>
        </div>

        <div className={`ceremony-result ${won ? 'ceremony-result--win' : ''}`}>
          {won ? `You won the pot — ${formatMoney(yourAward, token)}` : 'No award this match'}
        </div>

        {won && (
          <button className="seal-btn ceremony-claim" onClick={onClaim} disabled={claiming || !!tx}>
            {tx ? 'Claimed ✓' : claiming ? 'Claiming…' : `Claim ${formatMoney(yourAward, token)}`}
          </button>
        )}
        {claimError && <div className="ceremony-error eyebrow" role="alert">{claimError}</div>}

        <CeremonyActions />
      </div>
    </div>
  )
}

function RevealRow({
  r, rank, winner, yourSeat, decimals, token, delay,
}: {
  r: RankedRow
  rank: number | null
  winner: boolean
  yourSeat: number | undefined
  decimals: number
  token: string
  delay: number
}) {
  const predFloat = r.prediction / 10 ** decimals
  return (
    <li
      className={`reveal-row ${winner ? 'reveal-row--win' : ''} ${r.folded ? 'reveal-row--folded' : ''}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="reveal-rank mono reveal-col-rank">{winner ? '♛' : rank ?? '—'}</span>
      <span className="reveal-name reveal-col-name">
        {seatAlias(r.seat, yourSeat)}
        {r.seat === yourSeat && <span className="reveal-you"> · you</span>}
      </span>
      <span className="reveal-pred mono reveal-col-pred">{formatPrice(predFloat)}</span>
      <span className={`reveal-dist mono reveal-col-dist reveal-dist--${r.dir}`}>
        {r.dir === 'exact'
          ? 'exact'
          : `${r.dist.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${r.dir}`}
      </span>
      <span className="reveal-pay mono reveal-col-pay">
        {r.folded ? '—' : r.payout > 0 ? formatChips(r.payout, token) : '—'}
      </span>
    </li>
  )
}

/** Map a raw void enum to human copy — the enum name must never reach the player (§19). */
function voidReasonCopy(reason: VoidReason): string {
  switch (reason) {
    case 'NotEnoughPlayers':
      return 'Not enough players joined before the window closed.'
    case 'OracleDegraded':
      return 'The price oracle became unavailable, so the match couldn’t settle fairly.'
    case 'TimelockUnavailable':
      return 'The time-lock service was unavailable to open the sealed predictions.'
    case 'MissingPrediction':
      return 'A sealed prediction couldn’t be opened at settlement.'
    case 'EngineIncomplete':
      return 'The match engine didn’t complete the hand.'
    case 'ConservationFailure':
      return 'A settlement safety check failed, so the hand was voided to protect funds.'
    default:
      return 'This match was voided before it could settle.'
  }
}

function VoidCeremony({ reason }: { reason: VoidReason }) {
  const refund = useGameStore((s) => s.refund)
  const terms = useGameStore((s) => s.terms)
  const [tx, setTx] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refundError, setRefundError] = useState<string | null>(null)

  const token = terms?.chipsToken ?? 'USDC'
  const buyIn = terms?.buyIn ?? 0
  const entry = terms?.entryFee ?? 0
  const total = buyIn + entry

  const onRefund = async () => {
    setBusy(true)
    setRefundError(null)
    try {
      setTx(await refund())
    } catch (e) {
      setRefundError(e instanceof Error ? e.message : 'Refund failed — please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ceremony">
      <div className="ceremony-card panel">
        <div className="ceremony-eyebrow eyebrow">match voided</div>
        <div className="ceremony-void-title">Your funds are safe</div>
        <p className="ceremony-void-note">
          {voidReasonCopy(reason)} Your buy-in and entry fee are returned in full — this is not a loss.
        </p>

        {total > 0 && (
          <div className="ceremony-refund-breakdown eyebrow">
            <span>Buy-in <span className="mono">{formatChips(buyIn, token)}</span></span>
            <span className="ceremony-rake-sep">+</span>
            <span>entry <span className="mono">{formatChips(entry, token)}</span></span>
            <span className="ceremony-rake-sep">=</span>
            <span className="mono">{formatChips(total, token)} {token}</span>
          </div>
        )}

        <button className="seal-btn ceremony-claim" onClick={onRefund} disabled={busy || !!tx}>
          {tx ? 'Refunded ✓' : busy ? 'Refunding…' : `Claim refund · ${formatMoney(total, token)}`}
        </button>
        {refundError && <div className="ceremony-error eyebrow" role="alert">{refundError}</div>}

        <CeremonyActions />
      </div>
    </div>
  )
}
