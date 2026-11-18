import { useEffect } from 'react'
import { TableCanvas } from '@/components/table/TableCanvas'
import { Room } from '@/components/room/Room'
import { Hud } from '@/components/hud/Hud'
import { TxCeremony } from '@/components/hud/TxCeremony'
import { ComingSoon } from '@/components/coming-soon/ComingSoon'
import { useGameStore } from '@/store/gameStore'
import { startPriceFeed } from '@/lib/realtime/priceFeed'
import { consumeInviteParam } from '@/lib/invite'

/**
 * Top-level host router.
 *
 * The full game runs on the `app.` subdomain (app.satoshitable.fun) and in local
 * dev. Every other host — the root domain satoshitable.fun — gets the coming-soon
 * landing painted over the 3D table backdrop.
 *
 * The same build serves both domains; the hostname decides. Override on any host
 * for previews with `?view=app` or `?view=soon`.
 */
export default function App() {
  return isAppHost() ? <Game /> : <Landing />
}

/** True on the app subdomain / local dev, or when forced via `?view=app`. */
function isAppHost(): boolean {
  const override = new URLSearchParams(window.location.search).get('view')
  if (override === 'app') return true
  if (override === 'soon') return false
  const h = window.location.hostname
  return h.startsWith('app.') || h === 'localhost' || h === '127.0.0.1'
}

/**
 * Coming-soon landing: the 3D table renders as a decorative showpiece (fixed pot,
 * no backend feeds) behind the launch overlay.
 */
function Landing() {
  return (
    <>
      <TableCanvas pot={2400} spin />
      <div className="scene-vignette" />
      <ComingSoon />
    </>
  )
}

/**
 * The live game.
 *
 * discovery — the live-games lobby (Dashboard) over the 3D table backdrop.
 * table     — the active match: the 3D table + the 2D HUD overlay.
 *
 * The 3D canvas is always mounted (keeps the GPU warm; table persists across
 * the discovery → game transition so the camera swoop into the match feels
 * seamless).  The pot value drives the coin pile in the Three.js scene.
 */
function Game() {
  const view = useGameStore((s) => s.view)
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)

  // Kick off the discovery feed on first mount
  useEffect(() => {
    void loadDiscovery()
  }, [loadDiscovery])

  // A ?table=<id> invite deep-link → stash it; the Dashboard surfaces an accept
  // prompt (needs a user gesture to open the wallet, so we never auto-join on load).
  useEffect(() => {
    const inv = consumeInviteParam()
    if (inv) useGameStore.setState({ pendingInvite: inv.matchId, inviteFrom: inv.inviter })
  }, [])

  // Stream live ticks for the market of the table in view (BTC/USD in the lobby). A table
  // on another market must show ITS price everywhere — and none of the last market's
  // history may leak into the chart, the seal box or the "typical move".
  const feedId = useGameStore((s) => s.terms?.priceFeedId ?? 'BTC/USD')
  useEffect(() => {
    useGameStore.setState({ priceHistory: [] })
    const feed = startPriceFeed(feedId.replace('/', '').toUpperCase(), useGameStore.getState().ingestLivePrice)
    return () => feed.stop()
  }, [feedId])

  // DEV-only: expose the store for headless/console iteration, e.g.
  //   window.__gameStore.setState({ priceHistory: [...] })
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __gameStore?: typeof useGameStore }).__gameStore = useGameStore
  }, [])

  // DEV-only: jump straight into the seated "table filling" waiting state so the
  // waiting-room UI can be iterated on headlessly without a funded wallet on-chain.
  //   window.__mockWaiting({ seated: 2, max: 5, min: 3, secs: 78 })
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __mockWaiting?: (o?: Record<string, number>) => void }).__mockWaiting = (o = {}) => {
      const filled = o.seated ?? 2
      const max = o.max ?? 5
      const min = o.min ?? 3
      const secs = o.secs ?? 78
      useGameStore.setState({
        view: 'table',
        status: 'live',
        seated: true,
        chipBalance: 42_000_000n,
        walletAddress: 'H9Qoft4c9k2rXexampleWaitingRoomDevMock98of',
        fillDeadline: Date.now() + secs * 1000,
        terms: {
          tableId: 'sat-btc-lo', priceFeedId: 'BTC/USD', supportedFeeds: ['BTC/USD'],
          chipsToken: 'USDC', decimals: 2, oracleAdapter: 'signed-price',
          settlementMode: 'exact-timestamp', oracleUnavailableMessage: '',
          buyIn: 10_000_000n, entryFee: 500_000n, rakeBps: 250, rakeCap: 1_000_000n,
          smallBlind: 5_000n, bigBlind: 10_000n, minPlayers: min, maxPlayers: max,
          roundCount: 4, roundDurationsSec: [30, 30, 30, 30], actionTimerSec: 20,
          timeBankSec: 30, settlementWindowSec: 20, geofenceBlocklist: [],
          allowDuplicateWalletPerMatch: false, fillWindowSec: secs, timelockTargetRound: 0,
          onchainMatchId: '77',
        },
        match: {
          matchId: 'mock', phase: 'FILLING', round: 0, pot: 0n, currentBet: 0n,
          buttonSeat: 0, toActSeat: null, feedPrice: 5862200, yourSeat: 0,
          yourStack: 10_000_000n, yourExposure: 0n,
          seats: Array.from({ length: filled }, (_, i) => ({
            seat: i, stack: 10_000_000n, committedThisStreet: 0n, totalContribution: 0n,
            folded: false, allIn: false,
          })),
        },
      })
    }
  }, [])

  // DEV-only: drop straight into a LIVE 6-handed match so the player pods
  // (portrait, status, stack, tag, live-turn ring) can be iterated headlessly.
  //   window.__mockLive()
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __mockLive?: (actingSeat?: number) => void }).__mockLive = (actingSeat = 0) => {
      const U = (n: number) => BigInt(Math.round(n * 1e6)) // USDC base units (6 dp) → Chips bigint
      const BTC = 6_251_400 // BTC/USD at the table's 2-dp fixed point (~$62,514)
      const ev = (seat: number, action: string, amount: bigint) => ({
        kind: 'action' as const, matchId: 'mock', seat, action, amount, feedPrice: BTC, pot: U(18.75), ts: Date.now(),
      })
      useGameStore.setState({
        view: 'table', status: 'live', seated: true,
        chipBalance: 42_000_000n,
        walletAddress: 'H9Qoft4c9k2rXexampleLiveTablePodsDevMock98of',
        fillDeadline: null,
        // yourTurn amounts are plain numbers (they mirror the wire your_turn frame).
        yourTurn: actingSeat === 0 ? { toCall: 750_000, minRaiseTo: 1_250_000, deadline: Date.now() + 12_000 } : null,
        feed: [
          ev(5, 'fold', 0n),
          ev(4, 'fold', 0n),
          ev(3, 'call', U(0.75)),
          ev(1, 'call', U(0.75)),
          ev(2, 'raiseTo', U(0.75)),
        ],
        terms: {
          tableId: 'sat-btc-lo', priceFeedId: 'BTC/USD', supportedFeeds: ['BTC/USD'],
          chipsToken: 'USDC', decimals: 2, oracleAdapter: 'signed-price',
          settlementMode: 'exact-timestamp', oracleUnavailableMessage: '',
          buyIn: U(10), entryFee: U(0.5), rakeBps: 250, rakeCap: U(1),
          smallBlind: U(0.05), bigBlind: U(0.1), minPlayers: 2, maxPlayers: 6,
          roundCount: 4, roundDurationsSec: [30, 30, 30, 30], actionTimerSec: 20,
          timeBankSec: 30, settlementWindowSec: 20, geofenceBlocklist: [],
          allowDuplicateWalletPerMatch: false, fillWindowSec: 60, timelockTargetRound: 0,
          onchainMatchId: '77',
        },
        match: {
          matchId: 'mock', phase: 'LIVE', round: 3, pot: U(18.75), currentBet: U(0.75),
          buttonSeat: 1, toActSeat: actingSeat, feedPrice: BTC, yourSeat: 0,
          yourStack: U(2.35), yourExposure: 0n,
          seats: [
            { seat: 0, stack: U(2.35), committedThisStreet: 0n, totalContribution: U(0.5), folded: false, allIn: false },
            { seat: 1, stack: U(2.80), committedThisStreet: U(0.75), totalContribution: U(0.75), folded: false, allIn: false },
            { seat: 2, stack: U(2.12), committedThisStreet: U(0.75), totalContribution: U(0.75), folded: false, allIn: false },
            { seat: 3, stack: U(1.85), committedThisStreet: U(0.75), totalContribution: U(0.75), folded: false, allIn: false },
            { seat: 4, stack: U(1.60), committedThisStreet: 0n, totalContribution: U(0.25), folded: true, allIn: false },
            { seat: 5, stack: U(2.00), committedThisStreet: 0n, totalContribution: 0n, folded: true, allIn: false },
          ],
        },
      })
    }
  }, [])

  // DEV-only: populate the Room page's Live/Play/Past sections + rail with
  // seeded data so the lobby can be iterated headlessly without a live backend.
  //   window.__mockRoom()
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __mockRoom?: () => void }).__mockRoom = () => {
      const U = (n: number) => BigInt(Math.round(n * 1e6))
      const now = Date.now()
      useGameStore.setState({
        view: 'discovery',
        discoveryStatus: 'ready',
        discoveryUpdatedAt: now,
        walletAddress: 'H9Qoft4c9k2rXexampleRoomMockWalletDevOnly98of',
        chipBalance: U(42),
        activeGames: [
          { matchId: 'live-1', feed: 'BTC/USD', buyIn: U(10), potSize: U(512.5), spectators: 87, actionsPerMin: 3, startedAt: now - 300_000, seated: 5, maxPlayers: 5, round: 3, roundCount: 4, creatorHandle: 'The Duchess' },
          { matchId: 'live-2', feed: 'ETH/USD', buyIn: U(5), potSize: U(86.5), spectators: 12, actionsPerMin: 1, startedAt: now - 180_000, seated: 4, maxPlayers: 5, round: 2, roundCount: 4 },
        ],
        upcomingGames: [
          { matchId: 'up-1', feed: 'BTC/USD', buyIn: U(10), entryFee: U(0.5), seated: 2, maxPlayers: 5, fillDeadline: now + 134_000, creatorHandle: 'The Duchess' },
          { matchId: 'up-2', feed: 'SOL/USD', buyIn: U(50), entryFee: U(1), seated: 1, maxPlayers: 6, fillDeadline: now + 812_000 },
        ],
        historyGames: [
          { matchId: 'past-1', feed: 'BTC/USD', buyIn: U(10), maxPlayers: 6, voidKind: null, finalPot: U(284), rake: U(2.84), settlementPriceWad: '63209500000000000000000', settlementTxSig: '5KxDevMockSolscanSigPlaceholder', endedAt: now - 720_000, winner: { wallet: '9aQrDevMockWinnerWalletPlaceholder1234mW4d', handle: 'The Chancellor', potWon: U(280) } },
        ],
        historyStatus: 'ready',
        leaderboard: {
          entries: [
            { rank: 1, wallet: '3xVmDevMockWalletPlaceholder1234abcdk2Fp', handle: 'Quiet Whale', matches: 12, wins: 7, net_chips: 512_500_000, best_pot: 512_500_000 },
            { rank: 2, wallet: '9aQrDevMockWinnerWalletPlaceholder1234mW4d', handle: 'The Chancellor', matches: 9, wins: 4, net_chips: 284_000_000, best_pot: 284_000_000 },
          ],
        },
        profile: {
          wallet: 'H9Qoft4c9k2rXexampleRoomMockWalletDevOnly98of',
          handle: 'Night Auditor',
          stats: { tablesPlayed: 12, potsWon: 4, netChips: U(86.5), bestPot: U(120) },
        },
      })
    }
  }, [])

  return (
    <>
      {/* Always-on 3D table: candlelit felt + price cabinet + pot heap. Live mode
          (no `pot` prop) → the coin pile follows the match pot from the store. */}
      <TableCanvas />
      <div className="scene-vignette" />

      {/* Surface switch — one panel at a time. The HUD layers players (Seats),
          the pot label, and the betting panel over the 3D table during a match. */}
      {view === 'discovery' && <Room />}
      {view === 'table' && <Hud />}

      {/* Mounted once, above both views — the join/create deposit ceremony now
          starts on the Room page (discovery) and can carry across the confirmed
          hand-off into the table view without remounting. */}
      <TxCeremony />
    </>
  )
}
