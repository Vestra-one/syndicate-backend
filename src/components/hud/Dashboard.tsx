import { useMemo } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'
import { ratedScore } from '@/lib/discovery'
import type { DashboardSortKey, LiveGame, UpcomingGame } from '@/lib/protocol'
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

function fillDeadlineLabel(ts?: number): string {
  if (!ts) return '—'
  const secs = Math.max(0, Math.round((ts - Date.now()) / 1000))
  if (secs < 60) return `${secs}s left`
  return `${Math.round(secs / 60)}m left`
}

function fmt(amount: number) {
  return (amount / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function UpcomingRow({ game, onJoin }: { game: UpcomingGame; onJoin: () => void }) {
  return (
    <li className="dash-row dash-row--upcoming" onClick={onJoin}>
      <span className={`dash-feed feed-${game.feed.split('/')[0].toLowerCase()}`}>
        {game.feed}
      </span>
      <span className="dash-col">
        <span className="eyebrow">buy-in</span>
        <span className="mono">{fmt(game.buyIn)} USDC</span>
      </span>
      <span className="dash-col">
        <span className="eyebrow">seats</span>
        <span className="mono">{game.seated}/{game.maxPlayers}</span>
      </span>
      {game.fillDeadline ? (
        <span className="dash-col">
          <span className="eyebrow">closes</span>
          <span className="mono">{fillDeadlineLabel(game.fillDeadline)}</span>
        </span>
      ) : null}
      <span className="dash-join dash-join--upcoming">Join →</span>
    </li>
  )
}

function ActiveRow({ game, onWatch }: { game: LiveGame; onWatch: () => void }) {
  return (
    <li className="dash-row" onClick={onWatch}>
      <span className={`dash-feed feed-${game.feed.split('/')[0].toLowerCase()}`}>
        {game.feed}
      </span>
      <span className="dash-col">
        <span className="eyebrow">buy-in</span>
        <span className="mono">{fmt(game.buyIn)} USDC</span>
      </span>
      <span className="dash-col">
        <span className="eyebrow">pot</span>
        <span className="mono dash-pot">{fmt(game.potSize)} USDC</span>
      </span>
      <span className="dash-col">
        <span className="eyebrow">watching</span>
        <span className="mono">{game.spectators}</span>
      </span>
      <span className="dash-col">
        <span className="eyebrow">live</span>
        <span className="mono">{liveFor(game.startedAt)}</span>
      </span>
      <span className="dash-join">Watch →</span>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function Dashboard() {
  const activeGames = useGameStore((s) => s.activeGames)
  const upcomingGames = useGameStore((s) => s.upcomingGames)
  const status = useGameStore((s) => s.discoveryStatus)
  const sort = useGameStore((s) => s.dashboardSort)
  const setSort = useGameStore((s) => s.setDashboardSort)
  const enterTable = useGameStore((s) => s.enterTable)
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)
  const joinGame = useGameStore((s) => s.joinGame)
  const createGame = useGameStore((s) => s.createGame)
  const playError = useGameStore((s) => s.playError)
  const balance = useGameStore((s) => s.chipBalance)

  const { connected, connecting } = useWallet()
  const { setVisible } = useWalletModal()

  const sortedActive = useMemo(() => sortGames(activeGames, sort), [activeGames, sort])

  const handleJoin = (matchId: string) => {
    if (!connected) { setVisible(true); return }
    void joinGame(matchId)
  }

  const handleWatch = (matchId: string) => {
    if (!connected) { setVisible(true); return }
    void enterTable(matchId)
  }

  const handleCreate = () => {
    if (!connected) { setVisible(true); return }
    void createGame()
  }

  return (
    <div className="dash">
      <div className="dash-panel">

        {/* ── Fixed header ── */}
        <header className="dash-head">
          <div>
            <div className="brand-mark">SATOSHI'S TABLE</div>
            <div className="eyebrow" style={{ marginTop: 3, opacity: 0.4 }}>a contest of conviction</div>
          </div>

          <div className="dash-head-right">
            {!connected && (
              <button
                className="dash-connect-btn"
                onClick={() => setVisible(true)}
                disabled={connecting}
                aria-label="Connect Solana wallet to play"
              >
                {connecting ? 'Connecting…' : '◎ Connect wallet'}
              </button>
            )}
          </div>
        </header>

        {/* ── Scrollable body ── */}
        <div className="dash-body">

          {playError && (
            <div className="dash-play-error eyebrow" style={{ marginTop: 16 }}>{playError}</div>
          )}

          {status === 'loading' && (
            <div className="dash-state">
              <div className="lobby-spinner" style={{ margin: '0 auto' }} />
              <span className="eyebrow" style={{ opacity: 0.5 }}>Loading tables…</span>
            </div>
          )}

          {status === 'error' && (
            <div className="dash-state dash-state--error">
              <span className="eyebrow">Server unreachable</span>
              <span className="eyebrow" style={{ opacity: 0.45 }}>Check your connection and hit Refresh.</span>
            </div>
          )}

          {/* ── Upcoming games — joinable ── */}
          {status === 'ready' && (
            <section className="dash-section">
              <div className="dash-section-head">
                <span className="dash-section-dot" />
                <span className="dash-section-label">Joinable</span>
                <span className="dash-section-sub">tables still filling seats</span>
              </div>

              {upcomingGames.length === 0 ? (
                <div className="dash-empty eyebrow">No open tables right now</div>
              ) : (
                <ul className="dash-list">
                  {upcomingGames.map((g) => (
                    <UpcomingRow key={g.matchId} game={g} onJoin={() => handleJoin(g.matchId)} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── Active games — watchable ── */}
          {status === 'ready' && (
            <section className="dash-section">
              <div className="dash-section-head">
                <span className="dash-section-dot" />
                <span className="dash-section-label">Live</span>
                <span className="dash-section-sub">games in progress</span>
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

              {sortedActive.length === 0 ? (
                <div className="dash-empty eyebrow">No live games right now</div>
              ) : (
                <ul className="dash-list">
                  {sortedActive.map((g) => (
                    <ActiveRow key={g.matchId} game={g} onWatch={() => handleWatch(g.matchId)} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── Create a new game ── */}
          {status === 'ready' && (
            <section className="dash-section dash-section--create">
              <div>
                <div className="dash-create-title">Start a table</div>
                <div className="eyebrow" style={{ opacity: 0.45 }}>
                  Be first in — others can join before it goes live
                </div>
              </div>
              <button className="play-now-btn" onClick={handleCreate}>
                + New game
              </button>
            </section>
          )}

        </div>

        {/* ── Fixed footer ── */}
        <footer className="dash-foot">
          <div className="dash-foot-wallet">
            {connected ? (
              <>
                <span className="eyebrow" style={{ opacity: 0.45 }}>devnet · connected</span>
                <span className="mono">{balance != null ? `${(balance / 1e6).toFixed(2)} USDC` : '—'}</span>
              </>
            ) : (
              <span className="eyebrow" style={{ opacity: 0.4 }}>connect a wallet to play</span>
            )}
          </div>
          <button className="dash-refresh" onClick={() => void loadDiscovery()}>
            Refresh
          </button>
        </footer>

      </div>
    </div>
  )
}
