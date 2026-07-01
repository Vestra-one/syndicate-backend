import { useEffect } from 'react'
import { TableCanvas } from '@/components/table/TableCanvas'
import { Dashboard } from '@/components/hud/Dashboard'
import { Hud } from '@/components/hud/Hud'
import { useGameStore } from '@/store/gameStore'
import { startPriceFeed } from '@/lib/realtime/priceFeed'
import { consumeInviteParam } from '@/lib/invite'

/**
 * Root view router.
 *
 * discovery — the live-games lobby (Dashboard) over the 3D table backdrop.
 * table     — the active match: the 3D table + the 2D HUD overlay.
 *
 * The 3D canvas is always mounted (keeps the GPU warm; table persists across
 * the discovery → game transition so the camera swoop into the match feels
 * seamless).  The pot value drives the coin pile in the Three.js scene.
 */
export default function App() {
  const view = useGameStore((s) => s.view)
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)

  // Kick off the discovery feed on first mount
  useEffect(() => {
    void loadDiscovery()
  }, [loadDiscovery])

  // A ?table=<id> invite deep-link → stash it; the Dashboard surfaces an accept
  // prompt (needs a user gesture to open the wallet, so we never auto-join on load).
  useEffect(() => {
    const id = consumeInviteParam()
    if (id) useGameStore.setState({ pendingInvite: id })
  }, [])

  // Stream live BTC/USD ticks into the cabinet chart (keeps it alive pre-match).
  useEffect(() => {
    const feed = startPriceFeed('BTCUSD', useGameStore.getState().ingestLivePrice)
    return () => feed.stop()
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
        chipBalance: 42_000_000,
        walletAddress: 'H9Qoft4c9k2rXexampleWaitingRoomDevMock98of',
        fillDeadline: Date.now() + secs * 1000,
        terms: {
          tableId: 'sat-btc-lo', priceFeedId: 'BTC/USD', supportedFeeds: ['BTC/USD'],
          chipsToken: 'USDC', decimals: 2, oracleAdapter: 'signed-price',
          settlementMode: 'exact-timestamp', oracleUnavailableMessage: '',
          buyIn: 10_000_000, entryFee: 500_000, rakeBps: 250, rakeCap: 1_000_000,
          smallBlind: 5_000, bigBlind: 10_000, minPlayers: min, maxPlayers: max,
          roundCount: 4, roundDurationsSec: [30, 30, 30, 30], actionTimerSec: 20,
          timeBankSec: 30, settlementWindowSec: 20, geofenceBlocklist: [],
          allowDuplicateWalletPerMatch: false, fillWindowSec: secs, timelockTargetRound: 0,
          onchainMatchId: '77',
        },
        match: {
          matchId: 'mock', phase: 'FILLING', round: 0, pot: 0, currentBet: 0,
          buttonSeat: 0, toActSeat: null, feedPrice: 5862200, yourSeat: 0,
          yourStack: 10_000_000, yourExposure: 0,
          seats: Array.from({ length: filled }, (_, i) => ({
            seat: i, stack: 10_000_000, committedThisStreet: 0, totalContribution: 0,
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
      const ETH = (n: number) => Math.round(n * 1e6)
      const ev = (seat: number, action: string, amount: number) => ({
        kind: 'action' as const, matchId: 'mock', seat, action, amount, feedPrice: 184520, pot: ETH(18.75), ts: Date.now(),
      })
      useGameStore.setState({
        view: 'table', status: 'live', seated: true,
        chipBalance: 42_000_000,
        walletAddress: 'H9Qoft4c9k2rXexampleLiveTablePodsDevMock98of',
        fillDeadline: null,
        yourTurn: actingSeat === 0 ? { toCall: ETH(0.75), minRaiseTo: ETH(1.25), deadline: Date.now() + 12_000 } : null,
        feed: [
          ev(5, 'fold', 0),
          ev(4, 'fold', 0),
          ev(3, 'call', ETH(0.75)),
          ev(1, 'call', ETH(0.75)),
          ev(2, 'raiseTo', ETH(0.75)),
        ],
        terms: {
          tableId: 'sat-eth', priceFeedId: 'ETH/USD', supportedFeeds: ['ETH/USD'],
          chipsToken: 'ETH', decimals: 2, oracleAdapter: 'signed-price',
          settlementMode: 'exact-timestamp', oracleUnavailableMessage: '',
          buyIn: ETH(2), entryFee: 0, rakeBps: 250, rakeCap: ETH(1),
          smallBlind: ETH(0.25), bigBlind: ETH(0.5), minPlayers: 2, maxPlayers: 6,
          roundCount: 4, roundDurationsSec: [30, 30, 30, 30], actionTimerSec: 20,
          timeBankSec: 30, settlementWindowSec: 20, geofenceBlocklist: [],
          allowDuplicateWalletPerMatch: false, fillWindowSec: 60, timelockTargetRound: 0,
          onchainMatchId: '77',
        },
        match: {
          matchId: 'mock', phase: 'LIVE', round: 24, pot: ETH(18.75), currentBet: ETH(0.75),
          buttonSeat: 1, toActSeat: actingSeat, feedPrice: 184520, yourSeat: 0,
          yourStack: ETH(2.35), yourExposure: 0,
          seats: [
            { seat: 0, stack: ETH(2.35), committedThisStreet: 0, totalContribution: ETH(0.5), folded: false, allIn: false },
            { seat: 1, stack: ETH(2.80), committedThisStreet: ETH(0.75), totalContribution: ETH(0.75), folded: false, allIn: false },
            { seat: 2, stack: ETH(2.12), committedThisStreet: ETH(0.75), totalContribution: ETH(0.75), folded: false, allIn: false },
            { seat: 3, stack: ETH(1.85), committedThisStreet: ETH(0.75), totalContribution: ETH(0.75), folded: false, allIn: false },
            { seat: 4, stack: ETH(1.60), committedThisStreet: 0, totalContribution: ETH(0.25), folded: true, allIn: false },
            { seat: 5, stack: ETH(2.00), committedThisStreet: 0, totalContribution: 0, folded: true, allIn: false },
          ],
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
      {view === 'discovery' && <Dashboard />}
      {view === 'table' && <Hud />}
    </>
  )
}
