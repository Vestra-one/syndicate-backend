import type { ReactElement } from 'react'
import type { SeatTag } from '@/lib/seats'

/**
 * A player pod — the seated-player representation modelled on the FIBO
 * reference: a lacquered oval carrying a portrait medallion (with its seat
 * number), the persona name, a colour-coded status line, the remaining stack,
 * a behaviour tag clipped under the rim, and — when it's their move — a bright
 * gold ring plus a countdown pip. Purely presentational; all state is derived
 * upstream (see Seats/WaitingRoom) so the same pod serves the live table
 * (`size: 'full'`) and the pre-game ring (`size: 'compact'`, plus an `empty`
 * locked variant for open chairs).
 */

export type StatusTone = 'called' | 'raised' | 'folded' | 'thinking' | 'turn' | 'allin' | 'idle' | 'seated'

export interface SeatPodProps {
  name: string
  seatNo?: number
  emblem?: ReactElement | string
  status?: { text: string; tone: StatusTone }
  stack?: string
  tag?: SeatTag
  active?: boolean
  folded?: boolean
  checked?: boolean
  /** all-in this hand — pins a gold ALL-IN ribbon on the pod */
  allIn?: boolean
  /** momentary CHECK beat — a check moves no money, so it needs a visible flash */
  flashCheck?: boolean
  timer?: string
  /** holds the dealer button this hand */
  dealer?: boolean
  side?: 'left' | 'right'
  size?: 'full' | 'compact'
  /** an unfilled chair — renders a locked, muted placeholder */
  empty?: boolean
  /** your own chair — a lit, highlighted pod */
  you?: boolean
  /** the open chair you're about to take — a highlighted, unlocked "sit here" marker */
  reserved?: boolean
}

function SeatGlyph() {
  return (
    <svg className="pod-lock pod-sit" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="7" r="3.4" fill="currentColor" />
      <path fill="currentColor" d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7v1H5z" />
    </svg>
  )
}

function LockGlyph() {
  return (
    <svg className="pod-lock" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V7a3 3 0 0 1 3-3z"
      />
    </svg>
  )
}

export function SeatPod({
  name,
  seatNo,
  emblem,
  status,
  stack,
  tag,
  active,
  folded,
  checked,
  allIn,
  flashCheck,
  timer,
  dealer,
  side = 'left',
  size = 'full',
  empty,
  you,
  reserved,
}: SeatPodProps) {
  const cls = [
    'pod',
    `pod--${side}`,
    size === 'compact' ? 'pod--compact' : '',
    active ? 'pod--active' : '',
    folded ? 'pod--folded' : '',
    allIn ? 'pod--allin' : '',
    empty ? 'pod--empty' : '',
    reserved ? 'pod--reserved' : '',
    you ? 'pod--you' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls}>
      <div className="pod-avatar">
        {reserved ? (
          <SeatGlyph />
        ) : empty ? (
          <LockGlyph />
        ) : typeof emblem === 'string' ? (
          <span className="pod-mono">{emblem}</span>
        ) : (
          <svg className="pod-sigil" viewBox="0 0 32 32" aria-hidden="true">
            {emblem}
          </svg>
        )}
      </div>

      <div className="pod-body">
        <div className="pod-name">{name}</div>
        {status && (
          <div className={`pod-status pod-status--${status.tone}`}>
            {status.tone === 'thinking' ? (
              <>
                {status.text}
                <span className="pod-dots" aria-hidden="true"><i /><i /><i /></span>
              </>
            ) : (
              status.text
            )}
          </div>
        )}
        {stack && <div className="pod-stack">Stack: {stack}</div>}
      </div>

      {seatNo != null && (!empty || reserved) && <span className="pod-seatno">{seatNo}</span>}

      {dealer && !empty && (
        <span className="pod-dealer" title="Dealer button" aria-label="Dealer button">
          D
        </span>
      )}

      {checked && (
        <span className="pod-check" aria-hidden="true">
          <svg viewBox="0 0 20 20"><path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M5 10.5l3.2 3.2L15 6.5" /></svg>
        </span>
      )}

      {allIn && !empty && <span className="pod-allin-ribbon">ALL-IN</span>}

      {flashCheck && (
        <span className="pod-check-flash" aria-hidden="true" key={`chk-${name}`}>CHECK</span>
      )}

      {timer && <span className="pod-timer">{timer}</span>}

      {tag && !empty && (
        <span className={`pod-tag pod-tag--${tag.kind}`} title={tag.hint}>
          <TagIcon kind={tag.kind} />
          {tag.label}
        </span>
      )}
    </div>
  )
}

function TagIcon({ kind }: { kind: SeatTag['kind'] }) {
  if (kind === 'aggressive') {
    return <svg className="pod-tag-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 2L4 14h6l-1 8 9-12h-6z" /></svg>
  }
  if (kind === 'unknown') {
    return <svg className="pod-tag-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" d="M9 9a3 3 0 1 1 4 2.8c-1 .5-1.5 1.2-1.5 2.2" /><circle cx="11.5" cy="18" r="1.4" fill="currentColor" /></svg>
  }
  // shield family: tight / safe / passive / balanced
  return <svg className="pod-tag-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2l8 3v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5z" opacity="0.9" /></svg>
}
