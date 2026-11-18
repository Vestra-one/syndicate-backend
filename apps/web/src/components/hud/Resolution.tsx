import { hasHouseBots, isHouseBot } from '@/lib/houseBots'
import { useEffect, useRef, useState } from 'react'
import { readStats, recordHand, type SessionStats } from '@/lib/sessionStats'
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

/**
 * Shared footer: review the final table, leave to the lobby, or play on. At a house table
 * the next hand deals itself after a short countdown (`autoNext`) — a sitting, not a
 * string of separate visits — unless the player sits out.
 */
function CeremonyActions({ primary = 'again', autoNext = false }: { primary?: 'again'; autoNext?: boolean }) {
  const setReviewing = useGameStore((s) => s.setReviewing)
  const playAgain = useGameStore((s) => s.playAgain)
  const playHouse = useGameStore((s) => s.playHouse)
  const house = hasHouseBots()
  const leave = useGameStore((s) => s.leaveToDiscovery)
  const [left, setLeft] = useState(10)
  const [sitOut, setSitOut] = useState(false)
  const rolling = house && autoNext && !sitOut
  useEffect(() => {
    if (!rolling) return
    if (left <= 0) {
      void playHouse({ sit: true })
      return
    }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [rolling, left, playHouse])
  return (
    <div className="ceremony-actions">
      <button className="ghost-btn" onClick={() => { setSitOut(true); setReviewing(true) }}>
        Review table
      </button>
      <button className="ghost-btn" onClick={() => { setSitOut(true); leave() }}>
        {rolling ? 'Sit out' : 'Live tables'}
      </button>
      {house ? (
        <button className="ghost-btn ghost-btn--primary" onClick={() => void playHouse({ sit: true })}>
          {rolling ? `Next hand in ${left}` : 'Next hand'}
        </button>
      ) : (
        <button className={`ghost-btn ${primary === 'again' ? 'ghost-btn--primary' : ''}`} onClick={() => playAgain()}>
          Deal a new table
        </button>
      )}
    </div>
  )
}

/** When the ceremony is dismissed, a slim bar keeps the exits one click away. */
function ReviewBar() {
  const setReviewing = useGameStore((s) => s.setReviewing)
  const playAgain = useGameStore((s) => s.playAgain)
  const playHouse = useGameStore((s) => s.playHouse)
  const house = hasHouseBots()
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
      <button className="ghost-btn ghost-btn--primary" onClick={() => (house ? void playHouse({ sit: true }) : playAgain())}>
        {house ? 'Next hand' : 'Deal a new table'}
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
  payout: bigint
  /** Result for the hand: payout minus what the seat put in (buy-in + entry fee). */
  net: bigint
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
  const yourAward = settlement.awards.find((a) => a.seat === yourSeat)?.amount ?? 0n
  const won = yourAward > 0n

  const token = terms?.chipsToken ?? 'USDC'
  const payoutBySeat = new Map(settlement.awards.map((a) => [a.seat, a.amount]))
  // Every seat gets its un-bet stack back, so a raw payout ("0.98") reads like a win even
  // when the seat lost. What a player wants to know is the RESULT: payout − what they put in.
  const staked = (terms?.buyIn ?? 0n) + (terms?.entryFee ?? 0n)
  const amountsKnown = settlement.awards.some((a) => a.amount > 0n)
  const netOf = (seat: number) => (payoutBySeat.get(seat) ?? 0n) - staked
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
        payout: payoutBySeat.get(r.seat) ?? 0n,
        net: netOf(r.seat),
      }
    })
    .sort((a, b) => a.dist - b.dist)

  const active = ranked.filter((r) => !r.folded)
  const folded = ranked.filter((r) => r.folded)

  // Crown the paid seat when payout amounts are known; otherwise the closest active
  // conviction (the REST/on-chain recovery may know the reveal but not every seat's amount).
  const winnerSeat = settlement.awards[0]?.seat ?? active[0]?.seat

  // Rake transparency: the pot that was actually bet, and what the house took from it.
  // (Summing payouts would count every returned stack and make a 0.04 pot read as "2.00".)
  const paid = settlement.awards.reduce((s, a) => s + a.amount, 0n)
  const rake = settlement.rakeCollected ?? 0n
  const pot = settlement.finalPot ?? paid + rake
  const yourNet = yourSeat != null ? netOf(yourSeat) : 0n

  // You may receive a payout without being the winner: a conviction match returns a partial
  // share to non-winning seats too. Only the top-paid seat "won the pot".
  const isWinner = yourSeat != null && yourSeat === winnerSeat

  // Your run on this device: counted once per hand, shown under the result.
  const seats = useGameStore((s) => s.match?.seats)
  const walletOf = (seat: number) => seats?.find((x) => x.seat === seat)?.wallet ?? null
  const wallet = useGameStore((s) => s.walletAddress)
  const [run, setRun] = useState<SessionStats>(() => readStats(wallet))
  useEffect(() => {
    if (yourSeat == null || !amountsKnown) return
    // Head-to-head: against each rival still in the hand, who finished closer?
    const mine = ranked.find((r) => r.seat === yourSeat)
    const faced = ranked
      .filter((r) => r.seat !== yourSeat && walletOf(r.seat))
      .map((r) => ({
        wallet: walletOf(r.seat)!,
        beat: !!mine && !mine.folded && (r.folded || mine.dist < r.dist),
      }))
    setRun(recordHand(wallet, settlement.matchId, yourNet, isWinner, faced))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlement.matchId, amountsKnown, yourSeat, wallet])

  const recordFor = (seat: number): string | undefined => {
    const w = walletOf(seat)
    const r = w ? run.rivals?.[w] : undefined
    if (seat === yourSeat || !r || r.w + r.l < 2) return undefined
    return r.w > r.l ? `you lead ${r.w}–${r.l}` : r.w < r.l ? `leads you ${r.l}–${r.w}` : `level ${r.w}–${r.l}`
  }

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

  // Winnings come back on their own: the claim is sent a moment after the reveal, so the
  // next hand is one click away. The button stays as the fallback if the wallet declines.
  const autoClaimed = useRef(false)
  useEffect(() => {
    if (autoClaimed.current || !amountsKnown || yourAward <= 0n || tx) return
    // Marked inside the timer: the amounts can still be refined in the first seconds,
    // which re-runs this effect and must not cancel the claim for good.
    const t = setTimeout(() => {
      autoClaimed.current = true
      void onClaim()
    }, 2500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountsKnown, yourAward, tx])

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
          <span className="reveal-col-dist">Off by</span>
          <span className="reveal-col-pay">Result</span>
        </div>

        <ul className="reveal-list">
          {active.map((r, i) => (
            <RevealRow key={r.seat} r={r} rank={i + 1} winner={r.seat === winnerSeat} yourSeat={yourSeat} decimals={decimals} token={token} amountsKnown={amountsKnown} delay={i * 280 + 400} record={recordFor(r.seat)} />
          ))}
        </ul>

        {folded.length > 0 && (
          <div className="reveal-folded-section">
            <div className="reveal-folded-head eyebrow">Folded — forfeited pot share</div>
            <ul className="reveal-list">
              {folded.map((r) => (
                <RevealRow key={r.seat} r={r} rank={null} winner={false} yourSeat={yourSeat} decimals={decimals} token={token} amountsKnown={amountsKnown} delay={0} record={recordFor(r.seat)} />
              ))}
            </ul>
          </div>
        )}

        <div className="ceremony-rake eyebrow">
          Pot <span className="mono">{formatChips(pot, token)}</span>
          <span className="ceremony-rake-sep">·</span>
          rake <span className="mono">{formatChips(rake, token)} {token}</span>
        </div>

        <div className={`ceremony-result ${won ? 'ceremony-result--win' : ''}`}>
          {!won
            ? amountsKnown ? 'No award this match' : 'Working out the payouts…'
            : isWinner
              ? `You won the pot — ${signedChips(yourNet, token)} ${token}`
              : yourNet < 0n
                ? `Down ${formatChips(-yourNet, token)} ${token} this hand · ${formatMoney(yourAward, token)} back to you`
                : `Even this hand · ${formatMoney(yourAward, token)} back to you`}
        </div>
        {run.hands > 0 && (
          <div className="ceremony-run eyebrow">
            your run · {run.hands} hand{run.hands === 1 ? '' : 's'} · {signedChips(BigInt(run.net), token)} {token}
            {run.streak >= 2 ? ` · ${run.streak} wins in a row` : ''}
            {(run.days ?? 0) >= 2 ? ` · day ${run.days} at the table` : ''}
          </div>
        )}

        {won && (
          <button className="seal-btn ceremony-claim" onClick={onClaim} disabled={claiming || !!tx}>
            {tx ? 'Claimed ✓' : claiming ? 'Claiming…' : `Claim ${formatMoney(yourAward, token)}`}
          </button>
        )}
        {claimError && <div className="ceremony-error eyebrow" role="alert">{claimError}</div>}

        <CeremonyActions autoNext={amountsKnown && (!!tx || yourAward === 0n) && !!seats?.some((x) => x.seat !== yourSeat && isHouseBot(x.wallet))} />
      </div>
    </div>
  )
}

/** "+0.02" / "−0.02" / "0.00" — a hand result, always signed. */
function signedChips(net: bigint, token: string): string {
  if (net === 0n) return formatChips(0n, token)
  return `${net > 0n ? '+' : '−'}${formatChips(net > 0n ? net : -net, token)}`
}

function RevealRow({
  r, rank, winner, yourSeat, decimals, token, amountsKnown, delay, record,
}: {
  r: RankedRow
  rank: number | null
  winner: boolean
  yourSeat: number | undefined
  decimals: number
  token: string
  amountsKnown: boolean
  delay: number
  record?: string
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
        {record && <small className="reveal-record">{record}</small>}
      </span>
      <span className="reveal-pred mono reveal-col-pred">{formatPrice(predFloat)}</span>
      <span className={`reveal-dist mono reveal-col-dist reveal-dist--${r.dir}`}>
        {r.dir === 'exact'
          ? 'exact'
          : `${r.dist.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${r.dir}`}
      </span>
      <span className={`reveal-pay mono reveal-col-pay ${amountsKnown ? (r.net > 0n ? 'reveal-pay--up' : r.net < 0n ? 'reveal-pay--down' : '') : ''}`}>
        {amountsKnown ? signedChips(r.net, token) : '—'}
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
  const buyIn = terms?.buyIn ?? 0n
  const entry = terms?.entryFee ?? 0n
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

        {total > 0n && (
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
