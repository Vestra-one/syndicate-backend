import { useCallback, useEffect, useRef, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { useNow } from '@/lib/useNow'
import { formatChips, formatCountdown } from '@/lib/format'
import { buildInviteUrl } from '@/lib/invite'
import { projectFeltCentre, projectWaitingSeat, type ScreenPoint } from '@/three/table/tableView'
import { PAST_FILLING_PHASES } from '@/lib/protocol'
import { seatAlias, seatTag, describeEvent } from '@/lib/seats'
import { SeatPod } from './SeatPod'
import { personaEmblem } from './Seats'
import { ReclaimCard } from './ReclaimCard'

/**
 * The pre-game "table filling" experience (§4→§5 handoff). Once you're seated
 * but the hand hasn't gone live, this is what the felt should say: how long
 * until it begins, who's in, and that your stake is safely committed.
 *
 * The layout is a full-surface console laid OVER the 3D table and price
 * cabinet (which stay put): two rails of engraved-brass cards flank the felt,
 * the seats ring the outer rail (filled medallions + locked "open" chips), a
 * quiet caption names the fill in the centre of the felt, and a dock along the
 * bottom carries the exit + the trust seal.
 */

/** Derived waiting state shared by the centre caption, the betting panel, and the stake card. */
export function useWaiting() {
  const seated = useGameStore((s) => s.seated)
  const match = useGameStore((s) => s.match)
  const terms = useGameStore((s) => s.terms)
  const fillDeadline = useGameStore((s) => s.fillDeadline)

  // Seated, and the match hasn't advanced past the join window (FILLING, or the
  // gateway's transient "UNKNOWN" for a freshly-created room it has no engine for yet).
  const active = seated && (!match || !PAST_FILLING_PHASES.includes(match.phase))
  const filled = Math.max(match?.seats.length ?? 0, seated ? 1 : 0)
  const min = terms?.minPlayers ?? 2
  const max = Math.max(terms?.maxPlayers ?? 0, filled, min)
  return { active, filled, min, max, enough: filled >= min, fillDeadline, terms, match }
}

/** Pin a DOM node to a projected 3D anchor, updated every animation frame (mirrors Seats). */
function useAnchor(project: () => ScreenPoint | null) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = ref.current
      if (!el) return
      const p = project()
      if (!p || p.behind) {
        el.style.opacity = '0'
        return
      }
      el.style.opacity = ''
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [project])
  return ref
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function WaitingRoom() {
  const w = useWaiting()
  if (!w.active) return null
  return (
    <div className="wr">
      <SeatRing max={w.max} match={w.match} />
      <FeltCaption filled={w.filled} max={w.max} min={w.min} enough={w.enough} />

      <aside className="wr-rail wr-rail--left">
        <YourSeatCard />
        <HowItWorksCard max={w.max} />
        <RecentActivityCard />
      </aside>

      <aside className="wr-rail wr-rail--right">
        <RoomInfoCard filled={w.filled} max={w.max} enough={w.enough} />
        <InviteCard filled={w.filled} max={w.max} />
        <TimerCard enough={w.enough} />
      </aside>

      <Dock />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Seats ringing the outer rail — real players as brass medallions, empty
// chairs as locked "open seat" chips. All pinned to the 3D table's rim.
// ---------------------------------------------------------------------------

function SeatRing({ max, match }: { max: number; match: ReturnType<typeof useWaiting>['match'] }) {
  const yourSeat = match?.yourSeat ?? 0
  const taken = new Set((match?.seats ?? []).map((s) => s.seat))

  // Every chair gets a fixed slot by seat index (0→leftmost … max-1→rightmost),
  // fanned across the front of the felt clear of the cabinet. Your chair is a lit
  // medallion; other seated players are brass coins; the rest are locked & open.
  const angles = waitingSeatAngles(max)

  return (
    <div className="wr-seats">
      {angles.map((angle, seat) => {
        if (seat === yourSeat) return <YouSeat key="you" angle={angle} />
        if (taken.has(seat)) return <FilledSeat key={`f${seat}`} angle={angle} seat={seat} yourSeat={yourSeat} />
        // the lowest-indexed empty chair reads as "up next" to show live filling
        const nextEmpty = [...Array(max).keys()].find((i) => i !== yourSeat && !taken.has(i))
        return <OpenSeat key={`o${seat}`} angle={angle} next={seat === nextEmpty} />
      })}
    </div>
  )
}

function YouSeat({ angle }: { angle: number }) {
  const ref = useAnchor(useCallback(() => projectWaitingSeat(angle), [angle]))
  const addr = useGameStore((s) => s.walletAddress)
  const short = addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : 'You'
  return (
    <div ref={ref} className="wr-seat wr-seat--you" style={{ opacity: 0 }}>
      <div className="wr-seat-medallion">
        <span className="wr-seat-btc">₿</span>
      </div>
      <div className="wr-seat-plate wr-seat-plate--you">
        <span className="wr-seat-addr mono">{short}</span>
        <span className="wr-seat-youtag">YOU</span>
      </div>
    </div>
  )
}

/**
 * Even fan of `n` chairs across the front arc, symmetric about dead-centre.
 * Spans ±SPREAD so the widest chairs still sit on the felt (not the rim under
 * the rails). Ordered left→right for a stable slot mapping.
 */
function waitingSeatAngles(n: number): number[] {
  if (n <= 0) return []
  if (n === 1) return [0]
  const SPREAD = 74
  return Array.from({ length: n }, (_, i) => -SPREAD + (2 * SPREAD * i) / (n - 1))
}

function FilledSeat({ angle, seat, yourSeat }: { angle: number; seat: number; yourSeat?: number }) {
  const ref = useAnchor(useCallback(() => projectWaitingSeat(angle), [angle]))
  const alias = seatAlias(seat, yourSeat)
  return (
    <div ref={ref} className="wr-seat wr-seat--filled" style={{ opacity: 0 }}>
      <div className="wr-seat-medallion">
        <span className="wr-seat-mono">{alias.replace(/^The\s+/, '').charAt(0).toUpperCase()}</span>
      </div>
      <div className="wr-seat-plate">{alias}</div>
    </div>
  )
}

function OpenSeat({ angle, next }: { angle: number; next: boolean }) {
  const ref = useAnchor(useCallback(() => projectWaitingSeat(angle), [angle]))
  return (
    <div ref={ref} className={`wr-seat wr-seat--open ${next ? 'wr-seat--next' : ''}`} style={{ opacity: 0 }}>
      <div className="wr-seat-medallion">
        <svg className="wr-seat-lock" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V7a3 3 0 0 1 3-3zm0 10a1.6 1.6 0 0 1 .8 3v2.2a.8.8 0 0 1-1.6 0V17a1.6 1.6 0 0 1 .8-3z"
          />
        </svg>
      </div>
      <div className="wr-seat-plate wr-seat-plate--open">Open seat</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Centre-of-felt caption — the quiet hero: "TABLE FILLING · n/max".
// ---------------------------------------------------------------------------

function FeltCaption({ filled, max, min, enough }: { filled: number; max: number; min: number; enough: boolean }) {
  const ref = useAnchor(useCallback(() => projectFeltCentre(), []))
  const need = Math.max(0, min - filled)
  return (
    <div ref={ref} className="wr-felt" style={{ opacity: 0 }}>
      <div className="wr-felt-eyebrow">{enough ? 'Table ready' : 'Table filling'}</div>
      <div className="wr-felt-count">
        <b>{filled}</b>
        <span className="wr-felt-slash">/</span>
        {max}
      </div>
      <div className="wr-felt-sub">players joined</div>
      <div className="wr-felt-pips" aria-hidden="true">
        {Array.from({ length: max }).map((_, i) => (
          <span key={i} className={`wr-felt-pip ${i < filled ? 'wr-felt-pip--on' : ''}`} />
        ))}
      </div>
      <div className={`wr-felt-hint ${enough ? 'wr-felt-hint--ready' : ''}`}>
        {enough ? 'The match begins shortly' : `Waiting for ${need} more ${need === 1 ? 'trader' : 'traders'}`}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// LEFT rail
// ---------------------------------------------------------------------------

function YourSeatCard() {
  const terms = useGameStore((s) => s.terms)
  const match = useGameStore((s) => s.match)
  const [showDetails, setShowDetails] = useState(false)
  if (!terms) return null
  const seatNo = (match?.yourSeat ?? 0) + 1

  return (
    <section className="wr-card wr-card--seat">
      <div className="wr-card-title">Your seat</div>
      <div className="wr-seat-hero">
        <span className="wr-seat-num mono">{seatNo}</span>
        <span className="wr-seat-token">USDC</span>
      </div>
      <div className="wr-kv-row">
        <div className="wr-kv">
          <span className="wr-kv-label">Buy-in</span>
          <span className="wr-kv-value mono">{formatChips(terms.buyIn)}</span>
        </div>
        <div className="wr-kv">
          <span className="wr-kv-label">Entry fee</span>
          <span className="wr-kv-value mono">{formatChips(terms.entryFee)}</span>
        </div>
      </div>
      {showDetails && (
        <div className="wr-seat-detail">
          <div className="wr-detail-row">
            <span>Stack</span>
            <span className="mono">{formatChips(match?.yourStack ?? terms.buyIn)} {terms.chipsToken}</span>
          </div>
          <div className="wr-detail-row">
            <span>Committed</span>
            <span className="mono">{formatChips(match?.yourExposure ?? 0)} {terms.chipsToken}</span>
          </div>
          <div className="wr-detail-row wr-detail-row--muted">
            <span>Refund if the table voids</span>
            <span className="mono">full</span>
          </div>
          <SealAction />
          <ReclaimCard onchainMatchId={terms.onchainMatchId} />
        </div>
      )}
      <button className="wr-ghost-btn" onClick={() => setShowDetails((v) => !v)}>
        {showDetails ? 'Hide details' : 'View position details'}
      </button>
    </section>
  )
}

/** Optional early lock-in of your sealed prediction (survives the layout change). */
function SealAction() {
  const terms = useGameStore((s) => s.terms)
  const sealStatus = useGameStore((s) => s.sealStatus)
  const lastPrice = useGameStore((s) => s.priceHistory.at(-1)?.price ?? null)
  const seal = useGameStore((s) => s.sealPrediction)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')

  useEffect(() => {
    if (open && text === '' && lastPrice != null) setText(lastPrice.toFixed(terms?.decimals ?? 2))
  }, [open, lastPrice, terms, text])

  if (sealStatus === 'sealed') {
    return <div className="wr-seal-done"><span className="wr-seal-lock">🔒</span> Prediction sealed</div>
  }
  const decimals = terms?.decimals ?? 2
  const value = Number(text)
  const valid = Number.isFinite(value) && value > 0
  const sealing = sealStatus === 'sealing'

  if (!open) {
    return (
      <button className="wr-seal-open" onClick={() => setOpen(true)}>
        Seal your prediction early
      </button>
    )
  }
  return (
    <div className="wr-seal">
      <div className="wr-seal-input-row">
        <span className="wr-seal-cur mono">$</span>
        <input
          className="wr-seal-input mono"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="price"
        />
      </div>
      <button
        className="wr-seal-btn"
        disabled={!valid || sealing}
        onClick={() => valid && !sealing && seal(Math.round(value * 10 ** decimals))}
      >
        {sealing ? 'Sealing…' : 'Seal prediction'}
      </button>
    </div>
  )
}

function HowItWorksCard({ max }: { max: number }) {
  const steps = [
    `The table fills up to ${max} players`,
    'Seal the prediction',
    'Match begins automatically',
    'Winners share the pot',
  ]
  return (
    <section className="wr-card">
      <div className="wr-card-title">How it works</div>
      <ol className="wr-steps">
        {steps.map((s, i) => (
          <li key={i} className="wr-step">
            <span className="wr-step-num">{i + 1}</span>
            <span className="wr-step-text">{s}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function RecentActivityCard() {
  const feed = useGameStore((s) => s.feed)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  const now = useNow(15_000)
  const recent = [...feed].slice(-4).reverse()

  return (
    <section className="wr-card">
      <div className="wr-card-title">Recent activity</div>
      {recent.length === 0 ? (
        <div className="wr-activity-empty">
          Quiet so far — invite a few traders to get the table moving.
        </div>
      ) : (
        <ul className="wr-activity">
          {recent.map((e, i) => (
            <li key={`${e.ts}-${i}`} className="wr-activity-row">
              <span className="wr-activity-dot" aria-hidden="true" />
              <span className="wr-activity-text">{describeEvent(e, yourSeat)}</span>
              <span className="wr-activity-ago mono">{ago(e.ts, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

// ---------------------------------------------------------------------------
// RIGHT rail
// ---------------------------------------------------------------------------

function RoomInfoCard({ filled, max, enough }: { filled: number; max: number; enough: boolean }) {
  const terms = useGameStore((s) => s.terms)
  if (!terms) return null
  const matchId = terms.onchainMatchId ?? terms.matchPda ?? null
  const shortId = matchId ? `${matchId.slice(0, 4)}…${matchId.slice(-4)}` : '—'

  return (
    <section className="wr-card">
      <div className="wr-card-title">Room info</div>
      <div className="wr-info">
        <InfoRow label="Buy-in" value={`${formatChips(terms.buyIn)} ${terms.chipsToken}`} />
        <InfoRow label="Entry fee" value={`${formatChips(terms.entryFee)} ${terms.chipsToken}`} />
        <InfoRow label="Feed" value={terms.priceFeedId} />
        <InfoRow label="Players" value={`${filled} / ${max}`} />
        <InfoRow label="Status" value={enough ? 'Ready to start' : 'Waiting for players'} accent={enough} />
        <InfoRow label="Room ID" value={shortId} mono />
      </div>
    </section>
  )
}

function InfoRow({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: boolean }) {
  return (
    <div className="wr-info-row">
      <span className="wr-info-label">{label}</span>
      <span className={`wr-info-value ${mono ? 'mono' : ''} ${accent ? 'wr-info-value--accent' : ''}`}>{value}</span>
    </div>
  )
}

function InviteCard({ filled, max }: { filled: number; max: number }) {
  const terms = useGameStore((s) => s.terms)
  const matchId = terms?.onchainMatchId ?? terms?.matchPda ?? null
  const [copied, setCopied] = useState(false)
  if (!matchId || filled >= max) return null
  const url = buildInviteUrl(matchId)

  const copy = () => {
    void navigator.clipboard?.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const share = () => {
    navigator.share?.({ title: "Satoshi's Table", text: 'Join my table on Satoshi’s Table', url }).catch(() => {})
  }

  return (
    <section className="wr-card wr-card--invite">
      <div className="wr-card-title">Invite friends</div>
      <div className="wr-invite-copy">Invite more traders and start the match sooner.</div>
      <div className="wr-invite-glyph" aria-hidden="true">
        <svg viewBox="0 0 48 24" width="72" height="36">
          <circle cx="12" cy="9" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 22c0-5 4-8 9-8s9 3 9 8" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="33" cy="10" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
          <path d="M25 22c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
          <path d="M43 6v6M46 9h-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <button className={`wr-invite-primary ${copied ? 'wr-invite-primary--done' : ''}`} onClick={copy}>
        {copied ? '✓ Invite link copied' : 'Invite friends'}
      </button>
      {canShare && (
        <button className="wr-invite-secondary" onClick={share}>↗ Share link</button>
      )}
    </section>
  )
}

function TimerCard({ enough }: { enough: boolean }) {
  const fillDeadline = useGameStore((s) => s.fillDeadline)
  const leave = useGameStore((s) => s.leaveToDiscovery)
  const now = useNow(250)
  const remaining = fillDeadline != null ? Math.max(0, fillDeadline - now) : null
  const expired = remaining != null && remaining <= 0

  if (expired && !enough) {
    return (
      <section className="wr-card wr-card--timer wr-card--stalled">
        <div className="wr-timer-icon" aria-hidden="true">⌛</div>
        <div className="wr-timer-label">The table didn’t fill in time</div>
        <button className="wr-timer-leave" onClick={() => leave()}>Back to tables</button>
      </section>
    )
  }

  return (
    <section className="wr-card wr-card--timer">
      <div className="wr-timer-head">
        <span className="wr-timer-icon" aria-hidden="true">⌛</span>
        <span className="wr-timer-cap">{enough ? 'Match starting' : 'Starts automatically in'}</span>
      </div>
      <div className="wr-timer-clock mono">{remaining != null ? formatCountdown(remaining) : '—'}</div>
      <div className="wr-timer-sub">
        {enough ? 'All set — dealing you in' : 'The match starts as soon as the table is seated.'}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Bottom dock — exit + sound + trust seal
// ---------------------------------------------------------------------------

function Dock() {
  const leave = useGameStore((s) => s.leaveToDiscovery)
  const [sound, setSound] = useState(() => (typeof localStorage !== 'undefined' ? localStorage.getItem('st-sound') !== 'off' : true))
  const toggleSound = () => {
    setSound((v) => {
      const next = !v
      try { localStorage.setItem('st-sound', next ? 'on' : 'off') } catch { /* ignore */ }
      return next
    })
  }

  return (
    <div className="wr-dock">
      <div className="wr-dock-left">
        <button className="wr-dock-btn" onClick={() => leave()}>Leave table</button>
        <button className="wr-dock-btn wr-dock-btn--sound" onClick={toggleSound}>
          {sound ? '🔊' : '🔈'} Sound: {sound ? 'On' : 'Off'}
        </button>
      </div>
      <div className="wr-assure">
        <span className="wr-assure-shield" aria-hidden="true">🛡</span>
        <span className="wr-assure-head">Secure · Fair · Verifiable</span>
        <span className="wr-assure-sub">Predictions are sealed and encrypted</span>
      </div>
    </div>
  )
}
