import { useGameStore } from '@/store/gameStore'
import { describeEvent } from '@/lib/seats'
import { useNow } from '@/lib/useNow'

/**
 * The live action narrative (§4 "watch the market"). The same public, redacted
 * events a spectator sees — newest on top, each stamped with how long ago it
 * landed and coloured by action kind (§12.11). Gives the contest a pulse
 * between your own turns.
 */
export function ActionFeed() {
  const feed = useGameStore((s) => s.feed)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  const token = useGameStore((s) => s.terms?.chipsToken ?? 'USDC')
  const now = useNow(1000)
  if (feed.length === 0) return null

  const recent = [...feed].slice(-7).reverse()

  return (
    <div className="feed panel">
      <div className="panel-title">Table feed</div>
      <ul className="feed-list">
        {recent.map((e, i) => (
          <li key={`${e.ts}-${i}`} className={`feed-row feed-row--${e.kind} ${i === 0 ? 'feed-row--new' : ''}`}>
            <span className="feed-text">{describeEvent(e, yourSeat, token)}</span>
            <span className="feed-ago mono">{ago(e.ts, now)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Compact relative time: "now", "4s", "3m". */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 1) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}
