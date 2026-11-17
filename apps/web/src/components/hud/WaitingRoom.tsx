import { useCallback, useEffect, useRef, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { useNow } from '@/lib/useNow'
import { useAnchor } from '@/lib/useAnchor'
import { formatChips, formatCountdown } from '@/lib/format'
import { buildInviteUrl } from '@/lib/invite'
import { projectFeltCentre, projectWaitingSeat } from '@/three/table/tableView'
import { PAST_FILLING_PHASES, type SeatView } from '@/lib/protocol'
import { seatAlias, seatTag, describeEvent, hostAlias } from '@/lib/seats'
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
  const lobbySeated = useGameStore((s) => s.lobbySeated)

  // Seated, and the match hasn't advanced past the join window (FILLING, or the
  // gateway's transient "UNKNOWN" for a freshly-created room it has no engine for yet).
  const active = seated && (!match || !PAST_FILLING_PHASES.includes(match.phase))
  // During FILLING the snapshot's `seats` is EMPTY (engine seats are assigned at lock) —
  // the live confirmed count arrives via WS `seat_update` → store.lobbySeated (§5).
  const filled = Math.max(match?.seats.length ?? 0, lobbySeated ?? 0, seated ? 1 : 0)
  const min = terms?.minPlayers ?? 2
  const max = Math.max(terms?.maxPlayers ?? 0, filled, min)
  return { active, filled, min, max, enough: filled >= min, fillDeadline, terms, match }
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function WaitingRoom() {
  const w = useWaiting()
  const yourSeat = w.match?.yourSeat ?? 0
  const buyIn = w.terms?.buyIn ?? 0n
  // One canonical seating plan drives the ring, the join feed, and the join
  // animation, so every part of the screen agrees on who sits where.
  const plan = buildSeatPlan(w.max, yourSeat, w.match?.seats ?? [], w.filled)
  const joins = useJoins(plan, yourSeat)

  // Final-countdown escalation: once the auto-start clock is inside 10s the whole
  // room tenses — the felt lockup enlarges, the rim light warms, and Leave locks
  // in the last 3s so nobody triggers a refund edge case mid-deal (§10).
  const now = useNow(250)
  const full = w.filled >= w.max
  const remaining = w.fillDeadline != null ? Math.max(0, w.fillDeadline - now) : null
  const finalCountdown = (full || (remaining != null && remaining <= 10_000)) && !(remaining === 0 && !full)
  const seatsLocked = full || (remaining != null && remaining <= 3_000)

  if (!w.active) return null
  return (
    <div className={`wr ${finalCountdown ? 'wr--final' : ''} ${seatsLocked ? 'wr--locked' : ''}`}>
      <SeatRing plan={plan} match={w.match} buyIn={buyIn} joining={joins.flash} />
      <FeltCaption filled={w.filled} max={w.max} fillDeadline={w.fillDeadline} enough={w.enough} />

      <aside className="wr-rail wr-rail--left">
        <YourSeatCard />
        <HowItWorksCard max={w.max} />
        <RecentActivityCard joins={joins.log} />
      </aside>

      <aside className="wr-rail wr-rail--right">
        {full ? <TableFullCard plan={plan} match={w.match} buyIn={buyIn} /> : <InviteCard filled={w.filled} max={w.max} />}
        <RoomInfoCard filled={w.filled} max={w.max} />
      </aside>

      <Dock seatsLocked={seatsLocked} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Seating plan — one source of truth for which seat is you / seated / open.
// ---------------------------------------------------------------------------

type SeatCell =
  | { seat: number; kind: 'you' }
  | { seat: number; kind: 'seated'; sv?: SeatView }
  | { seat: number; kind: 'open'; next: boolean }

/**
 * Assigns every one of `max` fixed chairs a role. You sit at `yourSeat`; engine
 * seats (once assigned at lock) fill their real index; during FILLING the engine
 * hasn't assigned seats yet (snapshot `seats` is empty) so the confirmed count
 * beyond you (`filled`, from WS seat_update) shows as anonymous "Seated" pods in
 * the first open slots; the remainder are open, and the first open chair is
 * flagged `next` for the fill-me pulse.
 */
function buildSeatPlan(max: number, yourSeat: number, realSeats: SeatView[], filled: number): SeatCell[] {
  const byIndex = new Map(realSeats.map((s) => [s.seat, s]))
  const realOthers = realSeats.filter((s) => s.seat !== yourSeat).length
  let anonLeft = Math.max(0, filled - 1 - realOthers)
  let nextMarked = false
  const cells: SeatCell[] = []
  for (let seat = 0; seat < max; seat++) {
    if (seat === yourSeat) cells.push({ seat, kind: 'you' })
    else if (byIndex.has(seat)) cells.push({ seat, kind: 'seated', sv: byIndex.get(seat) })
    else if (anonLeft > 0) { anonLeft--; cells.push({ seat, kind: 'seated' }) }
    else { const next = !nextMarked; nextMarked = true; cells.push({ seat, kind: 'open', next }) }
  }
  return cells
}

/**
 * Watches the plan for newly-seated chairs and, when one appears, (a) flags it
 * for the seat-taken materialize beat and (b) drops a "<name> took seat N" line
 * into the activity feed. Skips the first render so an already-seated table
 * doesn't announce everyone at once.
 */
function useJoins(plan: SeatCell[], yourSeat: number) {
  const seatedKey = plan.filter((c) => c.kind === 'seated').map((c) => c.seat).join(',')
  const prev = useRef<Set<number> | null>(null)
  // Each join batch un-flashes independently. A single shared timer whose cleanup ran on every
  // deps change meant a second player joining within 1200ms cancelled the FIRST batch's
  // un-flash, leaving that seat stuck highlighted. Track timers in a ref; clear only on unmount.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const [flash, setFlash] = useState<Set<number>>(() => new Set())
  const [log, setLog] = useState<{ seat: number; ts: number }[]>([])

  useEffect(() => {
    const current = new Set(seatedKey ? seatedKey.split(',').map(Number) : [])
    if (prev.current == null) { prev.current = current; return }
    const added = [...current].filter((s) => !prev.current!.has(s))
    prev.current = current
    if (added.length === 0) return
    const now = Date.now()
    setLog((l) => [...added.map((seat) => ({ seat, ts: now })), ...l].slice(0, 6))
    setFlash((f) => { const n = new Set(f); added.forEach((s) => n.add(s)); return n })
    const t = setTimeout(() => {
      setFlash((f) => { const n = new Set(f); added.forEach((s) => n.delete(s)); return n })
      timers.current = timers.current.filter((x) => x !== t)
    }, 1200)
    timers.current.push(t)
  }, [seatedKey])

  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  return { flash, log: log.map((j) => ({ ...j, name: seatAlias(j.seat, yourSeat) })) }
}

// ---------------------------------------------------------------------------
// Seats ringing the outer rail — real players as brass medallions, empty
// chairs as recessed "open seat" chips. All pinned to the 3D table's rim.
// ---------------------------------------------------------------------------

function SeatRing({
  plan,
  match,
  buyIn,
  joining,
}: {
  plan: SeatCell[]
  match: ReturnType<typeof useWaiting>['match']
  buyIn: bigint
  joining: Set<number>
}) {
  const yourSeat = match?.yourSeat ?? 0
  const token = useGameStore((s) => s.terms?.chipsToken ?? 'USDC')
  const angles = waitingSeatAngles(plan.length)

  return (
    <div className="wr-seats">
      {plan.map((cell) => {
        const angle = angles[cell.seat] ?? 0
        const side: 'left' | 'right' = angle < 0 ? 'left' : 'right'
        if (cell.kind === 'you') {
          return (
            <SeatSlot key="you" angle={angle} side={side}>
              <YouPod seatNo={cell.seat + 1} stack={match?.yourStack ?? buyIn} token={token} yourSeat={yourSeat} side={side} />
            </SeatSlot>
          )
        }
        if (cell.kind === 'seated') {
          const alias = seatAlias(cell.seat, yourSeat)
          const stack = cell.sv?.stack ?? buyIn
          return (
            <SeatSlot key={cell.seat} angle={angle} side={side}>
              <SeatPod
                size="compact"
                side={side}
                name={alias}
                seatNo={cell.seat + 1}
                emblem={personaEmblem(alias)}
                status={{ text: 'Seated ✓', tone: 'seated' }}
                stack={`${formatChips(stack)} ${token}`}
                tag={seatTag(cell.seat, yourSeat)}
                joining={joining.has(cell.seat)}
              />
            </SeatSlot>
          )
        }
        return (
          <SeatSlot key={cell.seat} angle={angle} side={side}>
            <SeatPod size="compact" side={side} empty name="Open seat" next={cell.next} />
          </SeatSlot>
        )
      })}
    </div>
  )
}

/** Positions a pod against its projected 3D anchor on the felt. */
export function SeatSlot({ angle, side, children }: { angle: number; side: 'left' | 'right'; children: React.ReactNode }) {
  const ref = useAnchor(useCallback(() => projectWaitingSeat(angle), [angle]))
  return (
    <div ref={ref} className={`wr-seat wr-seat--${side}`} style={{ opacity: 0 }}>
      {children}
    </div>
  )
}

function YouPod({ seatNo, stack, token, yourSeat, side }: { seatNo: number; stack: bigint; token: string; yourSeat: number; side: 'left' | 'right' }) {
  const addr = useGameStore((s) => s.walletAddress)
  const short = addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : 'You'
  return (
    <SeatPod
      size="compact"
      you
      side={side}
      name={short}
      seatNo={seatNo}
      emblem="₿"
      status={{ text: 'You', tone: 'turn' }}
      stack={`${formatChips(stack)} ${token}`}
      tag={seatTag(yourSeat, yourSeat)}
    />
  )
}

/**
 * Even fan of `n` chairs across the front arc, symmetric about dead-centre.
 * Spans ±SPREAD so the pods sit on the open felt, clear of the flanking rails.
 * Ordered left→right for a stable slot mapping.
 */
export function waitingSeatAngles(n: number): number[] {
  if (n <= 0) return []
  if (n === 1) return [0]
  // Keep the fan narrow enough that the outermost chairs stay on the open felt
  // and never ride up onto the curved rim's engraved text (§9 "never overlapping
  // the engraved rim text").
  const SPREAD = 40
  return Array.from({ length: n }, (_, i) => -SPREAD + (2 * SPREAD * i) / (n - 1))
}

// ---------------------------------------------------------------------------
// Centre-of-felt caption — the quiet hero: "TABLE FILLING · n/max".
// ---------------------------------------------------------------------------

function FeltCaption({ filled, max, fillDeadline, enough }: { filled: number; max: number; fillDeadline: number | null; enough: boolean }) {
  const ref = useAnchor(useCallback(() => projectFeltCentre(), []))
  const now = useNow(250)
  const full = filled >= max
  const need = Math.max(0, max - filled)
  const remaining = fillDeadline != null ? Math.max(0, fillDeadline - now) : null
  const expired = remaining != null && remaining <= 0
  // The seal window opens the moment min players are met — the countdown only
  // *means* something then. Below min it's FILLING; at/above min it's COUNTDOWN.
  const counting = enough && remaining != null && !expired
  const finalSecs = counting && remaining <= 10_000
  const locking = full || (counting && remaining <= 3_000)

  // The one status line: FILLING waits for players; COUNTDOWN counts down but
  // notes more can still join; the last 10s escalate to a hard "dealing" beat.
  let clock: string
  if (full) clock = 'All seated — dealing you in'
  else if (locking) clock = `Seats locked — dealing in ${formatCountdown(remaining ?? 0)}`
  else if (counting) clock = `Match starts in ${formatCountdown(remaining)} · more can still join`
  else if (expired) clock = 'Fill window closed'
  // Still short of the minimum: the table closes (and refunds) at the deadline — a player
  // waiting alone needs to know how long that is.
  else clock = remaining != null
    ? `Waiting for ${need} more ${need === 1 ? 'trader' : 'traders'} · closes in ${formatCountdown(remaining)}`
    : `Waiting for ${need} more ${need === 1 ? 'trader' : 'traders'}`

  const eyebrow = full ? 'Table ready' : counting ? 'Match starting' : 'Table filling'

  return (
    <div ref={ref} className={`wr-felt ${finalSecs || full ? 'wr-felt--final' : ''}`} style={{ opacity: 0 }}>
      <div className="wr-felt-eyebrow">{eyebrow}</div>
      <div className="wr-felt-count">
        <b>{filled}</b>
        <span className="wr-felt-slash">/</span>
        {max}
      </div>
      {!full && !counting && (
        <div className="wr-felt-need">
          Waiting for {need} more {need === 1 ? 'trader' : 'traders'}
        </div>
      )}
      <div className={`wr-felt-clock ${full || counting ? 'wr-felt-clock--ready' : ''}`}>
        <span className="wr-felt-clock-icon" aria-hidden="true">{locking ? '🔒' : '⏳'}</span>
        {clock}
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

  const token = terms.chipsToken
  const total = terms.buyIn + terms.entryFee
  return (
    <section className="wr-card wr-card--seat">
      <div className="wr-card-title">Your seat</div>
      <div className="wr-seat-hero">
        <span className="wr-seat-label">Seat</span>
        <span className="wr-seat-num mono">{seatNo}</span>
      </div>
      <div className="wr-seat-money">
        <span className="mono">{formatChips(terms.buyIn)}</span> buy-in
        <span className="wr-seat-plus">+</span>
        <span className="mono">{formatChips(terms.entryFee)}</span> entry
      </div>
      <div className="wr-seat-total">
        <span className="wr-seat-total-label">Committed</span>
        <span className="wr-seat-total-val mono">{formatChips(total)} {token}</span>
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

/** Optional early lock-in of your prediction — held on-device and auto-sealed at table lock. */
function SealAction() {
  const terms = useGameStore((s) => s.terms)
  const sealStatus = useGameStore((s) => s.sealStatus)
  const queued = useGameStore((s) => s.queuedPrediction)
  const lastPrice = useGameStore((s) => s.priceHistory.at(-1)?.price ?? null)
  const seal = useGameStore((s) => s.sealPrediction)
  const clearQueued = useGameStore((s) => s.clearQueuedPrediction)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')

  useEffect(() => {
    if (open && text === '' && lastPrice != null) setText(lastPrice.toFixed(terms?.decimals ?? 2))
  }, [open, lastPrice, terms, text])

  const decimals = terms?.decimals ?? 2

  if (sealStatus === 'sealed') {
    return <div className="wr-seal-done"><span className="wr-seal-lock">🔒</span> Prediction sealed</div>
  }
  if (queued != null && !open) {
    return (
      <div className="wr-seal-done">
        <span className="wr-seal-lock">🕐</span> ${(queued / 10 ** decimals).toFixed(decimals)} locked in — seals at table lock{' '}
        <button className="wr-seal-open" onClick={() => { clearQueued(); setOpen(true) }}>Change</button>
      </div>
    )
  }
  const value = Number(text)
  const valid = Number.isFinite(value) && value > 0
  const sealing = sealStatus === 'sealing'

  if (!open) {
    return (
      <button className="wr-seal-open" onClick={() => setOpen(true)}>
        Lock in your prediction early
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
          aria-label="Prediction price"
        />
      </div>
      <button
        className="wr-seal-btn"
        disabled={!valid || sealing}
        onClick={() => { if (valid && !sealing) { seal(Math.round(value * 10 ** decimals)); setOpen(false) } }}
      >
        {sealing ? 'Sealing…' : 'Lock in prediction'}
      </button>
    </div>
  )
}

function HowItWorksCard({ max }: { max: number }) {
  const steps = [
    `The table fills up to ${max} players`,
    'Seal the prediction',
    'Match begins automatically',
    'Closest call takes the pot',
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

function RecentActivityCard({ joins }: { joins: { seat: number; ts: number; name: string }[] }) {
  const feed = useGameStore((s) => s.feed)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  const token = useGameStore((s) => s.terms?.chipsToken ?? 'USDC')
  const now = useNow(15_000)

  // Seat-taken lines (local, since FILLING carries no per-seat join event) merged
  // chronologically with the public action feed, newest first.
  const items = [
    ...joins.map((j) => ({ ts: j.ts, text: `${j.name} took seat ${j.seat + 1}` })),
    ...feed.map((e) => ({ ts: e.ts, text: describeEvent(e, yourSeat, token) })),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 4)

  return (
    <section className="wr-card">
      <div className="wr-card-title">Recent activity</div>
      {items.length === 0 ? (
        <div className="wr-activity-empty">
          Quiet so far — invite a few traders to get the table moving.
        </div>
      ) : (
        <ul className="wr-activity">
          {items.map((it, i) => (
            <li key={`${it.ts}-${i}`} className="wr-activity-row">
              <span className="wr-activity-dot" aria-hidden="true" />
              <span className="wr-activity-text">{it.text}</span>
              <span className="wr-activity-ago mono">{ago(it.ts, now)}</span>
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

function RoomInfoCard({ filled, max }: { filled: number; max: number }) {
  const terms = useGameStore((s) => s.terms)
  if (!terms) return null
  const matchId = terms.onchainMatchId ?? terms.matchPda ?? null
  // Only abbreviate long ids (a PDA); a short on-chain id reads fine whole — "20000" was
  // being rendered as "2000…0000".
  const shortId = !matchId ? '—' : matchId.length > 12 ? `${matchId.slice(0, 4)}…${matchId.slice(-4)}` : matchId

  // No "Status" row here — the felt centre is the single status source (§5). This
  // card is just the static table facts.
  return (
    <section className="wr-card">
      <div className="wr-card-title">Room info</div>
      <div className="wr-info">
        <InfoRow label="Buy-in" value={`${formatChips(terms.buyIn)} ${terms.chipsToken}`} />
        <InfoRow label="Entry fee" value={`${formatChips(terms.entryFee)} ${terms.chipsToken}`} />
        <InfoRow label="Feed" value={terms.priceFeedId} />
        <InfoRow label="Players" value={`${filled} / ${max}`} />
        <InfoRow label="Room ID" value={shortId} mono />
      </div>
    </section>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="wr-info-row">
      <span className="wr-info-label">{label}</span>
      <span className={`wr-info-value ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  )
}

/**
 * At 5/5 the invite panel is dead UI — swap it for a roster summary of the full
 * table (every seat, its persona read) plus the pot-to-play preview, so the last
 * window before the deal reads as "everyone's here" rather than "still inviting" (§11).
 */
function TableFullCard({ plan, match, buyIn }: { plan: SeatCell[]; match: ReturnType<typeof useWaiting>['match']; buyIn: bigint }) {
  const terms = useGameStore((s) => s.terms)
  const token = terms?.chipsToken ?? 'USDC'
  const yourSeat = match?.yourSeat ?? 0
  const potPreview = buyIn * BigInt(plan.length)
  return (
    <section className="wr-card wr-card--full">
      <div className="wr-card-title">Table full</div>
      <div className="wr-full-copy">All seats taken — the hand is about to deal.</div>
      <ul className="wr-roster">
        {plan.map((cell) => {
          const isYou = cell.kind === 'you'
          const alias = isYou ? 'You' : seatAlias(cell.seat, yourSeat)
          const tag = seatTag(cell.seat, yourSeat)
          const initial = isYou ? '₿' : alias.replace(/^The\s+/, '').charAt(0).toUpperCase()
          return (
            <li key={cell.seat} className={`wr-roster-row ${isYou ? 'wr-roster-row--you' : ''}`}>
              <span className="wr-roster-emblem" aria-hidden="true">{initial}</span>
              <span className="wr-roster-name">{alias}</span>
              <span className={`wr-roster-tag pod-tag--${tag.kind}`} title={tag.hint}>{tag.label}</span>
            </li>
          )
        })}
      </ul>
      <div className="wr-full-pot">
        <span className="eyebrow">pot to play for</span>
        <span className="mono">{formatChips(potPreview)} {token} <span className="wr-full-pot-fees">+ fees</span></span>
      </div>
    </section>
  )
}

function InviteCard({ filled, max }: { filled: number; max: number }) {
  const terms = useGameStore((s) => s.terms)
  const matchId = terms?.onchainMatchId ?? terms?.matchPda ?? null
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])
  if (!matchId || filled >= max) return null
  // Sign the link with a stable table alias so the invitee sees "<name> invited you".
  const url = buildInviteUrl(matchId, hostAlias(matchId))

  const copy = () => {
    // Only show "copied" if the write actually succeeded — a denied/insecure-context clipboard
    // rejects, and confirming success there is a lie. Timer is tracked + cleared on unmount.
    navigator.clipboard?.writeText(url)
      .then(() => {
        setCopied(true)
        if (copiedTimer.current) clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => { /* clipboard unavailable — leave the button in its default state */ })
  }
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const share = () => {
    navigator.share?.({ title: "Satoshi Table", text: 'Join my table on Satoshi Table', url }).catch(() => {})
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
      <Toast show={copied} text="Invite link copied to clipboard" />
    </section>
  )
}

/** A transient confirmation pill, pinned bottom-centre above the dock. */
function Toast({ show, text }: { show: boolean; text: string }) {
  if (!show) return null
  return (
    <div className="wr-toast" role="status">
      <span className="wr-toast-check" aria-hidden="true">✓</span>
      {text}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bottom dock — exit + sound + trust seal
// ---------------------------------------------------------------------------

function Dock({ seatsLocked }: { seatsLocked: boolean }) {
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
        <button
          className="wr-dock-btn"
          onClick={() => leave()}
          disabled={seatsLocked}
          title={seatsLocked ? 'Seats are locked — the hand is being dealt' : undefined}
        >
          Leave table
        </button>
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
