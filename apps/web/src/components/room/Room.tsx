import { useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useGameStore } from '@/store/gameStore'
import { networkInfo } from '@/lib/network'
import { NetworkPill, updatedAgo } from './bits'
import { WalletMenu } from '@/components/hud/WalletMenu'
import { InviteBanner } from './InviteBanner'
import { MyClaimableWinnings, MyReclaimableMatches } from './AttentionSections'
import { LiveNow } from './LiveNow'
import { PlayNow } from './PlayNow'
import { PastHands } from './PastHands'
import { ProfilePanel, LeaderboardPanel, HowPanel } from './Rail'
import { JoinSheet } from './JoinSheet'
import { CreateSheet } from './CreateSheet'
import { useNow } from '@/lib/useNow'
import './room.css'

const NAV = [
  { id: 'live', label: 'Live now' },
  { id: 'play', label: 'Play now' },
  { id: 'past', label: 'Past hands' },
  { id: 'board', label: 'The board' },
]

function StatStrip() {
  const activeGames = useGameStore((s) => s.activeGames)
  const upcomingGames = useGameStore((s) => s.upcomingGames)
  const historyGames = useGameStore((s) => s.historyGames)

  const stats = useMemo(() => {
    const tablesLive = activeGames.length
    const onFelt = activeGames.reduce((sum, g) => sum + g.potSize, 0n)
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    const tonightPots = historyGames.filter((h) => h.endedAt >= midnight.getTime()).map((h) => h.finalPot ?? 0n)
    const livePots = activeGames.map((g) => g.potSize)
    const biggest = [...tonightPots, ...livePots].reduce((max, p) => (p > max ? p : max), 0n)
    const seated = activeGames.reduce((sum, g) => sum + (g.seated ?? 0), 0) + upcomingGames.reduce((sum, g) => sum + g.seated, 0)
    return { tablesLive, onFelt, biggest, seated }
  }, [activeGames, upcomingGames, historyGames])

  const fmt = (base: bigint) => (Number(base) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div className="statstrip">
      <div className="stat stat--live"><b>{stats.tablesLive}</b><span className="eyebrow">tables live</span></div>
      <div className="stat"><b>{fmt(stats.onFelt)}<em>USDC</em></b><span className="eyebrow">on the felt</span></div>
      <div className="stat"><b>{fmt(stats.biggest)}<em>USDC</em></b><span className="eyebrow">biggest pot tonight</span></div>
      <div className="stat"><b>{stats.seated}</b><span className="eyebrow">traders seated</span></div>
    </div>
  )
}

// Only the main-column sections are observed — the sticky rail ("board") is
// visible at every scroll position, so spying it would keep it permanently
// active. Like the prototype, #board only highlights when clicked, until the
// next observed section scrolls into the trigger band.
const SPY_IDS = ['live', 'play', 'past']

function useSectionSpy(ids: string[]): [string, (id: string) => void] {
  const [active, setActive] = useState(ids[0])
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e)
    // Observer callbacks only carry entries whose state CHANGED — data loads reflow
    // the page and can fire a lone entry for a lower section while an upper one is
    // still inside the band. Track every section's state and always pick the topmost
    // currently-intersecting one.
    const state = new Map<string, { intersecting: boolean; top: number }>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) state.set(e.target.id, { intersecting: e.isIntersecting, top: e.boundingClientRect.top })
        const inBand = [...state.entries()].filter(([, s]) => s.intersecting)
        if (inBand.length === 0) return
        inBand.sort((a, b) => a[1].top - b[1].top)
        setActive(inBand[0][0])
      },
      { rootMargin: '-25% 0px -60% 0px' },
    )
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [ids])
  return [active, setActive]
}

function RoomNav() {
  const activeGames = useGameStore((s) => s.activeGames)
  const upcomingGames = useGameStore((s) => s.upcomingGames)
  const discoveryUpdatedAt = useGameStore((s) => s.discoveryUpdatedAt)
  const now = useNow(1000)
  const [active, setActive] = useSectionSpy(SPY_IDS)

  const counts: Record<string, number | null> = {
    live: activeGames.length,
    play: upcomingGames.length,
    past: null,
    board: null,
  }

  return (
    <nav className="roomnav" aria-label="Room sections">
      {NAV.map((n) => (
        <a
          key={n.id}
          href={`#${n.id}`}
          className={`roomnav-link ${active === n.id ? 'on' : ''}`}
          onClick={() => setActive(n.id)}
        >
          {n.label}{counts[n.id] != null && <span className="mono">{counts[n.id]}</span>}
        </a>
      ))}
      <span className="roomnav-status eyebrow">
        <span className="livedot" />live · updated {updatedAgo(discoveryUpdatedAt, now)}
      </span>
    </nav>
  )
}

export function Room() {
  const pendingInvite = useGameStore((s) => s.pendingInvite)
  const inviteFrom = useGameStore((s) => s.inviteFrom)
  const dismissInvite = useGameStore((s) => s.dismissInvite)
  const playError = useGameStore((s) => s.playError)
  const walletError = useGameStore((s) => s.walletError)
  const roomModal = useGameStore((s) => s.roomModal)
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)
  const loadHistory = useGameStore((s) => s.loadHistory)
  const loadLeaderboard = useGameStore((s) => s.loadLeaderboard)
  const joinGame = useGameStore((s) => s.joinGame)
  const createGame = useGameStore((s) => s.createGame)

  const { connected } = useWallet()
  const net = useMemo(() => networkInfo(), [])
  const firstLoad = useRef(false)

  // 8s discovery poll (live/open tables), same cadence as the old Dashboard.
  useEffect(() => {
    const poll = () => { if (document.visibilityState === 'visible') void loadDiscovery({ silent: true }) }
    const id = setInterval(poll, 8000)
    document.addEventListener('visibilitychange', poll)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', poll) }
  }, [loadDiscovery])

  // Settled hands + leaderboard change slowly — 60s cadence, plus once on mount
  // (the Room remounts whenever the view flips table → discovery).
  useEffect(() => {
    if (firstLoad.current) return
    firstLoad.current = true
    void loadHistory()
    void loadLeaderboard()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') { void loadHistory(); void loadLeaderboard() }
    }, 60_000)
    return () => clearInterval(id)
  }, [loadHistory, loadLeaderboard])

  // (A "wrong network — your wallet is on Mainnet" banner used to live here. It compared the
  // APP's own RPC genesis hash to devnet's, which says nothing about the wallet: it fired on
  // every non-devnet build — localnet, and it would have on mainnet for every player. A
  // wallet on the wrong cluster surfaces where it actually matters, as a failed deposit
  // simulation with its own message.)

  const handleJoin = (matchId: string) => void joinGame(matchId)
  const handleCreate = () => void createGame()

  return (
    <div className="room-page">
      <header className="chrome">
        <a className="chrome-left" href="#live" aria-label="Satoshi's Table — home" style={{ textDecoration: 'none' }}>
          <span className="chrome-word">SATOSHI'S TABLE</span>
          <span className="chrome-tag">a contest of conviction</span>
        </a>
        <div className="chrome-right">
          <NetworkPill net={net} />
          <WalletMenu />
        </div>
      </header>

      <RoomNav />
      <StatStrip />

      <div className="room">
        <main>
          {(pendingInvite || playError || walletError) && (
            <div className="room-notices">
              {pendingInvite && (
                <InviteBanner
                  matchId={pendingInvite}
                  inviter={inviteFrom}
                  connected={connected}
                  onTakeSeat={handleJoin}
                  onDeal={handleCreate}
                  onDismiss={dismissInvite}
                />
              )}
              {walletError && (
                <div className="dash-network-warn">
                  <span className="dash-network-warn-icon">⚠</span>
                  <div>
                    <strong>Wallet connection failed</strong>
                    <span> — {walletError}</span>
                  </div>
                </div>
              )}
              {playError && !roomModal && <div className="dash-play-error eyebrow">{playError}</div>}
            </div>
          )}

          <MyClaimableWinnings />
          <MyReclaimableMatches />

          <LiveNow />
          <PlayNow />
          <PastHands />
        </main>

        <aside className="rail">
          <ProfilePanel />
          <LeaderboardPanel />
          <HowPanel />
        </aside>
      </div>

      <footer className="room-foot">
        <span>© 2026 Satoshi Table</span><span className="sep">·</span>
        <span>Please play responsibly</span><span className="sep">·</span>
        <span>18+</span>
      </footer>

      {roomModal?.kind === 'join' && <JoinSheet matchId={roomModal.matchId} />}
      {roomModal?.kind === 'create' && <CreateSheet />}
    </div>
  )
}
