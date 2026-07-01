import { useCallback, useEffect, useRef } from 'react'
import { useGameStore } from '@/store/gameStore'
import { useNow } from '@/lib/useNow'
import { formatChips, formatCountdown } from '@/lib/format'
import { projectFeltCentre, type ScreenPoint } from '@/three/table/tableView'
import { PAST_FILLING_PHASES } from '@/lib/protocol'
import { ReclaimCard } from './ReclaimCard'

/**
 * The pre-game "table filling" experience (§4→§5 handoff). Once you're seated
 * but the hand hasn't gone live, this is what the felt should say: how long
 * until it begins, how many players are in, and that your stake is safely
 * committed. It answers the three things the raw "pot 0 / current bet 0" HUD
 * never did — when, who, and is my money OK.
 */

/** Derived waiting state shared by the centre timer, the betting panel, and the stake card. */
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

const RING_R = 52
const RING_C = 2 * Math.PI * RING_R

/** The centre-of-felt countdown + seat fill — the hero of the waiting screen. */
export function WaitingRoom() {
  const { active, filled, min, max, enough, fillDeadline, terms } = useWaiting()
  const ref = useAnchor(useCallback(() => projectFeltCentre(), []))
  const now = useNow(250)

  if (!active) return null

  const total = (terms?.fillWindowSec ?? 0) * 1000
  const remaining = fillDeadline != null ? Math.max(0, fillDeadline - now) : null
  const expired = remaining != null && remaining <= 0
  const frac = remaining != null && total > 0 ? Math.min(1, remaining / total) : 1
  const arcOffset = RING_C * (1 - frac)

  const stateCls = expired && !enough ? 'wr-ring--stalled' : enough ? 'wr-ring--ready' : 'wr-ring--wait'
  const need = Math.max(0, min - filled)

  return (
    <div className="waiting-room">
      <div ref={ref} className="wr-centre" style={{ opacity: 0 }}>
        <div className="wr-status">
          <div className="wr-count">
            <b>{filled}</b> of {max} seated
          </div>
          <div className="wr-pips" aria-hidden="true">
            {Array.from({ length: max }).map((_, i) => (
              <span key={i} className={`wr-pip ${i < filled ? 'wr-pip--on' : ''}`} />
            ))}
          </div>
          <div className={`wr-hint ${enough ? 'wr-hint--ready' : ''}`}>
            {enough
              ? 'Enough players — the hand begins shortly'
              : `Waiting for ${need} more ${need === 1 ? 'player' : 'players'}`}
          </div>
        </div>

        <div className={`wr-ring ${stateCls}`}>
          <svg viewBox="0 0 120 120" className="wr-ring-svg" aria-hidden="true">
            <circle className="wr-ring-track" cx="60" cy="60" r={RING_R} />
            <circle
              className="wr-ring-arc"
              cx="60"
              cy="60"
              r={RING_R}
              strokeDasharray={RING_C}
              strokeDashoffset={arcOffset}
              transform="rotate(-90 60 60)"
            />
          </svg>
          <div className="wr-ring-inner">
            {remaining != null && !expired ? (
              <>
                <span className="wr-time mono">{formatCountdown(remaining)}</span>
                <span className="wr-time-label">{enough ? 'until start' : 'left to fill'}</span>
              </>
            ) : (
              <span className="wr-time-big">{enough ? 'starting…' : expired ? "didn't fill" : 'waiting'}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Replaces the meaningless "pot 0 / current bet 0" during filling: what the
 * player actually wants to see pre-game is that their money is committed and safe.
 */
export function WaitingStake() {
  const { terms } = useWaiting()
  if (!terms) return null

  return (
    <div className="round panel wr-stake">
      <div className="wr-stake-head">
        <span className="wr-stake-check" aria-hidden="true">✓</span>
        <span className="eyebrow">your seat is secured</span>
      </div>
      <div className="wr-stake-amount mono">
        {formatChips(terms.buyIn)}
        <span className="wr-stake-unit"> {terms.chipsToken}</span>
      </div>
      <div className="wr-stake-rows">
        <div className="wr-stake-row">
          <span className="eyebrow">buy-in</span>
          <span className="mono">{formatChips(terms.buyIn)}</span>
        </div>
        <div className="wr-stake-row">
          <span className="eyebrow">entry fee</span>
          <span className="mono">{formatChips(terms.entryFee)}</span>
        </div>
      </div>
      <div className="wr-stake-note eyebrow">refunded in full if the table voids</div>
      <ReclaimCard onchainMatchId={terms.onchainMatchId} />
    </div>
  )
}
