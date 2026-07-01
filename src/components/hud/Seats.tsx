import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useGameStore } from '@/store/gameStore'
import { seatAlias, seatTag } from '@/lib/seats'
import { formatChips } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { projectPot, projectSeatAngle, seatAngles, type ScreenPoint } from '@/three/table/tableView'
import type { MatchStateView, PublicEvent, SeatView } from '@/lib/protocol'
import { SeatPod, type StatusTone } from './SeatPod'

/**
 * Players seated around the table's OUTER RING, plus the pot at the centre of
 * the felt. Each opponent is a full player pod (portrait, name, status, stack,
 * behaviour tag, live-turn ring) pinned to a 3D world anchor and re-projected
 * to screen space every frame (see tableView), so they ride the table as the
 * camera sways rather than hovering in screen space.
 *
 * "You" sit at the front and act through the betting panel, so only opponents
 * get a table pod.
 */
export function Seats() {
  const match = useGameStore((s) => s.match)
  const feed = useGameStore((s) => s.feed)
  const token = useGameStore((s) => s.terms?.chipsToken ?? 'ETH')
  const actionSecs = useGameStore((s) => s.terms?.actionTimerSec ?? 0)
  if (!match) return null
  // Opponents in stable seat order, laid out symmetrically for this table size
  // so the arrangement stays composed whether 1 or 4 of them are seated.
  const others = match.seats
    .filter((s) => s.seat !== match.yourSeat)
    .sort((a, b) => a.seat - b.seat)
  const angles = seatAngles(others.length)

  return (
    <div className="table-seats">
      {others.map((s, i) => (
        <OpponentPod
          key={s.seat}
          seat={s}
          angle={angles[i]}
          match={match}
          feed={feed}
          token={token}
          actionSecs={actionSecs}
        />
      ))}
      {match.pot > 0 && <Pot amount={match.pot} />}
    </div>
  )
}

/** Pin a DOM node to a projected 3D anchor, updated every animation frame. */
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

function monogram(alias: string): string {
  return alias.replace(/^The\s+/, '').charAt(0).toUpperCase()
}

/** The persona's engraved sigil for its avatar, or a monogram fallback. Shared with the waiting ring. */
export function personaEmblem(alias: string): ReactElement | string {
  return SIGILS[alias] ?? monogram(alias)
}

/** Each player's most recent public action, used to colour their status line. */
function lastAction(feed: PublicEvent[], seat: number): PublicEvent | undefined {
  for (let i = feed.length - 1; i >= 0; i--) {
    const e = feed[i]
    if ('seat' in e && e.seat === seat && (e.kind === 'action' || e.kind === 'fold')) return e
  }
  return undefined
}

/** Derive the pod's status line + tone from turn order, fold state, and last action. */
function podStatus(
  seat: SeatView,
  match: MatchStateView,
  feed: PublicEvent[],
  token: string,
): { text: string; tone: StatusTone } {
  if (match.toActSeat === seat.seat) {
    return seat.seat === match.yourSeat
      ? { text: 'Your turn', tone: 'turn' }
      : { text: 'Thinking', tone: 'thinking' }
  }
  if (seat.folded) return { text: 'Folded', tone: 'folded' }
  if (seat.allIn) return { text: `All in · ${formatChips(seat.totalContribution)} ${token}`, tone: 'allin' }

  const a = lastAction(feed, seat.seat)
  const amt = seat.committedThisStreet > 0 ? `${formatChips(seat.committedThisStreet)} ${token}` : ''
  if (a?.kind === 'action') {
    switch (a.action) {
      case 'raiseTo':
      case 'betTo':
        return { text: `Raised ${amt}`.trim(), tone: 'raised' }
      case 'call':
        return { text: `Called ${amt}`.trim(), tone: 'called' }
      case 'check':
        return { text: 'Checked', tone: 'idle' }
    }
  }
  if (seat.committedThisStreet > 0) return { text: `Called ${amt}`, tone: 'called' }
  return { text: 'Waiting', tone: 'idle' }
}

function OpponentPod({
  seat,
  angle,
  match,
  feed,
  token,
  actionSecs,
}: {
  seat: SeatView
  angle: number
  match: MatchStateView
  feed: PublicEvent[]
  token: string
  actionSecs: number
}) {
  const ref = useAnchor(useCallback(() => projectSeatAngle(angle), [angle]))
  const now = useNow(500)
  const alias = seatAlias(seat.seat, match.yourSeat)
  const status = podStatus(seat, match, feed, token)
  const active = match.toActSeat === seat.seat && !seat.folded
  const sigil = SIGILS[alias]

  // Countdown pip on the acting seat. "You" gets the real server deadline;
  // opponents don't expose one, so we count their allotted action time from the
  // moment they took the turn (stamped when `active` flips on).
  const yourTurn = useGameStore((s) => s.yourTurn)
  const [turnStart, setTurnStart] = useState<number | null>(null)
  useEffect(() => { setTurnStart(active ? Date.now() : null) }, [active])

  let timer: string | undefined
  if (active) {
    if (seat.seat === match.yourSeat && yourTurn) {
      timer = `${Math.max(0, Math.ceil((yourTurn.deadline - now) / 1000))}s`
    } else if (turnStart && actionSecs > 0) {
      timer = `${Math.max(0, Math.ceil(actionSecs - (now - turnStart) / 1000))}s`
    }
  }

  return (
    <div ref={ref} className="table-seat" style={{ opacity: 0 }}>
      <SeatPod
        name={alias}
        seatNo={seat.seat + 1}
        emblem={sigil ?? monogram(alias)}
        status={status}
        stack={`${formatChips(seat.stack)} ${token}`}
        tag={seatTag(seat.seat, match.yourSeat)}
        active={active}
        folded={seat.folded}
        checked={status.tone === 'called'}
        timer={timer}
        side={angle < 0 ? 'left' : 'right'}
      />
    </div>
  )
}

const SIGILS: Record<string, ReactElement> = {
  // Duchess — a coronet
  'The Duchess': (
    <g fill="currentColor">
      <path d="M4 23l2-12 5 6 5-9 5 9 5-6 2 12z" />
      <rect x="4" y="22.5" width="24" height="4" rx="1.2" />
      <circle cx="6" cy="9" r="1.7" />
      <circle cx="16" cy="6" r="1.7" />
      <circle cx="26" cy="9" r="1.7" />
    </g>
  ),
  // Cardinal — a Latin cross
  'The Cardinal': (
    <path fill="currentColor" d="M13.4 4h5.2v7.4H26v5.2h-7.4V28h-5.2V16.6H6v-5.2h7.4z" />
  ),
  // Banker — a balance scale
  'The Banker': (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 6v20" />
      <path d="M8 27h16" />
      <path d="M6 11h20" />
      <circle cx="16" cy="5" r="1.8" fill="currentColor" stroke="none" />
      <path d="M6 11v5" />
      <path d="M26 11v5" />
      <path d="M1.5 16a4.5 3 0 0 0 9 0" />
      <path d="M21.5 16a4.5 3 0 0 0 9 0" />
    </g>
  ),
  // Stranger — a domino mask (eye holes punched via even-odd)
  'The Stranger': (
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M4 11c5-2 19-2 24 0 1 6-3 11-8 11-2 0-3-1-4-2-1 1-2 2-4 2-5 0-9-5-8-11zM9 13a3 2.2 0 1 0 6 0 3 2.2 0 1 0-6 0zM17 13a3 2.2 0 1 0 6 0 3 2.2 0 1 0-6 0z"
    />
  ),
  // Marquis — a fleur-de-lis
  'The Marquis': (
    <g fill="currentColor">
      <path d="M16 3c-2 3-2.5 7 0 10 2.5-3 2-7 0-10z" />
      <path d="M16 10c-3 0-7 1.5-7 6 0 3 2 5 4 5-2-2-2-5 3-7z" />
      <path d="M16 10c3 0 7 1.5 7 6 0 3-2 5-4 5 2-2 2-5-3-7z" />
      <rect x="11" y="19" width="10" height="3" rx="1" />
      <path d="M16 22c-1 4-1 5 0 7 1-2 1-3 0-7z" />
    </g>
  ),
}

function Pot({ amount }: { amount: number }) {
  const ref = useAnchor(useCallback(() => projectPot(), []))
  // The chips themselves are real 3D coins in the Three.js scene (see pot.ts);
  // the HUD only carries the amount label, floated just above the pile.
  return (
    <div ref={ref} className="table-pot" style={{ opacity: 0 }}>
      <div className="pot-eyebrow eyebrow">pot</div>
      <div className="pot-amount mono">{amount}</div>
    </div>
  )
}
