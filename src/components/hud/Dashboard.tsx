import { useMemo } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
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
      return g.sort((a, b) => ratedScore(b) - ratedScore(a))
  }
}

function liveFor(startedAt: number): string {
  const m = Math.max(0, Math.round((Date.now() - startedAt) / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * The live-games dashboard (§8): the home surface. A list of running tables
 * ranked by popularity, sortable by various metrics.  Clicking "Take a seat"
 * connects the wallet first (if needed) then enters the table.
 */
export function Dashboard() {
  const games = useGameStore((s) => s.activeGames)
  const status = useGameStore((s) => s.discoveryStatus)
  const sort = useGameStore((s) => s.dashboardSort)
  const setSort = useGameStore((s) => s.setDashboardSort)
  const enterTable = useGameStore((s) => s.enterTable)
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)
  const playNow = useGameStore((s) => s.playNow)
  const playError = useGameStore((s) => s.playError)
  const balance = useGameStore((s) => s.chipBalance)

  const { connected, connecting } = useWallet()
  const { setVisible } = useWalletModal()

  const sorted = useMemo(() => sortGames(games, sort), [games, sort])

  const handleEnter = (matchId: string) => {
    if (!connected) {
      // Prompt wallet connection before entering a table
      setVisible(true)
      return
    }
    void enterTable(matchId)
  }

  const isEmpty = status === 'ready' && sorted.length === 0

  return (
    <div className="dash">
      <div className="dash-panel panel">
        <header className="dash-head">
          <div>
            <div className="brand-mark">SATOSHI'S TABLE</div>
            <div className="eyebrow">live tables · a contest of conviction</div>
          </div>

          <div className="dash-head-right">
            {!connected && (
              <button
                className="dash-connect-btn"
                onClick={() => setVisible(true)}
                disabled={connecting}
                aria-label="Connect Solana wallet to play"
              >
                {connecting ? 'Connecting…' : '◎ Connect wallet to play'}
              </button>
            )}

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
          </div>
        </header>

        {/* Hero: one-tap matchmaking — join an open table or create one (§4). */}
        <div className="dash-hero">
          <div className="dash-hero-copy">
            <div className="dash-hero-title">Ready to play?</div>
            <div className="eyebrow">
              We'll seat you at an open table — or start a fresh one for you.
            </div>
          </div>
          <button className="play-now-btn" onClick={() => void playNow()}>
            ▶ Play now
          </button>
        </div>
        {playError && <div className="dash-state--error eyebrow dash-play-error">{playError}</div>}

        {status === 'loading' && (
          <div className="dash-state eyebrow">Loading live tables…</div>
        )}

        {status === 'error' && (
          <div className="dash-state dash-state--error">
            <span className="eyebrow">Couldn't reach the games server.</span>
            <button className="chip" onClick={() => void loadDiscovery()}>
              Retry
            </button>
          </div>
        )}

        {isEmpty && (
          <div className="dash-state">
            <span className="eyebrow">No live tables right now.</span>
            <span className="dash-state-sub eyebrow">
              Be the first to host a match, or check back in a moment.
            </span>
            <button className="chip" onClick={() => void loadDiscovery()}>
              Refresh
            </button>
          </div>
        )}

        {sorted.length > 0 && (
          <ul className="dash-list">
            {sorted.map((g) => (
              <li key={g.matchId} className="dash-row" onClick={() => handleEnter(g.matchId)}>
                <span className={`dash-feed feed-${g.feed.split('/')[0].toLowerCase()}`}>
                  {g.feed}
                </span>
                <span className="dash-col">
                  <span className="eyebrow">buy-in</span>
                  <span className="mono">{g.buyIn.toLocaleString()}</span>
                </span>
                <span className="dash-col">
                  <span className="eyebrow">pot</span>
                  <span className="mono dash-pot">{g.potSize.toLocaleString()}</span>
                </span>
                <span className="dash-col">
                  <span className="eyebrow">watching</span>
                  <span className="mono">{g.spectators}</span>
                </span>
                <span className="dash-col">
                  <span className="eyebrow">live</span>
                  <span className="mono">{liveFor(g.startedAt)}</span>
                </span>
                <span className="dash-join">
                  {!connected ? 'Connect to play →' : 'Take a seat →'}
                </span>
              </li>
            ))}
          </ul>
        )}

        <footer className="dash-foot">
          {connected ? (
            <>
              <span className="eyebrow">wallet connected · devnet</span>
              <span className="mono">
                {balance != null ? `${balance.toLocaleString()} USDC` : '—'}
              </span>
            </>
          ) : (
            <span className="eyebrow">connect a wallet to take a seat</span>
          )}
        </footer>
      </div>
    </div>
  )
}
