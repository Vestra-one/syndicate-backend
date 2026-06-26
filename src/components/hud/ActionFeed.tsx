import { useGameStore } from '@/store/gameStore'
import { describeEvent } from '@/lib/seats'

/**
 * The live action narrative (§4 "watch the market"). The same public, redacted
 * events a spectator sees — newest on top. Gives the contest a pulse between
 * your own turns.
 */
export function ActionFeed() {
  const feed = useGameStore((s) => s.feed)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  if (feed.length === 0) return null

  const recent = [...feed].slice(-7).reverse()

  return (
    <div className="feed panel">
      <div className="panel-title">Table feed</div>
      <ul className="feed-list">
        {recent.map((e, i) => (
          <li key={`${e.ts}-${i}`} className={`feed-row feed-row--${e.kind} ${i === 0 ? 'feed-row--new' : ''}`}>
            {describeEvent(e, yourSeat)}
          </li>
        ))}
      </ul>
    </div>
  )
}
