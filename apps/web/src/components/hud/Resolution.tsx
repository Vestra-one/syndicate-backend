import { displayName } from '@/lib/seats'
import { recordReads } from '@/lib/reads'
import { hasHouseBots, isHouseBot } from '@/lib/houseBots'
import { useEffect, useRef, useState } from 'react'
import { HAND_FIBS, WIN_FIBS, adoptServerFibs, levelOf, nextGoal, readStats, recordHand, type SessionStats } from '@/lib/sessionStats'
import { useGameStore } from '@/store/gameStore'
import { formatPrice, formatMoney, formatChips } from '@/lib/format'
import { seatAlias } from '@/lib/seats'
import { getFibsBoard, reportFibs } from '@/lib/api'
import type { VoidReason } from '@/lib/protocol'

const STEP_MS = 850 // between one call turning over and the next

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
/** Your own number against the price when a hand ended without a showdown — latched once
 *  per hand so the line does not drift as the live price keeps moving. */
const heldLatch = new Map<string, { dist: number; close: boolean } | null>()
function heldAtEnd(matchId: string): { dist: number; close: boolean } | null {
  if (heldLatch.has(matchId)) return heldLatch.get(matchId) ?? null
  const st = useGameStore.getState()
  const scale = 10 ** (st.terms?.decimals ?? 2)
  const last = st.priceHistory.at(-1)?.price
  const call = st.yourPrediction != null ? Number(st.yourPrediction) / scale : null
  const out = last != null && call != null ? { dist: Math.abs(last - call), close: Math.abs(last - call) <= last * 0.0005 } : null
  heldLatch.set(matchId, out)
  return out
}

function CeremonyActions({ primary = 'again', autoNext = false }: { primary?: 'again'; autoNext?: boolean }) {
  const setReviewing = useGameStore((s) => s.setReviewing)
  const playAgain = useGameStore((s) => s.playAgain)
  const playHouse = useGameStore((s) => s.playHouse)
  const house = hasHouseBots()
  const leave = useGameStore((s) => s.leaveToDiscovery)
  const rematch = useGameStore((s) => s.rematch)
  const nextTable = useGameStore((s) => s.nextTable)
  const followTable = useGameStore((s) => s.followTable)
  // The finished table can no longer tell us anything, so ask: has anyone dealt it again?
  const checkNextTable = useGameStore((s) => s.checkNextTable)
  useEffect(() => {
    if (nextTable) return
    let n = 0
    const t = setInterval(() => { if (++n > 60) clearInterval(t); else void checkNextTable() }, 3000)
    return () => clearInterval(t)
  }, [nextTable, checkNextTable])
  const [left, setLeft] = useState(10)
  const [sitOut, setSitOut] = useState(false)
  // A fresh count for every result: a countdown left at zero by the last hand must never
  // carry this one off the screen before it has been read.
  const resultOf = useGameStore((s) => s.settlement?.matchId ?? null)
  useEffect(() => { setLeft(10); setSitOut(false) }, [resultOf])
  // Dealing the next hand spends another buy-in, so it never happens unless the player
  // ticked the box themselves — free chips or not.
  const guest = false
  const [auto, setAuto] = useState<boolean>(() => {
    try { const v = localStorage.getItem('st-autodeal'); return v == null ? guest : v === 'on' } catch { return guest }
  })
  const toggleAuto = () => setAuto((v) => { try { localStorage.setItem('st-autodeal', v ? 'off' : 'on') } catch { /* private mode */ } return !v })
  // Was this the house table (three bots), or a table someone dealt? "Next hand" only
  // means "this table again" at the house; anywhere else it is a move, and says so.
  const here = useGameStore((s) => (s.match?.seats.filter((x) => isHouseBot(x.wallet)).length ?? 0) >= 3)
  const rolling = house && here && autoNext && !sitOut && auto
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
    <>
    {house && here && autoNext && (
      <label className="ceremony-auto">
        <input type="checkbox" checked={auto} onChange={toggleAuto} /> Deal me into the next hand automatically
      </label>
    )}
    <div className="ceremony-actions">
      <button className="ghost-btn" onClick={() => { setSitOut(true); setReviewing(true) }}>
        Review table
      </button>
      {rolling ? (
        // Stops the countdown and nothing else: read the result for as long as you like.
        <>
          <button className="ghost-btn" onClick={() => setSitOut(true)}>Stay here</button>
          <button className="ghost-btn" onClick={() => { setSitOut(true); leave() }}>Lobby</button>
        </>
      ) : (
        <button className="ghost-btn" onClick={() => { setSitOut(true); leave() }}>Lobby</button>
      )}
      {nextTable ? (
        <button className="ghost-btn ghost-btn--primary" onClick={() => void followTable()}>
          {nextTable.by != null ? seatAlias(nextTable.by) : nextTable.byWallet ? displayName(nextTable.byWallet) : 'A player'} dealt the next hand — take your seat
        </button>
      ) : !here && (
        <button className="ghost-btn" onClick={() => void rematch()}>Deal this table again</button>
      )}
      {house ? (
        <button className="ghost-btn ghost-btn--primary" onClick={() => void playHouse({ sit: true })}>
          {rolling ? `Next hand in ${left}` : here ? 'Next hand' : 'Play the house table'}
        </button>
      ) : (
        <button className={`ghost-btn ${primary === 'again' ? 'ghost-btn--primary' : ''}`} onClick={() => playAgain()}>
          Deal a new table
        </button>
      )}
    </div>
    </>
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

  // The settled record does not carry folds, so after a reload (or for a late spectator)
  // the live fold flags are gone. One thing is still certain: a seat that was closer than
  // the paid winner and took nothing can only have folded. Without this the card shows a
  // "closest" player who lost, which reads as a wrong result.
  if (amountsKnown) {
    const winnerDist = Math.min(...ranked.filter((r) => r.net > 0n).map((r) => r.dist))
    for (const r of ranked) if (r.net <= 0n && r.dist < winnerDist) r.folded = true
  }

  const active = ranked.filter((r) => !r.folded)
  const folded = ranked.filter((r) => r.folded)

  // Crown the paid seat when payout amounts are known; otherwise the closest active
  // conviction (the REST/on-chain recovery may know the reveal but not every seat's amount).
  // …and with amounts in hand, the winner is whoever came out ahead — not whoever is listed first.
  const ahead = settlement.awards.filter((a) => a.amount > staked).sort((a, b) => (b.amount > a.amount ? 1 : -1))[0]
  const winnerSeat = ahead?.seat ?? settlement.awards[0]?.seat ?? active[0]?.seat

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
    // The seats on screen must be the seats of THIS result: after moving to another table
    // the same seat numbers belong to other players, and the books would go to the wrong ones.
    const at = useGameStore.getState().match?.matchId
    if (at && at !== settlement.matchId) return
    // Head-to-head is about chips, the only thing a hand settles: whoever came out of it
    // better off took that hand from the other. Equal results (two players who both just
    // lost their ante) count for nobody — a bot that never won a pot leads no one.
    const mine = ranked.find((r) => r.seat === yourSeat)
    const faced = ranked
      // A result between two players exists when one of them took the pot, or when both
      // went to the showdown (closer wins). Two players who both lost settle nothing.
      .filter((r) => r.seat !== yourSeat && walletOf(r.seat) && !!mine && (mine.net > 0n || r.net > 0n || (!mine.folded && !r.folded)))
      .map((r) => ({
        wallet: walletOf(r.seat)!,
        beat: mine!.net > 0n ? true : r.net > 0n ? false : mine!.dist < r.dist,
      }))
    recordReads(settlement.matchId, useGameStore.getState().feed, walletOf, yourSeat, ranked.map((r) => ({ seat: r.seat, dist: r.dist, folded: r.folded })))
    const before = readStats(wallet).hands
    const after = recordHand(wallet, settlement.matchId, yourNet, isWinner, faced)
    setRun(after)
    if (after.hands > before) {
      // Counted for the first time: put it on the daily board and learn our place.
      void reportFibs(HAND_FIBS + (isWinner ? WIN_FIBS : 0))
        .then(() => getFibsBoard(wallet))
        // The server's count is the one the lobby shows — show the same number here.
        .then((b) => { if (b.you) setRun(adoptServerFibs(wallet, b.you.fibs)) })
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlement.matchId, amountsKnown, yourSeat, wallet])

  // The reveal is a show: folded calls first, then the live calls from furthest to
  // closest — the winner turns over last — and only then the verdict.
  const verdictAt = active.length * STEP_MS + 900

  // The one line worth retelling: what the betting did that the numbers alone would not.
  const story = (() => {
    if (!amountsKnown || yourSeat == null) return null
    if (settlement.uncontested) {
      const top = [...settlement.awards].sort((a, b) => (b.amount > a.amount ? 1 : -1))[0]
      // Nobody else ever sees it, but you get to know what you were holding: how far your
      // own number was from the price at the moment the hand ended.
      const held = heldAtEnd(settlement.matchId)
      const usd0 = (n: number) => `$${n.toFixed(2)}`
      if (isWinner) {
        if (!held) return 'They all folded to you. Nobody will ever know what number you were holding.'
        return held.close
          ? `They all folded — and you did not even need it: the price was only ${usd0(held.dist)} from your number. Nobody else will ever know.`
          : `They all folded to a number that was ${usd0(held.dist)} off the price. A clean bluff — and nobody else will ever know.`
      }
      if (!top) return null
      const who = seatAlias(top.seat, yourSeat)
      if (!held) return `${who} took it without showing a number.`
      return held.close
        ? `${who} took it without showing a number. The price was only ${usd0(held.dist)} from yours when it ended — that fold may have cost you the pot.`
        : `${who} took it without showing a number. The price was ${usd0(held.dist)} from yours when it ended — the fold looks right.`
    }
    const me = ranked.find((r) => r.seat === yourSeat)
    const win = ranked.find((r) => r.seat === winnerSeat)
    if (!me || !win) return null
    const usd = (n: number) => `$${n.toFixed(2)}`
    const name = (seat: number) => seatAlias(seat, yourSeat)
    if (isWinner) {
      const pushed = folded.filter((r) => r.dist < me.dist).sort((a, b) => a.dist - b.dist)[0]
      if (pushed) return `${name(pushed.seat)} folded a call that was only ${usd(pushed.dist)} from the price. Yours was ${usd(me.dist)} away — and it took the pot.`
      const second = active.find((r) => r.seat !== yourSeat)
      if (second) return `Closest at the showdown: you beat ${name(second.seat)} by ${usd(second.dist - me.dist)}.`
      return 'Nobody stayed to see it — the pot was yours without a showdown.'
    }
    if (me.folded && me.dist < win.dist) {
      const best = ranked.every((r) => r.seat === yourSeat || me.dist <= r.dist)
      return best
        ? `You folded the best number at the table: ${usd(win.dist - me.dist)} closer than ${name(win.seat)}, who took the pot.`
        : `You folded a winner: your number was ${usd(win.dist - me.dist)} closer than ${name(win.seat)}, who took the pot.`
    }
    if (me.folded) {
      // A hand the clock folded for you was not a decision — do not praise it as one.
      const timedOut = useGameStore.getState().feed.some((e) => e.kind === 'action' && e.seat === me.seat && e.action === 'timeout')
      return timedOut
        ? `The clock folded this one for you. As it turned out, ${name(win.seat)} was ${usd(me.dist - win.dist)} closer.`
        : `Good fold — ${name(win.seat)} was ${usd(me.dist - win.dist)} closer than you.`
    }
    return `${name(win.seat)} beat you by ${usd(me.dist - win.dist)}.`
  })()

  const goal = nextGoal(run)
  const [shared, setShared] = useState(false)
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
      <div className={`ceremony-card panel ${isWinner ? 'ceremony-card--win' : ''}`}>
        {isWinner && amountsKnown && (
          <div className="ceremony-crown ceremony-late" style={{ animationDelay: `${verdictAt}ms` }}>
            <span aria-hidden="true">♛</span> You took the pot <b className="mono">{signedChips(yourNet, token)} {token}</b>
          </div>
        )}
        <div className="ceremony-eyebrow eyebrow">settlement · {terms?.priceFeedId ?? 'BTC/USD'}</div>
        {settlement.uncontested ? (
          <>
            <div className="ceremony-price ceremony-price--reading">{isWinner ? 'You won without a showdown' : `${winnerSeat != null ? seatAlias(winnerSeat, yourSeat ?? undefined) : 'One player'} won without a showdown`}</div>
            <div className="ceremony-sub eyebrow">everyone else folded · the calls stay sealed, like mucked cards</div>
          </>
        ) : settlePrice > 0 && ranked.length > 0 ? (
          <>
            <div className="ceremony-price mono">{formatPrice(settlePrice)}</div>
            <div className="ceremony-sub eyebrow">the closest conviction takes the pot</div>
          </>
        ) : (
          <>
            <div className="ceremony-price ceremony-price--reading">Reading the result…</div>
            <div className="ceremony-sub eyebrow">the hand is over · the settle price and every call are on their way</div>
          </>
        )}

        {ranked.length > 0 && <div className="reveal-head">
          <span className="reveal-col-rank">#</span>
          <span className="reveal-col-name">Player</span>
          <span className="reveal-col-pred">Sealed call</span>
          <span className="reveal-col-dist">Off by</span>
          <span className="reveal-col-pay">Result</span>
        </div>}

        <ul className="reveal-list">
          {active.map((r, i) => (
            <RevealRow key={r.seat} r={r} rank={i + 1} winner={r.seat === winnerSeat} yourSeat={yourSeat} decimals={decimals} token={token} amountsKnown={amountsKnown} delay={(active.length - 1 - i) * STEP_MS + 700} record={recordFor(r.seat)} />
          ))}
        </ul>

        {folded.length > 0 && (
          <div className="reveal-folded-section">
            <div className="reveal-folded-head eyebrow">Folded — forfeited pot share</div>
            <ul className="reveal-list">
              {folded.map((r) => (
                <RevealRow key={r.seat} r={r} rank={null} winner={false} yourSeat={yourSeat} decimals={decimals} token={token} amountsKnown={amountsKnown} delay={250} record={recordFor(r.seat)} />
              ))}
            </ul>
          </div>
        )}

        <div className="ceremony-rake eyebrow">
          <span title="What was actually played for. A bet nobody called goes straight back to whoever made it and is not part of the pot.">Pot played for</span> <span className="mono">{formatChips(pot, token)}</span>
          <span className="ceremony-rake-sep">·</span>
          rake <span className="mono">{formatChips(rake, token)} {token}</span>
        </div>

        {story && <div className="ceremony-story ceremony-late" style={{ animationDelay: `${verdictAt}ms` }}>{story}</div>}
        <div className={`ceremony-result ceremony-late ${isWinner ? 'ceremony-result--win' : ''}`} style={{ animationDelay: `${verdictAt + 300}ms` }}>
          {!won
            ? amountsKnown ? 'No award this match' : 'Working out the payouts…'
            : isWinner
              ? `You won the pot — ${signedChips(yourNet, token)} ${token}`
              : yourNet < 0n
                ? `Down ${formatChips(-yourNet, token)} ${token} this hand · ${formatMoney(yourAward, token)} back to you`
                : `Even this hand · ${formatMoney(yourAward, token)} back to you`}
        </div>
        {/* A hand we only watched is not part of our run and must never deal us in. */}
        {run.hands > 0 && yourSeat != null && (
          <div className="ceremony-run eyebrow">
            your run · {run.hands} hand{run.hands === 1 ? '' : 's'} · {signedChips(BigInt(run.net), token)} {token}
            {run.streak >= 2 ? ` · ${run.streak} wins in a row` : ''}
            {(run.days ?? 0) >= 2 ? ` · day ${run.days} at the table` : ''}
            {` · ${run.fibs ?? 0} Fibs (+${HAND_FIBS + (isWinner ? WIN_FIBS : 0)} this hand) · Lv ${levelOf(run.fibs ?? 0).level} ${levelOf(run.fibs ?? 0).title}`}
          </div>
        )}
        {run.hands > 0 && yourSeat != null && goal && (
          <div className="ceremony-goal">
            <span className="eyebrow">next goal</span>
            <b>{goal.label}</b>
            <span className="ceremony-goal-bar" aria-hidden="true"><i style={{ width: `${(goal.done / goal.of) * 100}%` }} /></span>
            <span className="mono">{goal.done}/{goal.of}</span>
          </div>
        )}

        {isWinner && yourSeat != null && (
          <button
            className="ghost-btn ceremony-share"
            onClick={() => {
              const text = settlement.uncontested
                ? `Everyone folded to me at Satoshi's Table — ${formatChips(pot, token)} ${token} pot, and nobody saw my number.`
                : `Called the price at Satoshi's Table and took a ${formatChips(pot, token)} ${token} pot.`
              const url = window.location.origin
              if (typeof navigator.share === 'function') void navigator.share({ text, url }).catch(() => {})
              else void navigator.clipboard?.writeText(`${text} ${url}`).then(() => setShared(true)).catch(() => {})
            }}
          >
            {shared ? 'Copied — paste it anywhere' : 'Share this win'}
          </button>
        )}

        {won && (
          <button className="seal-btn ceremony-claim" onClick={onClaim} disabled={claiming || !!tx}>
            {tx ? 'Claimed ✓' : claiming ? 'Claiming…' : `Claim ${formatMoney(yourAward, token)}`}
          </button>
        )}
        {claimError && <div className="ceremony-error eyebrow" role="alert">{claimError}</div>}

        <CeremonyActions autoNext={yourSeat != null && amountsKnown && (!!tx || yourAward === 0n) && !!seats?.some((x) => x.seat !== yourSeat && isHouseBot(x.wallet))} />
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
