import { useMemo, useEffect, useRef, useState } from 'react'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'
import { ratedScore, toEpochMs } from '@/lib/discovery'
import { createAdapters } from '@/lib/adapters'
import { networkInfo, type NetworkInfo } from '@/lib/network'
import { hostAlias } from '@/lib/seats'
import { api, type MatchDetail } from '@/lib/api'
import type { DashboardSortKey, LiveGame, UpcomingGame } from '@/lib/protocol'
import { ReclaimCard } from './ReclaimCard'
import { ClaimWinningsCard } from './ClaimWinningsCard'
import type { ClaimableWinning } from '@/lib/adapters'
import { personaEmblem } from './Seats'
import { WalletMenu } from './WalletMenu'
import './hud.css'

const SORTS: { key: DashboardSortKey; label: string; icon: string }[] = [
  { key: 'gameTime', label: 'Hot',         icon: '🔥' },
  { key: 'potSize',  label: 'Biggest pot', icon: '💰' },
  { key: 'buyIn',    label: 'Lowest buy-in', icon: '🎟' },
  { key: 'newest',   label: 'Newest',      icon: '🕐' },
]

function sortGames(games: LiveGame[], key: DashboardSortKey): LiveGame[] {
  const g = [...games]
  switch (key) {
    case 'potSize': return g.sort((a, b) => Number(b.potSize - a.potSize))
    case 'buyIn':   return g.sort((a, b) => Number(a.buyIn - b.buyIn))   // lowest first
    case 'newest':  return g.sort((a, b) => b.startedAt - a.startedAt)
    case 'gameTime': default: return g.sort((a, b) => ratedScore(b) - ratedScore(a))
  }
}

/** Re-render on an interval so relative-time labels (countdowns, elapsed) stay live. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function liveFor(startedAt: number, now: number): string {
  const m = Math.max(0, Math.round((now - startedAt) / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function fillDeadlineLabel(ts: number | undefined, now: number): string {
  if (!ts) return '—'
  const secs = Math.round((ts - now) / 1000)
  if (secs <= 0) return 'closing…'
  if (secs < 60) return `${secs}s left`
  return `${Math.round(secs / 60)}m left`
}

function fmt(amount: number | bigint) {
  return (Number(amount) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** Human "updated Xs ago" for the live discovery ticker. */
function updatedAgo(ts: number | null, now: number): string {
  if (!ts) return 'connecting…'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  return `${Math.floor(s / 60)}m ago`
}

// ---------------------------------------------------------------------------
// Network pill — top-left, amber on any test cluster, with a "not real" tooltip
// and (on devnet) a faucet link so a first-timer can fund a wallet.
// ---------------------------------------------------------------------------

function NetworkPill({ net }: { net: NetworkInfo }) {
  return (
    <div className="net-anchor">
      <div
        className={`net-pill net-pill--${net.cluster} ${net.isTest ? 'net-pill--test' : ''}`}
        tabIndex={0}
        aria-label={net.isTest ? `${net.label}. Test network — funds are not real.` : net.label}
      >
        <span className="net-pill-dot" />
        <span className="net-pill-label">{net.label}</span>
        {net.isTest && <span className="net-pill-tip" role="tooltip">Test network — funds are not real</span>}
      </div>
      {net.faucetUrl && (
        <a className="net-faucet" href={net.faucetUrl} target="_blank" rel="noreferrer">
          Get test USDC ↗
        </a>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// First-run hero — shown whenever there's nothing to list (loading / empty /
// unreachable). One line of what the game is, a 3-step visual, the CTA, and a
// single live status line (never a spinner competing with an empty message).
// The animated 3D table drifts behind it — no opaque panel to hide it.
// ---------------------------------------------------------------------------

const STEPS = [
  { n: '01', icon: '◆', title: 'Buy in', desc: 'Take a seat with USDC — that stake is your ticket to the pot.' },
  { n: '02', icon: '✦', title: 'Seal your call', desc: 'Commit a secret price prediction. No one sees it until reveal.' },
  { n: '03', icon: '◎', title: 'Closest takes pot', desc: 'When the price prints, the nearest surviving call wins it all.' },
]

function DashHero({
  status, updatedLabel, onCreate, connected,
}: {
  status: string; updatedLabel: string; onCreate: () => void; connected: boolean
}) {
  const statusLine =
    status === 'error'
      ? <><span className="dash-live-dot dash-live-dot--err" /> Can’t reach the tables — retrying…</>
      : status === 'ready'
        ? <><span className="dash-live-dot" /> No open tables yet · {updatedLabel}</>
        : <><span className="dash-live-dot dash-live-dot--wait" /> Scanning the tables…</>

  return (
    <div className="dash-hero">
      <div className="dash-hero-inner">
        <div className="brand-mark dash-hero-brand">SATOSHI'S TABLE</div>
        <div className="dash-hero-tagline">a contest of conviction</div>
        <h1 className="dash-hero-line">Predict the price. Outlast the table. Winner takes the pot.</h1>

        <ol className="dash-steps">
          {STEPS.map((s, i) => (
            <li className="dash-step" key={s.n} style={{ '--i': i } as React.CSSProperties}>
              <span className="dash-step-ico" aria-hidden="true">{s.icon}</span>
              <span className="dash-step-n">{s.n}</span>
              <span className="dash-step-title">{s.title}</span>
              <span className="dash-step-desc">{s.desc}</span>
            </li>
          ))}
        </ol>

        <button className="play-now-btn dash-hero-cta" onClick={onCreate}>
          {connected ? 'Deal a table' : 'Connect & deal a table'}
        </button>

        <div className="dash-hero-status">{statusLine}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Invite banner — resolves the actual invited table (from the live lobby, or a
// direct fetch when it isn't publicly listed) and shows concrete terms with the
// inviter's avatar. Falls back to "deal your own" when the table is gone.
// ---------------------------------------------------------------------------

/** "M:SS" until a fill deadline, or null once it has passed. */
function mmss(deadline: number | undefined, now: number): string | null {
  if (deadline == null) return null
  const s = Math.round((deadline - now) / 1000)
  if (s <= 0) return null
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function InviteAvatar({ alias, muted }: { alias: string; muted?: boolean }) {
  const emblem = personaEmblem(alias)
  return (
    <div className={`dash-invite-avatar ${muted ? 'dash-invite-avatar--muted' : ''}`} aria-hidden="true">
      {typeof emblem === 'string'
        ? <span className="dash-invite-mono">{emblem}</span>
        : <svg viewBox="0 0 32 32" className="dash-invite-sigil">{emblem}</svg>}
    </div>
  )
}

function InviteBanner({
  matchId, inviter, connected, onTakeSeat, onDeal, onDismiss,
}: {
  matchId: string
  inviter: string | null
  connected: boolean
  onTakeSeat: (joinId: string) => void
  onDeal: () => void
  onDismiss: () => void
}) {
  const now = useNow(1000)
  const upcoming = useGameStore((s) => s.upcomingGames)
  const active   = useGameStore((s) => s.activeGames)

  const listed = upcoming.find((g) => g.matchId === matchId || g.onchainMatchId === matchId)
  const isLive = active.some((g) => g.matchId === matchId || g.onchainMatchId === matchId)
  const inList = !!listed || isLive

  // Invited tables are often absent from the public lobby (a created table isn't
  // discoverable until it fills), so fetch the detail directly to show real terms.
  const [detail, setDetail] = useState<MatchDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  useEffect(() => {
    if (inList) return
    let alive = true
    api.getMatch(matchId)
      .then((d) => { if (alive) setDetail(d) })
      .catch(() => { if (alive) setDetailFailed(true) })
    return () => { alive = false }
  }, [matchId, inList])

  const name = inviter ?? hostAlias(matchId)
  const detailDeadline = detail?.timing.fill_deadline != null ? toEpochMs(detail.timing.fill_deadline) : undefined

  // One source of truth for the table's shape, best-available first.
  const src = listed
    ? { feed: listed.feed, buyIn: listed.buyIn, seated: listed.seated as number | null, max: listed.maxPlayers, deadline: listed.fillDeadline }
    : detail
      ? { feed: detail.feed, buyIn: detail.params.buy_in, seated: null as number | null, max: detail.params.max_players, deadline: detailDeadline }
      : null

  let mode: 'loading' | 'open' | 'closed'
  if (listed) {
    mode = listed.seated < listed.maxPlayers && !(listed.fillDeadline != null && listed.fillDeadline <= now) ? 'open' : 'closed'
  } else if (isLive || detailFailed) {
    mode = 'closed' // already started, or the fetch 404'd (gone)
  } else if (detail) {
    mode = detail.phase.toUpperCase() === 'FILLING' && !(detailDeadline != null && detailDeadline <= now) ? 'open' : 'closed'
  } else {
    mode = 'loading' // fetch in flight
  }

  if (mode === 'loading') {
    return (
      <div className="dash-invite dash-invite--loading">
        <InviteAvatar alias={name} />
        <div className="dash-invite-body">
          <div className="eyebrow"><strong>{name}</strong> invited you</div>
          <div className="dash-invite-finding">Finding the table<span className="dash-invite-dots"><i /><i /><i /></span></div>
        </div>
        <div className="dash-invite-actions">
          <button className="dash-ghost-btn" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    )
  }

  if (mode === 'closed') {
    const started = isLive || (!!detail && detail.phase.toUpperCase() !== 'FILLING')
    return (
      <div className="dash-invite dash-invite--closed">
        <InviteAvatar alias={name} muted />
        <div className="dash-invite-body">
          <div className="eyebrow">invite expired</div>
          <div className="dash-invite-title">That table {started ? 'already started' : 'filled up'}</div>
          <div className="dash-invite-sub">{name}’s table is closed — deal your own?</div>
        </div>
        <div className="dash-invite-actions">
          <button className="play-now-btn" onClick={onDeal}>Deal a table</button>
          <button className="dash-ghost-btn" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    )
  }

  // open
  const s = src!
  const countdown = mmss(s.deadline, now)
  const secsLeft = s.deadline != null ? Math.round((s.deadline - now) / 1000) : null
  const cdClass = secsLeft != null && secsLeft < 15
    ? 'dash-invite-countdown dash-invite-countdown--crit'
    : secsLeft != null && secsLeft < 60
      ? 'dash-invite-countdown dash-invite-countdown--warn'
      : 'dash-invite-countdown'
  const joinId = listed?.matchId ?? detail?.match_id ?? matchId
  const [base] = s.feed.split('/')

  return (
    <div className="dash-invite">
      <InviteAvatar alias={name} />
      <div className="dash-invite-body">
        <div className="eyebrow"><strong>{name}</strong> invited you</div>
        <div className="dash-invite-meta">
          <span className={`dash-invite-feed feed-${base.toLowerCase()}`}>{s.feed}</span>
          <span className="dash-invite-dot">·</span>
          <span><span className="mono">{fmt(s.buyIn)}</span> USDC buy-in</span>
          <span className="dash-invite-dot">·</span>
          <span>{s.seated != null ? `${s.seated}/${s.max} seated` : `${s.max} seats`}</span>
          {countdown && <>
            <span className="dash-invite-dot">·</span>
            <span className={cdClass}>closes in {countdown}</span>
          </>}
        </div>
      </div>
      <div className="dash-invite-actions">
        <button className="play-now-btn" onClick={() => onTakeSeat(joinId)}>
          {connected ? 'Take your seat' : 'Connect & take seat'}
        </button>
        <button className="dash-ghost-btn" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Deterministic per-table flourishes — no avatar/pot-history telemetry comes
// down the discovery feed, so we seed stable visuals from the matchId (never
// random, so a card doesn't flicker between polls).
// ---------------------------------------------------------------------------

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Ticker → glyph for the paired asset badges. Falls back to the first letter.
const ASSET_GLYPH: Record<string, string> = {
  BTC: '₿', XBT: '₿', ETH: 'Ξ', SOL: '◎', USD: '$', USDC: '$', USDT: '$',
  DOGE: 'Ð', BNB: 'B', AVAX: 'A', LINK: '⬡',
}
function assetGlyph(sym: string): string {
  return ASSET_GLYPH[sym.toUpperCase()] ?? sym.charAt(0).toUpperCase()
}

/** Overlapping base/quote coin badges, e.g. ₿ over $ for BTC/USD. */
function AssetPair({ feed }: { feed: string }) {
  const [base, quote = 'USD'] = feed.split('/')
  const cls = base.toLowerCase()
  return (
    <span className="dash-assets" aria-hidden="true">
      <span className={`dash-asset dash-asset--base feed-${cls}`}>{assetGlyph(base)}</span>
      <span className="dash-asset dash-asset--quote">{assetGlyph(quote)}</span>
    </span>
  )
}

/** Discrete seat pips — filled for taken seats, hollow for open ones. */
function SeatDots({ seated, total }: { seated: number; total: number }) {
  const n = total > 0 ? total : 5
  return (
    <span className="dash-seatdots" role="img" aria-label={`${seated} of ${n} seats taken`}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={`dash-seatdot ${i < seated ? 'is-filled' : ''}`} />
      ))}
    </span>
  )
}

const AVATAR_HUES = [28, 262, 168, 210, 340, 48]
const AVATAR_MAX = 4

/** Stacked, overlapping avatars of the seated players (seeded from the matchId). */
function AvatarStack({ matchId, seated }: { matchId: string; seated: number }) {
  if (seated <= 0) return null
  const rng = mulberry32(hashStr(matchId))
  const shown = Math.min(seated, AVATAR_MAX)
  const extra = seated - shown
  const glyphs = '♠♥♦♣★◆✦♞'
  return (
    <span className="dash-avatars" aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => {
        const hue = AVATAR_HUES[Math.floor(rng() * AVATAR_HUES.length)]
        const g = glyphs[Math.floor(rng() * glyphs.length)]
        return (
          <span
            key={i}
            className="dash-avatar"
            style={{ background: `hsl(${hue} 55% 32%)`, color: `hsl(${hue} 80% 82%)`, zIndex: shown - i }}
          >
            {g}
          </span>
        )
      })}
      {extra > 0 && <span className="dash-avatar dash-avatar--more">+{extra}</span>}
    </span>
  )
}

/** Circular countdown that depletes toward a deadline; amber <60s, red <15s. */
function RingTimer({ deadline, now }: { deadline: number; now: number }) {
  const secs = Math.max(0, Math.round((deadline - now) / 1000))
  // Anchor "full" to the largest remaining time we've seen for this card, so
  // the arc genuinely depletes rather than jumping around with an unknown window.
  const maxSeen = useRef(secs)
  if (secs > maxSeen.current) maxSeen.current = secs
  const frac = maxSeen.current > 0 ? secs / maxSeen.current : 0

  const urgency = secs <= 15 ? 'is-critical' : secs <= 60 ? 'is-warn' : ''
  const label = secs <= 0 ? '·' : secs < 60 ? `${secs}` : `${Math.round(secs / 60)}m`
  const R = 16
  const C = 2 * Math.PI * R
  return (
    <span className={`dash-ring ${urgency}`} role="timer" aria-label={fillDeadlineLabel(deadline, now)}>
      <svg viewBox="0 0 40 40">
        <circle className="dash-ring-track" cx="20" cy="20" r={R} />
        <circle
          className="dash-ring-arc"
          cx="20" cy="20" r={R}
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
          transform="rotate(-90 20 20)"
        />
      </svg>
      <span className="dash-ring-label">{label}</span>
    </span>
  )
}

/** Tiny seeded sparkline suggesting pot growth over the hand. */
function Sparkline({ seed }: { seed: string }) {
  const pts = useMemo(() => {
    const rng = mulberry32(hashStr(seed))
    const n = 14
    let v = 0.15
    const ys: number[] = []
    for (let i = 0; i < n; i++) { v = Math.min(1, v + rng() * 0.16); ys.push(v) }
    const W = 56, H = 18
    return ys.map((y, i) => `${((i / (n - 1)) * W).toFixed(1)},${(H - y * (H - 2) - 1).toFixed(1)}`).join(' ')
  }, [seed])
  return (
    <svg className="dash-spark" viewBox="0 0 56 18" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Row sub-components
// ---------------------------------------------------------------------------

function UpcomingRow({ game, onJoin, index, highlighted }: { game: UpcomingGame; onJoin: () => void; index: number; highlighted?: boolean }) {
  const now = useNow(1000)
  const [base, quote = 'USD'] = game.feed.split('/')
  return (
    <li
      className={`dash-card dash-card--open ${highlighted ? 'dash-card--invited' : ''}`}
      onClick={onJoin}
      style={{ '--i': index } as React.CSSProperties}
    >
      {/* Left — asset pair + buy-in as the primary figure */}
      <div className="dash-card-lead">
        <AssetPair feed={game.feed} />
        <div className="dash-card-lead-text">
          {highlighted && <span className="dash-card-invite-tag">◆ your invite</span>}
          <span className={`dash-pair feed-${base.toLowerCase()}`}>{base}<span className="dash-pair-quote">/{quote}</span></span>
          <span className="dash-buyin">
            <span className="dash-buyin-num mono">{fmt(game.buyIn)}</span>
            <span className="dash-buyin-unit">USDC buy-in</span>
          </span>
        </div>
      </div>

      {/* Middle — seat pips + who's already seated */}
      <div className="dash-card-mid">
        <SeatDots seated={game.seated} total={game.maxPlayers} />
        <div className="dash-card-mid-row">
          <AvatarStack matchId={game.matchId} seated={game.seated} />
          <span className="dash-seats-label eyebrow">
            {game.seated}/{game.maxPlayers > 0 ? game.maxPlayers : 5} seated
          </span>
        </div>
      </div>

      {/* Right — countdown ring + full-height gold Join */}
      <div className="dash-card-tail">
        {game.fillDeadline ? <RingTimer deadline={game.fillDeadline} now={now} /> : <span className="dash-ring-spacer" />}
        <button className="dash-join-btn" onClick={(e) => { e.stopPropagation(); onJoin() }}>
          Join <span aria-hidden="true">→</span>
        </button>
      </div>
    </li>
  )
}

function ActiveRow({ game, onWatch, index }: { game: LiveGame; onWatch: () => void; index: number }) {
  const now = useNow(15_000)
  const [base, quote = 'USD'] = game.feed.split('/')
  return (
    <li
      className="dash-card dash-card--live"
      onClick={onWatch}
      style={{ '--i': index } as React.CSSProperties}
    >
      {/* Left — LIVE badge, asset pair, buy-in secondary */}
      <div className="dash-card-lead">
        <AssetPair feed={game.feed} />
        <div className="dash-card-lead-text">
          <span className="dash-live-tag"><span className="dash-live-tag-dot" />LIVE</span>
          <span className={`dash-pair feed-${base.toLowerCase()}`}>{base}<span className="dash-pair-quote">/{quote}</span></span>
        </div>
      </div>

      {/* Middle — pot as the hero, sparkline underneath */}
      <div className="dash-card-mid dash-card-mid--live">
        <span className="dash-pot-hero">
          <span className="dash-pot-num mono">{fmt(game.potSize)}</span>
          <span className="dash-pot-unit">USDC pot</span>
        </span>
        <Sparkline seed={game.matchId} />
      </div>

      {/* Right — watchers + outline Watch */}
      <div className="dash-card-tail">
        <span className="dash-watchers" title={`${game.spectators} watching`}>
          <span className="dash-eye" aria-hidden="true">
            <svg viewBox="0 0 24 16"><path d="M12 1C5 1 1 8 1 8s4 7 11 7 11-7 11-7-4-7-11-7z" /><circle cx="12" cy="8" r="3" /></svg>
          </span>
          <span className="mono">{game.spectators}</span>
          <span className="dash-livefor eyebrow">· {liveFor(game.startedAt, now)}</span>
        </span>
        <button className="dash-join-btn dash-join-btn--ghost" onClick={(e) => { e.stopPropagation(); onWatch() }}>
          Watch <span aria-hidden="true">→</span>
        </button>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// My matches — stuck rooms this wallet can cancel & reclaim funds from.
// Scanned directly on-chain (seat accounts owned by the connected wallet); no backend needed.
// ---------------------------------------------------------------------------

function MyReclaimableMatches() {
  const chain = useMemo(() => createAdapters().chain, [])
  const { connected } = useWallet()
  const [ids, setIds] = useState<string[]>([])

  useEffect(() => {
    if (!connected) { setIds([]); return }
    let alive = true
    chain.listReclaimableMatches()
      .then((matches) => { if (alive) setIds(matches.map((m) => m.onchainMatchId)) })
      .catch(() => { /* best-effort — an RPC hiccup shouldn't break the dashboard */ })
    return () => { alive = false }
  }, [connected, chain])

  if (ids.length === 0) return null

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <span className="dash-section-dot dash-section-dot--live" />
        <span className="dash-section-label">Needs your attention</span>
        <span className="dash-section-sub">stuck rooms — cancel &amp; reclaim your funds</span>
      </div>
      <div className="dash-reclaim-list">
        {ids.map((id) => <ReclaimCard key={id} onchainMatchId={id} />)}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// My winnings — SETTLED matches this wallet has an unclaimed payout in.
// Scanned directly on-chain (seat accounts owned by the connected wallet); no backend needed.
// ---------------------------------------------------------------------------

function MyClaimableWinnings() {
  const chain = useMemo(() => createAdapters().chain, [])
  const { connected } = useWallet()
  const [winnings, setWinnings] = useState<ClaimableWinning[]>([])
  const [collected, setCollected] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!connected) { setWinnings([]); setCollected(new Set()); return }
    let alive = true
    chain.listClaimableWinnings()
      .then((rows) => { if (alive) setWinnings(rows) })
      .catch(() => { /* best-effort — an RPC hiccup shouldn't break the dashboard */ })
    return () => { alive = false }
  }, [connected, chain])

  // Keep a collected id in the list (its card shows the ✓ done state) but stop counting it
  // toward the pending total, so the header total drains as the player collects.
  const onDone = (id: string) => setCollected((prev) => new Set(prev).add(id))

  if (winnings.length === 0) return null

  const pendingTotal = winnings
    .filter((w) => !collected.has(w.onchainMatchId))
    .reduce((sum, w) => sum + w.payout, 0n)

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <span className="dash-section-dot dash-section-dot--win" />
        <span className="dash-section-label">Winnings to collect</span>
        <span className="dash-section-sub">
          {pendingTotal > 0n
            ? `${(Number(pendingTotal) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC waiting for you`
            : 'all collected'}
        </span>
      </div>
      <div className="dash-reclaim-list">
        {winnings.map((w) => (
          <ClaimWinningsCard
            key={w.onchainMatchId}
            onchainMatchId={w.onchainMatchId}
            payout={w.payout}
            onDone={onDone}
          />
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function Dashboard() {
  const activeGames   = useGameStore((s) => s.activeGames)
  const upcomingGames = useGameStore((s) => s.upcomingGames)
  const status        = useGameStore((s) => s.discoveryStatus)
  const updatedAt     = useGameStore((s) => s.discoveryUpdatedAt)
  const sort          = useGameStore((s) => s.dashboardSort)
  const setSort       = useGameStore((s) => s.setDashboardSort)
  const enterTable    = useGameStore((s) => s.enterTable)
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)
  const joinGame      = useGameStore((s) => s.joinGame)
  const createGame    = useGameStore((s) => s.createGame)
  const playError     = useGameStore((s) => s.playError)
  const pendingInvite = useGameStore((s) => s.pendingInvite)
  const inviteFrom    = useGameStore((s) => s.inviteFrom)
  const dismissInvite = useGameStore((s) => s.dismissInvite)

  const { connected } = useWallet()
  const { connection } = useConnection()
  const { setVisible } = useWalletModal()
  const [wrongNetwork, setWrongNetwork] = useState(false)

  const net = useMemo(() => networkInfo(), [])
  const now = useNow(1000)

  // Live updates: silently re-poll the discovery feed on an interval (and when
  // the tab regains focus) so the lobby stays fresh without a manual Refresh.
  useEffect(() => {
    const poll = () => { if (document.visibilityState === 'visible') void loadDiscovery({ silent: true }) }
    const id = setInterval(poll, 8000)
    document.addEventListener('visibilitychange', poll)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', poll) }
  }, [loadDiscovery])

  // Detect mainnet wallet connected to a devnet app via genesis hash.
  // Devnet genesis: EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
  useEffect(() => {
    if (!connected) { setWrongNetwork(false); return }
    connection.getGenesisHash().then((hash) => {
      setWrongNetwork(hash !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
    }).catch(() => { /* ignore */ })
  }, [connected, connection])

  const sortedActive = useMemo(() => sortGames(activeGames, sort), [activeGames, sort])
  // OPEN tables default to closing-soonest — the most time-sensitive seats first.
  // Rooms without a deadline sort to the end.
  const sortedUpcoming = useMemo(
    () => [...upcomingGames].sort(
      (a, b) => (a.fillDeadline ?? Infinity) - (b.fillDeadline ?? Infinity),
    ),
    [upcomingGames],
  )
  // Nothing to list (loading, empty, or unreachable) → the first-run hero stands
  // in for the panel, so a loader never coexists with an empty-state message.
  const hasGames = upcomingGames.length > 0 || sortedActive.length > 0
  const updatedLabel = updatedAgo(updatedAt, now)

  const handleJoin = (matchId: string) => {
    if (!connected) { setVisible(true); return }
    void joinGame(matchId)
  }
  const handleWatch = (matchId: string) => {
    // Spectating needs no auth — go straight to the table (§6 / enterTable).
    void enterTable(matchId)
  }
  const handleCreate = () => {
    if (!connected) { setVisible(true); return }
    void createGame()
  }

  return (
    <div className={`dash ${hasGames ? '' : 'dash--hero'}`}>

      {/* ── Fixed page chrome: network pill top-left, wallet top-right ── */}
      <NetworkPill net={net} />
      <div className="dash-wallet-anchor">
        <WalletMenu />
      </div>

      {/* Notices float above whichever surface is showing. */}
      {(pendingInvite || wrongNetwork || playError) && (
        <div className={`dash-notices ${hasGames ? '' : 'dash-notices--hero'}`}>
          {pendingInvite && (
            <InviteBanner
              matchId={pendingInvite}
              inviter={inviteFrom}
              connected={connected}
              onTakeSeat={handleJoin}
              onDeal={handleCreate}
              onDismiss={dismissInvite}
            />
          )}

          {wrongNetwork && (
            <div className="dash-network-warn">
              <span className="dash-network-warn-icon">⚠</span>
              <div>
                <strong>Wrong network</strong>
                <span> — your wallet is on Mainnet. Switch to </span>
                <strong>Solana Devnet</strong>
                <span> in your wallet settings before depositing.</span>
              </div>
            </div>
          )}

          {playError && (
            <div className="dash-play-error eyebrow">{playError}</div>
          )}
        </div>
      )}

      {!hasGames ? (
        // ── First-run hero — the animated table drifts behind it ──
        <div className="dash-hero-wrap">
          <DashHero status={status} updatedLabel={updatedLabel} onCreate={handleCreate} connected={connected} />
          <MyClaimableWinnings />
          <MyReclaimableMatches />
        </div>
      ) : (
        // ── Populated lobby panel ──
        <div className="dash-panel">
          <header className="dash-head">
            <div>
              <div className="brand-mark">SATOSHI'S TABLE</div>
              <div className="dash-tagline">a contest of conviction</div>
            </div>
          </header>

          <div className="dash-body">
            <MyClaimableWinnings />
            <MyReclaimableMatches />

            <section className="dash-section">
              <div className="dash-section-head">
                <span className="dash-section-dot" />
                <span className="dash-section-label">Open</span>
                <span className="dash-section-sub">filling now · closing soonest first</span>
              </div>
              {upcomingGames.length === 0 ? (
                <div className="dash-empty eyebrow">No open tables</div>
              ) : (
                <ul className="dash-list">
                  {sortedUpcoming.map((g, i) => (
                    <UpcomingRow
                      key={g.matchId}
                      game={g}
                      onJoin={() => handleJoin(g.matchId)}
                      index={i}
                      highlighted={!!pendingInvite && (g.matchId === pendingInvite || g.onchainMatchId === pendingInvite)}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="dash-section">
              <div className="dash-section-head">
                <span className="dash-section-dot dash-section-dot--live" />
                <span className="dash-section-label">Live</span>
                <span className="dash-section-sub">in progress</span>
                {sortedActive.length > 0 && (
                  <div className="dash-sorts" role="tablist" aria-label="Sort live tables">
                    {SORTS.map((s) => (
                      <button
                        key={s.key}
                        role="tab"
                        aria-selected={sort === s.key}
                        className={`dash-sort ${sort === s.key ? 'is-active' : ''}`}
                        onClick={() => setSort(s.key)}
                      >
                        <span className="dash-sort-ico" aria-hidden="true">{s.icon}</span>
                        <span className="dash-sort-label">{s.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {sortedActive.length === 0 ? (
                <div className="dash-empty eyebrow">No live hands</div>
              ) : (
                <ul className="dash-list">
                  {sortedActive.map((g, i) => (
                    <ActiveRow key={g.matchId} game={g} onWatch={() => handleWatch(g.matchId)} index={i} />
                  ))}
                </ul>
              )}
            </section>

            <section className="dash-section dash-section--create">
              <div>
                <div className="dash-create-title">Start a table</div>
                <div className="eyebrow" style={{ opacity: 0.45 }}>
                  Be first in — others join before it goes live
                </div>
              </div>
              <button className="play-now-btn" onClick={handleCreate}>
                Deal a table
              </button>
            </section>
          </div>

          {/* ── Footer — live status, no manual refresh ── */}
          <footer className="dash-foot">
            <span className="dash-live-status">
              <span className="dash-live-dot" /> Live
            </span>
            <span className="eyebrow dash-updated">updated {updatedLabel}</span>
          </footer>
        </div>
      )}
    </div>
  )
}
