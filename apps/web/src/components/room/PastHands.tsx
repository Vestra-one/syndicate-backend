import { useEffect, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { formatChips } from '@/lib/format'
import { displayName } from '@/lib/seats'
import { api, type MatchDetail } from '@/lib/api'
import type { PastHand } from '@/lib/protocol'
import { Coin, Sparkline, agoLabel } from './bits'
import { useNow } from '@/lib/useNow'

/** Settled matches never change — cache detail fetches across the 60s history poll. */
const detailCache = new Map<string, MatchDetail>()

function formatWad(wad: string | null | undefined, decimals = 2): string {
  if (!wad) return '—'
  try {
    const v = BigInt(wad)
    const base = 10n ** 18n
    const whole = v / base
    const frac = v % base
    const fracStr = frac.toString().padStart(18, '0').slice(0, decimals)
    return `${whole.toLocaleString()}.${fracStr}`
  } catch {
    return '—'
  }
}

function wadDiff(a: string, b: string): bigint {
  const x = BigInt(a)
  const y = BigInt(b)
  return x > y ? x - y : y - x
}

function PastCard({ hand }: { hand: PastHand }) {
  const now = useNow(30_000)
  const walletAddress = useGameStore((s) => s.walletAddress)
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<MatchDetail | null>(() => detailCache.get(hand.matchId) ?? null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (detail || loading) return
    setLoading(true)
    api.getMatch(hand.matchId)
      .then((d) => { detailCache.set(hand.matchId, d); setDetail(d) })
      .catch(() => { /* margin/expansion just stays unavailable */ })
      .finally(() => setLoading(false))
  }, [hand.matchId, detail, loading])

  const [base, quote = 'USD'] = hand.feed.split('/')
  const isYours = !!walletAddress && hand.winner?.wallet === walletAddress
  const isVoided = hand.voidKind != null
  const winnerName = hand.winner ? displayName(hand.winner.wallet, hand.winner.handle) : null

  const winnerPredictionWad = detail?.reveal?.predictions?.find((p) => p.wallet === hand.winner?.wallet)?.prediction_wad
  const margin = hand.settlementPriceWad && winnerPredictionWad
    // rounded the same way as the result card, so the two never differ by a cent
    ? (Number(wadDiff(hand.settlementPriceWad, winnerPredictionWad)) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : null

  const solscanUrl = hand.settlementTxSig ? `https://solscan.io/tx/${hand.settlementTxSig}?cluster=devnet` : null

  return (
    <div className={`card card--past ${isYours ? 'yours' : ''}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{ all: 'unset', display: 'contents', cursor: 'pointer' }}
        aria-expanded={expanded}
      >
        <span className="card-top">
          <Coin base={base} />
          <span className="card-mkt">
            <b>{base}<i>/{quote}</i></b>
            <span className="eyebrow">{hand.maxPlayers ?? '—'} players · {agoLabel(hand.endedAt, now)}</span>
          </span>
          <span className="card-flag">
            <span className="flag flag--won">{isVoided ? 'Voided' : isYours ? 'Your win' : 'Settled'}</span>
          </span>
        </span>
        <span className="card-hero">
          <span className="amt">
            <span className="eyebrow">final pot</span>
            {hand.finalPot != null ? <b>{formatChips(hand.finalPot)}<em>USDC</em></b> : <b>—</b>}
          </span>
          {!isVoided && <Sparkline seed={hand.matchId} color="rgba(202,162,63,.75)" />}
        </span>
        {!isVoided && hand.winner && (
          <span className="won-row">
            <span className="who">
              <b>{winnerName}{isYours ? ' — you' : ''}</b>
              <span>{hand.winner.wallet.slice(0, 4)}…{hand.winner.wallet.slice(-4)}</span>
            </span>
            <span className="edge">
              <b>{margin ? `$${margin} from the price` : loading ? 'loading…' : '—'}</b>
              {hand.settlementPriceWad && <span>settled {formatWad(hand.settlementPriceWad)}</span>}
            </span>
          </span>
        )}
        <span className="card-act">
          <span className="hint">{isVoided ? 'table voided — full refunds' : 'every sealed call, who folded, who won — on the record'}</span>
          <span className="go">{expanded ? 'Hide detail ▴' : 'Show detail ▾'}</span>
        </span>
      </button>

      {expanded && (
        <div className="card-expand">
          {!detail ? (
            <div className="card-expand-row">loading…</div>
          ) : isVoided ? (
            <div className="card-expand-row">This table voided before settlement — every deposit was fully refunded on-chain.</div>
          ) : (
            <>
              {detail.seats.map((s) => (
                <div key={s.seat_index} className={`card-expand-row ${s.pot_won_chips ? 'winner' : ''}`}>
                  <span className="who">{displayName(s.wallet, s.handle)}</span>
                  <span className="pred">
                    sealed {formatWad(s.prediction_wad)}
                    {hand.settlementPriceWad && s.prediction_wad ? ` · $${(Number(wadDiff(hand.settlementPriceWad, s.prediction_wad)) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} off` : ''}
                    {s.pot_won_chips ? ' · took the pot' : s.folded ? ' · folded' : s.folded === false ? ' · lost at showdown' : ''}
                  </span>
                  <span className="payout mono">
                    {s.total_contribution != null
                      ? (() => { const net = (s.pot_won_chips ?? 0) - s.total_contribution; return `${net >= 0 ? '+' : '−'}${formatChips(Math.abs(net))} USDC` })()
                      : `${s.payout_chips != null ? formatChips(s.payout_chips) : '—'} USDC back`}
                  </span>
                </div>
              ))}
              {solscanUrl && (
                <a className="card-expand-link" href={solscanUrl} target="_blank" rel="noreferrer">
                  View settlement transaction ↗
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function PastHands() {
  const historyGames = useGameStore((s) => s.historyGames)
  const historyStatus = useGameStore((s) => s.historyStatus)
  const historyCursor = useGameStore((s) => s.historyCursor)
  const loadHistory = useGameStore((s) => s.loadHistory)

  return (
    <section className="zone" id="past" aria-labelledby="past-h">
      <div className="zone-head">
        <div className="zone-title">
          <span className="eyebrow">settled · the record</span>
          <h2 id="past-h">Past hands</h2>
        </div>
      </div>
      <div className="engrave" aria-hidden="true" />
      <p className="zone-sub">Settled pots and the calls that took them. Open any hand to see every seat's call and payout.</p>

      {historyGames.length === 0 ? (
        historyStatus === 'loading' ? (
          <div className="grid">
            {[0, 1, 2].map((i) => <div key={i} className="card card--skeleton"><span className="skel-bar" style={{ height: 120, margin: 16 }} /></div>)}
          </div>
        ) : (
          <div className="zone-empty">No settled hands yet — the record starts with the first pot.</div>
        )
      ) : (
        <>
          <div className="grid">
            {/* Tables that never dealt (voided, refunded) are not hands — they only make the room look broken. */}
            {historyGames.filter((h) => h.voidKind == null).map((h) => <PastCard key={h.matchId} hand={h} />)}
          </div>
          {historyCursor && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <button className="btn-ghost" type="button" onClick={() => void loadHistory({ more: true })}>
                Load more past hands
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
