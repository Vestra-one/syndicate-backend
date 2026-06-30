import { useMemo, useEffect, useState, useCallback, useRef } from 'react'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
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
    case 'potSize': return g.sort((a, b) => b.potSize - a.potSize)
    case 'buyIn':   return g.sort((a, b) => b.buyIn - a.buyIn)
    case 'feed':    return g.sort((a, b) => a.feed.localeCompare(b.feed) || b.potSize - a.potSize)
    case 'gameTime': default: return g.sort((a, b) => ratedScore(b) - ratedScore(a))
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
// WalletButton — top-right wallet chip with dropdown
// ---------------------------------------------------------------------------

function WalletButton({
  usdcBalance,
  solBalance,
  onRefreshBalance,
}: {
  usdcBalance: number | null
  solBalance: number | null
  onRefreshBalance: () => Promise<void>
}) {
  const { connected, connecting, disconnect, publicKey } = useWallet()
  const { setVisible } = useWalletModal()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [balRefreshing, setBalRefreshing] = useState(false)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const addr = publicKey?.toBase58() ?? ''
  const short = addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : ''

  const copyAddr = () => {
    void navigator.clipboard.writeText(addr)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const handleRefreshBalance = async () => {
    setBalRefreshing(true)
    try { await onRefreshBalance() } finally { setBalRefreshing(false) }
  }

  if (!connected) {
    return (
      <button className="wc-btn" onClick={() => setVisible(true)} disabled={connecting}>
        {connecting ? <><span className="wc-spinner" /> Connecting…</> : <>◎ Connect Wallet</>}
      </button>
    )
  }

  const usdcFmt = usdcBalance != null ? (usdcBalance / 1e6).toFixed(2) : '—'
  const solFmt  = solBalance  != null ? solBalance.toFixed(4) : '—'

  return (
    <div className="wc-wrap" ref={ref}>
      {/* chip */}
      <button
        className="wc-chip"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="wc-dot" />
        <span className="wc-chip-bal">{usdcFmt} USDC</span>
        <span className="wc-chip-rule" />
        <span className="wc-chip-addr">{short}</span>
        <span className="wc-chevron">▾</span>
      </button>

      {/* dropdown */}
      {open && (
        <div className="wc-dropdown">

          {/* address + copy */}
          <div className="wc-addr-row">
            <div className="wc-addr-info">
              <span className="wc-addr-network">Solana · Devnet</span>
              <span className="wc-addr-text">{short}</span>
            </div>
            <button
              className={`wc-copy-btn ${copied ? 'wc-copy-btn--done' : ''}`}
              onClick={copyAddr}
              title="Copy address"
            >
              {copied ? '✓' : '⧉'}
            </button>
          </div>

          {/* balances */}
          <div className="wc-balances">
            <div className="wc-balances-head">
              <span className="wc-addr-network">Balance</span>
              <button
                className={`wc-bal-refresh ${balRefreshing ? 'wc-bal-refresh--spinning' : ''}`}
                onClick={() => { void handleRefreshBalance() }}
                title="Refresh balance"
                disabled={balRefreshing}
              >↻</button>
            </div>
            <div className="wc-token-row">
              <span className="wc-token-stripe wc-token-stripe--usdc" />
              <div className="wc-token-info">
                <span className="wc-token-symbol">USDC</span>
                <span className="wc-token-amount wc-token-amount--usdc">{usdcFmt}</span>
              </div>
            </div>
            <div className="wc-token-row">
              <span className="wc-token-stripe wc-token-stripe--sol" />
              <div className="wc-token-info">
                <span className="wc-token-symbol">SOL</span>
                <span className="wc-token-amount wc-token-amount--sol">{solFmt}</span>
              </div>
            </div>
          </div>

          {/* faucets — devnet only */}
          <div className="wc-faucets">
            <div className="wc-faucet-label">Get testnet tokens</div>
            <div className="wc-faucet-links">
              <a
                className="wc-faucet-link"
                href="https://faucet.solana.com/"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
              >
                <span className="wc-faucet-stripe wc-faucet-stripe--sol" />
                SOL
                <span className="wc-faucet-arrow">↗</span>
              </a>
              <a
                className="wc-faucet-link"
                href="https://faucet.circle.com/"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
              >
                <span className="wc-faucet-stripe wc-faucet-stripe--usdc" />
                USDC
                <span className="wc-faucet-arrow">↗</span>
              </a>
            </div>
          </div>

          {/* disconnect */}
          <div className="wc-disconnect">
            <button
              className="wc-disconnect-btn"
              onClick={() => { setOpen(false); void disconnect() }}
            >
              Disconnect
            </button>
          </div>

        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row sub-components
// ---------------------------------------------------------------------------

function UpcomingRow({ game, onJoin, index }: { game: UpcomingGame; onJoin: () => void; index: number }) {
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
          <span className="mono">{fillDeadlineLabel(game.fillDeadline)}</span>
        </span>
      ) : null}
      <span className="dash-join dash-join--upcoming">Join →</span>
    </li>
  )
}

function ActiveRow({ game, onWatch, index }: { game: LiveGame; onWatch: () => void; index: number }) {
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
  const usdcBalance   = useGameStore((s) => s.chipBalance)

  const { connected, publicKey } = useWallet()
  const { connection } = useConnection()
  const { setVisible } = useWalletModal()
  const [solBalance, setSolBalance] = useState<number | null>(null)
  const [wrongNetwork, setWrongNetwork] = useState(false)

  const refreshAll = useCallback(async () => {
    void fetchBalance()
    if (publicKey) {
      try {
        const lamports = await connection.getBalance(publicKey)
        setSolBalance(lamports / 1e9)
      } catch { /* ignore */ }
    }
  }, [fetchBalance, publicKey, connection])

  useEffect(() => {
    if (connected) void refreshAll()
  }, [connected, refreshAll])

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
        <WalletButton usdcBalance={usdcBalance} solBalance={solBalance} onRefreshBalance={refreshAll} />
      </div>

      <div className="dash-panel">

        {/* ── Header ── */}
        <header className="dash-head">
          <div>
            <div className="brand-mark">SATOSHI'S TABLE</div>
            <div className="eyebrow" style={{ marginTop: 3, opacity: 0.35 }}>a contest of conviction</div>
          </div>
        </header>

        {/* ── Scrollable body ── */}
        <div className="dash-body">

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
              <div className="dash-open-title">No games at the table</div>
              <p className="dash-open-sub">Be first in — start a table and others can join before it goes live.</p>
              <button className="play-now-btn dash-open-cta" onClick={handleCreate}>+ New game</button>
            </div>
          )}

          {!isEmpty && status === 'ready' && (
            <section className="dash-section">
              <div className="dash-section-head">
                <span className="dash-section-dot" />
                <span className="dash-section-label">Joinable</span>
                <span className="dash-section-sub">open, filling seats</span>
              </div>
              {upcomingGames.length === 0 ? (
                <div className="dash-empty eyebrow">No open tables right now</div>
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
                <span className="dash-section-sub">games in progress</span>
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
                <div className="dash-empty eyebrow">No live games right now</div>
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
                  Be first in — others can join before it goes live
                </div>
              </div>
              <button className="play-now-btn" onClick={handleCreate}>
                + New game
              </button>
            </section>
          )}

        </div>

        {/* ── Footer — just network + refresh ── */}
        <footer className="dash-foot">
          <span className="eyebrow" style={{ opacity: 0.3 }}>Solana · Devnet</span>
          <button className="dash-refresh" onClick={() => { void loadDiscovery(); void refreshAll() }}>
            Refresh
          </button>
        </footer>

      </div>
    </div>
  )
}
