import { useMemo, useEffect, useState } from 'react'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'
import { ratedScore } from '@/lib/discovery'
import { createAdapters } from '@/lib/adapters'
import type { DashboardSortKey, LiveGame, UpcomingGame } from '@/lib/protocol'
import { ReclaimCard } from './ReclaimCard'
import { WalletMenu } from './WalletMenu'
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
    case 'potSize': return g.sort((a, b) => b.potSize - a.potSize)
    case 'buyIn':   return g.sort((a, b) => b.buyIn - a.buyIn)
    case 'feed':    return g.sort((a, b) => a.feed.localeCompare(b.feed) || b.potSize - a.potSize)
    case 'gameTime': default: return g.sort((a, b) => ratedScore(b) - ratedScore(a))
  }
}

/** Re-render on an interval so relative-time labels (countdowns, elapsed) stay live. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function liveFor(startedAt: number, now: number): string {
  const m = Math.max(0, Math.round((now - startedAt) / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function fillDeadlineLabel(ts: number | undefined, now: number): string {
  if (!ts) return '—'
  const secs = Math.round((ts - now) / 1000)
  if (secs <= 0) return 'closing…'
  if (secs < 60) return `${secs}s left`
  return `${Math.round(secs / 60)}m left`
}

function fmt(amount: number) {
  return (amount / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// ---------------------------------------------------------------------------
// Row sub-components
// ---------------------------------------------------------------------------

function UpcomingRow({ game, onJoin, index }: { game: UpcomingGame; onJoin: () => void; index: number }) {
  const now = useNow(1000)
  const pct = game.maxPlayers > 0 ? (game.seated / game.maxPlayers) * 100 : 0
  return (
    <li className="dash-row dash-row--upcoming" onClick={onJoin} style={{ '--i': index } as React.CSSProperties}>
      <span className={`dash-feed feed-${game.feed.split('/')[0].toLowerCase()}`}>{game.feed}</span>
      <span className="dash-col">
        <span className="eyebrow">buy-in</span>
        <span className="mono">{fmt(game.buyIn)} USDC</span>
      </span>
      <span className="dash-col">
        <span className="eyebrow">seats</span>
        <span className="mono">{game.seated}/{game.maxPlayers}</span>
        <span className="dash-seats-bar"><span className="dash-seats-fill" style={{ width: `${pct}%` }} /></span>
      </span>
      {game.fillDeadline ? (
        <span className="dash-col">
          <span className="eyebrow">closes</span>
          <span className="mono">{fillDeadlineLabel(game.fillDeadline, now)}</span>
        </span>
      ) : null}
      <span className="dash-join dash-join--upcoming">Join →</span>
    </li>
  )
}

function ActiveRow({ game, onWatch, index }: { game: LiveGame; onWatch: () => void; index: number }) {
  const now = useNow(15_000)
  return (
    <li className="dash-row" onClick={onWatch} style={{ '--i': index } as React.CSSProperties}>
      <span className={`dash-feed feed-${game.feed.split('/')[0].toLowerCase()}`}>{game.feed}</span>
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
        <span className="eyebrow">live for</span>
        <span className="mono">{liveFor(game.startedAt, now)}</span>
      </span>
      <span className="dash-join">Watch →</span>
    </li>
  )
}

// ---------------------------------------------------------------------------
// My matches — stuck rooms this wallet can cancel & reclaim funds from.
// Scanned directly on-chain (seat accounts owned by the connected wallet); no backend needed.
// ---------------------------------------------------------------------------

function MyReclaimableMatches() {
  const chain = useMemo(() => createAdapters().chain, [])
  const { connected } = useWallet()
  const [ids, setIds] = useState<string[]>([])

  useEffect(() => {
    if (!connected) { setIds([]); return }
    let alive = true
    chain.listReclaimableMatches()
      .then((matches) => { if (alive) setIds(matches.map((m) => m.onchainMatchId)) })
      .catch(() => { /* best-effort — an RPC hiccup shouldn't break the dashboard */ })
    return () => { alive = false }
  }, [connected, chain])

  if (ids.length === 0) return null

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <span className="dash-section-dot dash-section-dot--live" />
        <span className="dash-section-label">Needs your attention</span>
        <span className="dash-section-sub">stuck rooms — cancel &amp; reclaim your funds</span>
      </div>
      <div className="dash-reclaim-list">
        {ids.map((id) => <ReclaimCard key={id} onchainMatchId={id} />)}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function Dashboard() {
  const activeGames   = useGameStore((s) => s.activeGames)
  const upcomingGames = useGameStore((s) => s.upcomingGames)
  const status        = useGameStore((s) => s.discoveryStatus)
  const sort          = useGameStore((s) => s.dashboardSort)
  const setSort       = useGameStore((s) => s.setDashboardSort)
  const enterTable    = useGameStore((s) => s.enterTable)
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)
  const fetchBalance  = useGameStore((s) => s.fetchBalance)
  const joinGame      = useGameStore((s) => s.joinGame)
  const createGame    = useGameStore((s) => s.createGame)
  const playError     = useGameStore((s) => s.playError)
  const pendingInvite = useGameStore((s) => s.pendingInvite)
  const dismissInvite = useGameStore((s) => s.dismissInvite)

  const { connected } = useWallet()
  const { connection } = useConnection()
  const { setVisible } = useWalletModal()
  const [wrongNetwork, setWrongNetwork] = useState(false)

  // Detect mainnet wallet connected to a devnet app via genesis hash.
  // Devnet genesis: EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
  useEffect(() => {
    if (!connected) { setWrongNetwork(false); return }
    connection.getGenesisHash().then((hash) => {
      setWrongNetwork(hash !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
    }).catch(() => { /* ignore */ })
  }, [connected, connection])

  const sortedActive = useMemo(() => sortGames(activeGames, sort), [activeGames, sort])
  const isEmpty = status === 'ready' && upcomingGames.length === 0 && sortedActive.length === 0

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

      {/* ── Wallet button — fixed top-right of the page ── */}
      <div className="dash-wallet-anchor">
        <WalletMenu />
      </div>

      <div className="dash-panel">

        {/* ── Header ── */}
        <header className="dash-head">
          <div>
            <div className="brand-mark">SATOSHI'S TABLE</div>
            <div className="dash-tagline">a contest of conviction</div>
          </div>
        </header>

        {/* ── Scrollable body ── */}
        <div className="dash-body">

          {pendingInvite && (
            <div className="dash-invite">
              <div className="dash-invite-glyph" aria-hidden="true">♠</div>
              <div className="dash-invite-body">
                <div className="eyebrow">you've been invited</div>
                <div className="dash-invite-title">Join this table</div>
                <div className="dash-invite-sub">Someone shared a Satoshi's Table hand with you.</div>
              </div>
              <div className="dash-invite-actions">
                <button className="play-now-btn" onClick={() => handleJoin(pendingInvite)}>
                  {connected ? 'Join table' : 'Connect & join'}
                </button>
                <button className="dash-invite-dismiss" onClick={dismissInvite}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {wrongNetwork && (
            <div className="dash-network-warn">
              <span className="dash-network-warn-icon">⚠</span>
              <div>
                <strong>Wrong network</strong>
                <span> — your wallet is on Mainnet. Switch to </span>
                <strong>Solana Devnet</strong>
                <span> in your wallet settings before depositing.</span>
              </div>
            </div>
          )}

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

          {isEmpty && (
            <div className="dash-open-state">
              <div className="dash-open-icon">◎</div>
              <div className="dash-open-title">No games yet</div>
              <p className="dash-open-sub">Deal the first table.</p>
              <button className="play-now-btn dash-open-cta" onClick={handleCreate}>Deal a table</button>
            </div>
          )}

          {status === 'ready' && <MyReclaimableMatches />}

          {!isEmpty && status === 'ready' && (
            <section className="dash-section">
              <div className="dash-section-head">
                <span className="dash-section-dot" />
                <span className="dash-section-label">Open</span>
                <span className="dash-section-sub">filling now</span>
              </div>
              {upcomingGames.length === 0 ? (
                <div className="dash-empty eyebrow">No open tables</div>
              ) : (
                <ul className="dash-list">
                  {upcomingGames.map((g, i) => (
                    <UpcomingRow key={g.matchId} game={g} onJoin={() => handleJoin(g.matchId)} index={i} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {!isEmpty && status === 'ready' && (
            <section className="dash-section">
              <div className="dash-section-head">
                <span className="dash-section-dot dash-section-dot--live" />
                <span className="dash-section-label">Live</span>
                <span className="dash-section-sub">in progress</span>
                {sortedActive.length > 0 && (
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
                )}
              </div>
              {sortedActive.length === 0 ? (
                <div className="dash-empty eyebrow">No live hands</div>
              ) : (
                <ul className="dash-list">
                  {sortedActive.map((g, i) => (
                    <ActiveRow key={g.matchId} game={g} onWatch={() => handleWatch(g.matchId)} index={i} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {!isEmpty && status === 'ready' && (
            <section className="dash-section dash-section--create">
              <div>
                <div className="dash-create-title">Start a table</div>
                <div className="eyebrow" style={{ opacity: 0.45 }}>
                  Be first in — others join before it goes live
                </div>
              </div>
              <button className="play-now-btn" onClick={handleCreate}>
                Deal a table
              </button>
            </section>
          )}

        </div>

        {/* ── Footer — just network + refresh ── */}
        <footer className="dash-foot">
          <span className="eyebrow" style={{ opacity: 0.3 }}>Solana · Devnet</span>
          <button className="dash-refresh" onClick={() => { void loadDiscovery(); void fetchBalance() }}>
            Refresh
          </button>
        </footer>

      </div>
    </div>
  )
}
