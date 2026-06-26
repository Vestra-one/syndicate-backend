import { useMemo } from 'react'
import { useGameStore } from '@/store/gameStore'
import { ratedScore } from '@/lib/discovery'
import type { DashboardSortKey, LiveGame } from '@/lib/protocol'
import './hud.css'

const SORTS: { key: DashboardSortKey; label: string }[] = [
  { key: 'gameTime', label: 'Hot' },
  { key: 'potSize', label: 'Pot' },
  { key: 'buyIn', label: 'Buy-in' },
  { key: 'feed', label: 'Feed' },
]

function sortGames(games: LiveGame[], key: DashboardSortKey): LiveGame[] {
  const g = [...games]
  switch (key) {
    case 'potSize':
      return g.sort((a, b) => b.potSize - a.potSize)
    case 'buyIn':
      return g.sort((a, b) => b.buyIn - a.buyIn)
    case 'feed':
      return g.sort((a, b) => a.feed.localeCompare(b.feed) || b.potSize - a.potSize)
    case 'gameTime':
    default:
      return g.sort((a, b) => ratedScore(b) - ratedScore(a)) // "hot" = rated popularity
  }
}

function liveFor(startedAt: number): string {
  const m = Math.max(0, Math.round((Date.now() - startedAt) / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * The live-games dashboard (§8): the home surface. A list of running tables
 * ranked by popularity and sortable, over the candlelit table backdrop. Picking
 * a table enters its lobby.
 */
export function Dashboard() {
  const games = useGameStore((s) => s.activeGames)
  const sort = useGameStore((s) => s.dashboardSort)
  const setSort = useGameStore((s) => s.setDashboardSort)
  const enterTable = useGameStore((s) => s.enterTable)
  const balance = useGameStore((s) => s.chipBalance)

  const sorted = useMemo(() => sortGames(games, sort), [games, sort])

  return (
    <div className="dash">
      <div className="dash-panel panel">
        <header className="dash-head">
          <div>
            <div className="brand-mark">SYNDICATE</div>
            <div className="eyebrow">live tables · a contest of conviction</div>
          </div>
          <div className="dash-sorts">
            {SORTS.map((s) => (
              <button
                key={s.key}
                className={`chip ${sort === s.key ? 'chip--active' : ''}`}
                onClick={() => setSort(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </header>

        <ul className="dash-list">
          {sorted.map((g) => (
            <li key={g.matchId} className="dash-row" onClick={() => enterTable(g.matchId)}>
              <span className={`dash-feed feed-${g.feed.split('/')[0].toLowerCase()}`}>{g.feed}</span>
              <span className="dash-col">
                <span className="eyebrow">buy-in</span>
                <span className="mono">{g.buyIn}</span>
              </span>
              <span className="dash-col">
                <span className="eyebrow">pot</span>
                <span className="mono dash-pot">{g.potSize}</span>
              </span>
              <span className="dash-col">
                <span className="eyebrow">watching</span>
                <span className="mono">{g.spectators}</span>
              </span>
              <span className="dash-col">
                <span className="eyebrow">live</span>
                <span className="mono">{liveFor(g.startedAt)}</span>
              </span>
              <span className="dash-join">Take a seat →</span>
            </li>
          ))}
        </ul>

        <footer className="dash-foot">
          <span className="eyebrow">demo wallet</span>
          <span className="mono">{balance != null ? `${balance} USDC` : '25000 USDC'}</span>
        </footer>
      </div>
    </div>
  )
}
