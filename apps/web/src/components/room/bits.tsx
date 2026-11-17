import { useRef, useMemo } from 'react'
import type { NetworkInfo } from '@/lib/network'

// ---------------------------------------------------------------------------
// Deterministic per-table flourishes — seeded from the matchId so a card's
// decorative bits (sparkline, avatar glyphs) never flicker between polls.
// ---------------------------------------------------------------------------

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Network pill — top-left, amber on any test cluster.
// ---------------------------------------------------------------------------

export function NetworkPill({ net }: { net: NetworkInfo }) {
  return (
    <div
      className={`net-pill net-pill--${net.cluster} ${net.isTest ? 'net-pill--test' : ''}`}
      tabIndex={0}
      aria-label={net.isTest ? `${net.label}. Test network — funds are not real.` : net.label}
    >
      <span className="net-pill-dot" />
      <span className="net-pill-label">{net.label}</span>
      {net.isTest && <span className="net-pill-tip" role="tooltip">Test network — funds are not real</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Market coin badge
// ---------------------------------------------------------------------------

const MARKET_GLYPH: Record<string, { glyph: string; cls: string }> = {
  BTC: { glyph: '₿', cls: '' },
  ETH: { glyph: 'Ξ', cls: 'coin--eth' },
  SOL: { glyph: '◎', cls: 'coin--sol' },
}

export function marketGlyph(base: string): { glyph: string; cls: string } {
  return MARKET_GLYPH[base.toUpperCase()] ?? { glyph: base.charAt(0).toUpperCase(), cls: '' }
}

export function Coin({ base, sm }: { base: string; sm?: boolean }) {
  const m = marketGlyph(base)
  return (
    <span className={`coin ${m.cls} ${sm ? 'coin--sm' : ''}`} aria-hidden="true">
      <span>{m.glyph}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Seat pips — filled for taken seats, gold for "you'll sit here", hollow open.
// ---------------------------------------------------------------------------

export function SeatPips({ seated, total, youAt }: { seated: number; total: number; youAt?: number }) {
  const n = total > 0 ? total : 5
  return (
    <span className="pips" role="img" aria-label={`${seated} of ${n} seats taken`}>
      {Array.from({ length: n }, (_, i) => {
        const seat = i + 1
        const cls = seat <= seated ? 'f' : seat === youAt ? 'you' : ''
        return <span key={i} className={`pip ${cls}`} />
      })}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Round progress pips
// ---------------------------------------------------------------------------

export function RoundPips({ round, total }: { round: number; total: number }) {
  const n = Math.max(1, total)
  return (
    <span className="rounds" role="img" aria-label={`round ${round} of ${n}`}>
      {Array.from({ length: n }, (_, i) => <span key={i} className={`rnd ${i < round ? 'f' : ''}`} />)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Avatar stack — stacked, overlapping glyphs seeded from the matchId.
// ---------------------------------------------------------------------------

const AVATAR_GLYPHS = '♠♥♦♣★◆✦♞'
const AVATAR_CLASSES = ['', 'av--eth', 'av--sol', 'av--rose', 'av--sage']
const AVATAR_MAX = 4

export function AvatarStack({ seedKey, seated, large }: { seedKey: string; seated: number; large?: boolean }) {
  if (seated <= 0) return null
  const rng = mulberry32(hashStr(seedKey))
  const shown = Math.min(seated, AVATAR_MAX)
  const extra = seated - shown
  return (
    <span className="avs" aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => {
        const g = AVATAR_GLYPHS[Math.floor(rng() * AVATAR_GLYPHS.length)]
        const cls = AVATAR_CLASSES[Math.floor(rng() * AVATAR_CLASSES.length)]
        return <span key={i} className={`av ${cls} ${large ? 'av--lg' : ''}`}>{g}</span>
      })}
      {extra > 0 && <span className="av">+{extra}</span>}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Fill countdown ring — depletes toward a deadline; amber under 60s.
// ---------------------------------------------------------------------------

export function FillRing({ deadline, now }: { deadline: number; now: number }) {
  const secs = Math.max(0, Math.round((deadline - now) / 1000))
  const maxSeen = useRef(secs)
  if (secs > maxSeen.current) maxSeen.current = secs
  const frac = maxSeen.current > 0 ? secs / maxSeen.current : 0
  const rush = secs <= 60
  const label = secs <= 0 ? '·' : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  const R = 16
  const C = 2 * Math.PI * R
  return (
    <span className={`ring ${rush ? 'rush' : ''}`} role="timer" aria-label={secs <= 0 ? 'closing' : `${secs}s left`}>
      <svg viewBox="0 0 38 38" aria-hidden="true">
        <circle className="tr" cx="19" cy="19" r={R} />
        <circle className="pr" cx="19" cy="19" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
      </svg>
      <b>{label}</b>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Seeded sparkline — decorative pot-growth suggestion (no real per-market
// price history is kept client-side beyond the BTC cabinet feed).
// ---------------------------------------------------------------------------

export function Sparkline({ seed, color }: { seed: string; color: string }) {
  const pts = useMemo(() => {
    const rng = mulberry32(hashStr(seed))
    const n = 20
    let v = 0.15
    const ys: number[] = []
    for (let i = 0; i < n; i++) { v = Math.min(1, Math.max(0.04, v + (rng() - 0.42) * 0.24)); ys.push(v) }
    const W = 108, H = 34
    const pad = 3
    return {
      poly: ys.map((y, i) => `${((i / (n - 1)) * (W - pad * 2) + pad).toFixed(1)},${(H - y * (H - pad * 2) - pad).toFixed(1)}`).join(' '),
      lastX: W - pad,
      lastY: H - ys[ys.length - 1] * (H - pad * 2) - pad,
    }
  }, [seed])
  return (
    <svg className="spark" viewBox="0 0 108 34" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.poly} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" opacity={0.85} />
      <circle cx={pts.lastX} cy={pts.lastY} r={2.3} fill={color} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "M:SS" until a deadline, or null once it has passed. */
export function mmss(deadline: number | null | undefined, now: number): string | null {
  if (deadline == null) return null
  const s = Math.round((deadline - now) / 1000)
  if (s <= 0) return null
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function agoLabel(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function updatedAgo(ts: number | null, now: number): string {
  if (!ts) return 'connecting…'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  return `${Math.floor(s / 60)}m ago`
}
