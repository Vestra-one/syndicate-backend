import { create } from 'zustand'
import type {
  BettingAction,
  DashboardSortKey,
  DefaultAction,
  FixedPrice,
  LiveGame,
  MatchStateView,
  PublicEvent,
  RoomListing,
  SettlementView,
  TableTerms,
  UpcomingGame,
  VoidReason,
} from '@/lib/protocol'
import { DRAND } from '@/lib/protocol'
import type { ConnectionStatus, PricePoint } from '@/lib/ui'
import { createAdapters, type Adapters } from '@/lib/adapters'
import { newOnchainMatchId } from '@/lib/adapters/live'
import { createGateway, type Gateway } from '@/lib/realtime/gateway'
import { fetchActiveGames, fetchUpcomingGames } from '@/lib/discovery'
import {
  pickTemplate,
  templateToCreateParams,
  templateToTerms,
  type ConfigTemplate,
} from '@/lib/config'
import { priceTokenFor } from '@/lib/price'
import { reportCreate, reportDeposit } from '@/lib/matchmaking'

/** Resolved Play Now action: join an existing open table, or create a new one. */
export type PlayMode = 'join' | 'create'

const MAX_HISTORY = 240 // ~2 min at 500ms snapshots — enough for the board chart
const MAX_FEED = 40 // recent public events kept for the action feed

/** One-way latch for the prediction (§6, seal-once). */
export type SealStatus = 'unsealed' | 'sealing' | 'sealed'

/** Which top-level surface the app is showing. */
export type AppView = 'discovery' | 'table'

/** Discovery feed load state — distinguishes "empty" from "still loading" from "failed". */
export type DiscoveryStatus = 'idle' | 'loading' | 'ready' | 'error'

interface GameState {
  view: AppView
  activeGames: LiveGame[]
  upcomingGames: UpcomingGame[]
  discoveryStatus: DiscoveryStatus
  dashboardSort: DashboardSortKey

  status: ConnectionStatus
  walletAddress: string | null
  chipBalance: number | null

  terms: TableTerms | null
  match: MatchStateView | null
  yourTurn: { toCall: number; minRaiseTo: number; deadline: number } | null

  // self-centric, derived from the feed
  sealStatus: SealStatus
  yourPrediction: FixedPrice | null // plaintext, client-only — never sent in the clear
  defaultAction: DefaultAction

  priceHistory: PricePoint[]
  feed: PublicEvent[]

  settlement: SettlementView | null
  voided: { reason: VoidReason } | null
  reviewing: boolean // resolution dismissed to inspect the final table
  seated: boolean // deposit confirmed → seat taken (gates the lobby)

  // Play Now matchmaking
  rooms: RoomListing[] // open tables discovered over the gateway lobby
  playResolving: boolean // true while deciding join-vs-create
  playMode: PlayMode | null // resolved action for the current lobby card
  playError: string | null // resolution / commit failure surfaced to the user
  lastTxSig: string | null // most recent on-chain tx signature (for explorer link)

  // actions
  fetchBalance: () => Promise<void>
  loadDiscovery: () => Promise<void>
  ingestLivePrice: (price: number, ts: number) => void
  setDashboardSort: (key: DashboardSortKey) => void
  enterTable: (matchId: string) => Promise<void>
  leaveToDiscovery: () => void
  connect: () => Promise<void>
  disconnect: () => void
  joinGame: (matchId: string) => Promise<void>
  createGame: () => Promise<void>
  joinTable: () => Promise<void>
  createTable: () => Promise<void>
  sealPrediction: (price: FixedPrice) => Promise<void>
  act: (action: BettingAction) => Promise<void>
  setDefault: (def: DefaultAction) => void
  claim: () => Promise<string | null>
  refund: () => Promise<string | null>
  setReviewing: (v: boolean) => void
  playAgain: () => Promise<void>
}

let adapters: Adapters | null = null
let gateway: Gateway | null = null
let unsub: (() => void) | null = null

/** The room we resolved to JOIN via Play Now (so joinTable knows the on-chain ids). */
let joinRoom: RoomListing | null = null
/** The template + derived ids we resolved to CREATE via Play Now. */
let createCtx: { tmpl: ConfigTemplate; priceTokenHex: string; onchainMatchId: string } | null = null

export const useGameStore = create<GameState>((set, get) => ({
  view: 'discovery',
  activeGames: [],
  upcomingGames: [],
  discoveryStatus: 'idle',
  dashboardSort: 'gameTime',

  status: 'offline',
  walletAddress: null,
  chipBalance: null,

  terms: null,
  match: null,
  yourTurn: null,

  sealStatus: 'unsealed',
  yourPrediction: null,
  defaultAction: 'check_fold',

  priceHistory: [],
  feed: [],

  settlement: null,
  voided: null,
  reviewing: false,
  seated: false,

  rooms: [],
  playResolving: false,
  playMode: null,
  playError: null,
  lastTxSig: null,

  fetchBalance: async () => {
    if (!adapters) adapters = createAdapters()
    await refreshBalance(set)
  },

  loadDiscovery: async () => {
    set({ discoveryStatus: 'loading' })
    const [activeResult, upcomingResult] = await Promise.allSettled([
      fetchActiveGames(),
      fetchUpcomingGames(),
    ])
    const active = activeResult.status === 'fulfilled' ? activeResult.value : []
    const upcoming = upcomingResult.status === 'fulfilled' ? upcomingResult.value : []
    if (activeResult.status === 'rejected') console.warn('active-games fetch failed:', activeResult.reason)
    if (upcomingResult.status === 'rejected') console.warn('upcoming-games fetch failed:', upcomingResult.reason)
    // Only show error if BOTH endpoints fail
    if (activeResult.status === 'rejected' && upcomingResult.status === 'rejected') {
      set({ activeGames: [], upcomingGames: [], discoveryStatus: 'error' })
    } else {
      set({ activeGames: active, upcomingGames: upcoming, discoveryStatus: 'ready' })
    }
  },

  /**
   * Push a spot tick from the always-on price feed into the chart history (§2).
   * During an active match the gateway's feedPrice is authoritative, so we only
   * feed the chart from spot ticks pre-match (no match, or still FILLING).
   */
  ingestLivePrice: (price, ts) => {
    const m = get().match
    if (m && m.phase !== 'FILLING') return
    set((s) => ({ priceHistory: [...s.priceHistory, { price, ts }].slice(-MAX_HISTORY) }))
  },

  setDashboardSort: (key) => set({ dashboardSort: key }),

  /** Pick a table from the dashboard → connect to it and show the table view. */
  enterTable: async (_matchId) => {
    set({ view: 'table' })
    await get().connect()
  },

  /** Leave the current table and return to the live-games dashboard. */
  leaveToDiscovery: () => {
    get().disconnect()
    set({ view: 'discovery' })
    void get().loadDiscovery()
  },

  /** Join an upcoming (FILLING) game by matchId — connect wallet + gateway, then show deposit Lobby. */
  joinGame: async (matchId: string) => {
    if (!adapters) adapters = createAdapters()
    joinRoom = null
    createCtx = null
    set({ playError: null })

    try {
      const addr = await adapters.wallet.connect()
      set({ walletAddress: addr })
    } catch {
      set({ playError: 'Wallet connection was cancelled.' })
      return
    }

    set({ view: 'table', status: 'connecting', playResolving: true, playMode: null, match: null, terms: null, seated: false })
    if (gateway) { unsub?.(); gateway.disconnect(); gateway = null; unsub = null }
    const gw = createGateway(adapters)
    gateway = gw
    unsub = gw.subscribe((msg) => handleServerMessage(msg, set, get))
    try {
      await gw.connect()
      set({ status: 'live' })
      void refreshBalance(set)
    } catch {
      set({ status: 'offline', playResolving: false, playError: 'Could not reach the table server.' })
      return
    }

    // Subscribe to match — server will push tableTerms so the Lobby card can show cost
    gw.send({ type: 'subscribe', matchId })
    joinRoom = { matchId, roomCode: '', feedId: '', tierId: '', seated: 0, minPlayers: 0, maxPlayers: 0, fillDeadline: 0 }
    set({ playMode: 'join', playResolving: false })
  },

  /** Create a new game — connect wallet + gateway, load config, then show create Lobby. */
  createGame: async () => {
    if (!adapters) adapters = createAdapters()
    joinRoom = null
    createCtx = null
    set({ playError: null })

    try {
      const addr = await adapters.wallet.connect()
      set({ walletAddress: addr })
    } catch {
      set({ playError: 'Wallet connection was cancelled.' })
      return
    }

    set({ view: 'table', status: 'connecting', playResolving: true, playMode: null, match: null, terms: null, seated: false })
    if (gateway) { unsub?.(); gateway.disconnect(); gateway = null; unsub = null }
    const gw = createGateway(adapters)
    gateway = gw
    unsub = gw.subscribe((msg) => handleServerMessage(msg, set, get))
    try {
      await gw.connect()
      set({ status: 'live' })
      void refreshBalance(set)
    } catch {
      set({ status: 'offline', playResolving: false, playError: 'Could not reach the table server.' })
      return
    }

    try {
      const tmpl = await pickTemplate('BTC/USD')
      const priceTokenHex = await priceTokenFor(tmpl.config.priceFeedId)
      const onchainMatchId = newOnchainMatchId()
      createCtx = { tmpl, priceTokenHex, onchainMatchId }
      set({ terms: { ...templateToTerms(tmpl), onchainMatchId }, playMode: 'create', playResolving: false })
    } catch {
      set({ playResolving: false, playMode: null, playError: 'Could not load table config.' })
    }
  },

  connect: async () => {
    if (gateway) return
    set({ status: 'connecting' })
    if (!adapters) adapters = createAdapters()
    // Capture the instance locally — `gateway` (module-global) can be reassigned
    // by a StrictMode unmount/remount across the awaits below; we must act on the
    // instance we created, never whatever global points at after the await.
    const gw = createGateway(adapters)
    gateway = gw

    unsub = gw.subscribe((msg) => handleServerMessage(msg, set, get))

    try {
      await adapters.wallet.connect()
      set({ walletAddress: adapters.wallet.address() })
      await gw.connect() // resolves once authenticated
      set({ status: 'live' })
      void refreshBalance(set)
    } catch (err) {
      // geo-blocked / bad signature / socket error (§9)
      console.error('gateway connect failed:', err)
      set({ status: 'offline' })
    }
  },

  disconnect: () => {
    unsub?.()
    gateway?.disconnect()
    gateway = null
    unsub = null
    adapters = null
    joinRoom = null
    createCtx = null
    set({
      status: 'offline',
      match: null,
      yourTurn: null,
      sealStatus: 'unsealed',
      yourPrediction: null,
      settlement: null,
      voided: null,
      seated: false,
      rooms: [],
      playMode: null,
      playResolving: false,
      playError: null,
    })
  },

  /** Take your seat: deposit buy-in + entry fee into an OPEN table (§7). */
  joinTable: async () => {
    const { match, terms, seated } = get()
    if (!adapters || !terms || seated) return

    // matchId/onchainMatchId/seat come from the resolved room, else the live match.
    const matchId = joinRoom?.matchId ?? match?.matchId
    const onchainMatchId = joinRoom?.onchainMatchId ?? terms.onchainMatchId
    const seatIndex = joinRoom?.seated ?? match?.yourSeat ?? 0
    if (!matchId || !onchainMatchId) {
      set({ playError: 'Table is still loading — try again in a moment.' })
      return
    }

    set({ seated: true }) // optimistic; revert on failure
    // Ensure the adapter can read onchainMatchId off terms for PDA derivation.
    if (!terms.onchainMatchId) set({ terms: { ...terms, onchainMatchId } })
    try {
      const txSig = await adapters.chain.deposit(matchId, seatIndex, terms.buyIn + terms.entryFee)
      // Best-effort registry report (capital safety never depends on it, §7).
      void reportDeposit(matchId, {
        depositTxSig: txSig,
        wallet: adapters.wallet.address() ?? '',
        seatIndex,
      })
      void refreshBalance(set)
    } catch (err) {
      console.error('deposit failed:', err)
      set({ seated: false, playError: 'Deposit failed — see console.' })
    }
  },

  /** Host create: open a new table on-chain and seat yourself (§7). */
  createTable: async () => {
    const { seated } = get()
    if (!adapters || !createCtx || seated) return
    const { tmpl, priceTokenHex, onchainMatchId } = createCtx
    const p = templateToCreateParams(tmpl)
    set({ seated: true }) // optimistic
    try {
      const { txSig, matchPda } = await adapters.chain.createAndDeposit({
        onchainMatchId,
        configHash: p.configHash,
        priceTokenHex,
        seatIndex: 0,
        buyIn: p.buyIn,
        entryFee: p.entryFee,
        rakeBps: p.rakeBps,
        rakeCap: p.rakeCap,
        nonsealPenaltyBps: p.nonsealPenaltyBps,
        minPlayers: p.minPlayers,
        maxPlayers: p.maxPlayers,
        totalBettingDurationSec: p.totalBettingDurationSec,
        sealWindowSec: p.sealWindowSec,
        beginLiveWindowSec: p.beginLiveWindowSec,
        fillWindowSec: p.fillWindowSec,
        decimals: p.decimals,
      })
      // Record the on-chain ids so subsequent ix (seal/claim) derive the right PDAs.
      set((s) => ({ terms: s.terms ? { ...s.terms, onchainMatchId, matchPda } : s.terms, lastTxSig: txSig }))
      // Best-effort registry report so others can discover the room.
      void reportCreate({
        createTxSig: txSig,
        matchPda,
        onchainMatchId,
        configHash: p.configHash,
        wallet: adapters.wallet.address() ?? '',
        seatIndex: 0,
        maxPlayers: p.maxPlayers,
      })
      // Subscribe to our new match for gameplay pushes.
      gateway?.send({ type: 'subscribe', matchId: matchPda })
      void refreshBalance(set)
    } catch (err) {
      console.error('create failed:', err)
      set({ seated: false, playError: 'Creating the table failed — see console.' })
    }
  },

  sealPrediction: async (price) => {
    const { terms, match, sealStatus } = get()
    if (!adapters || !gateway || !terms || !match) return
    if (sealStatus !== 'unsealed') return // seal-once
    set({ sealStatus: 'sealing' })
    try {
      const targetRound = terms.timelockTargetRound
      const ciphertext = await adapters.tlock.seal(price, targetRound, DRAND.chainHash, DRAND.api)
      const seatIndex = match.yourSeat ?? 0
      // Commitment and blinding are placeholder-generated here; tlock-js integration (§6)
      // will produce the real H(prediction||blinding) + 32-byte blinding factor.
      const randHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
      const blindingHex = randHex()
      const commitmentHex = randHex() // TODO: replace with H(price_i128_le || blinding)
      const signature = await adapters.wallet.signMessageBase64(`${match.matchId}:${commitmentHex}`)
      gateway.send({
        type: 'sealPrediction',
        matchId: match.matchId,
        seatIndex,
        ciphertext,
        commitmentHex,
        targetRound,
        blindingHex,
        signature,
      })
      // The plaintext stays on the client for the distance-to-conviction chart.
      set({ sealStatus: 'sealed', yourPrediction: price })
    } catch (err) {
      console.error('seal failed:', err)
      set({ sealStatus: 'unsealed' })
    }
  },

  act: async (action) => {
    const { match, yourTurn } = get()
    if (!adapters || !gateway || !match || !yourTurn) return
    // Each action is a SIGNED intent (replay-safe log, §5).
    const intent = JSON.stringify({ matchId: match.matchId, action })
    const signature = await adapters.wallet.signMessageBase64(intent)
    gateway.send({ type: 'act', matchId: match.matchId, action, signature })
    set({ yourTurn: null }) // optimistic; server's next matchState is authoritative
  },

  setDefault: (def) => {
    const { match } = get()
    set({ defaultAction: def })
    if (gateway && match) gateway.send({ type: 'setDefault', matchId: match.matchId, default: def })
  },

  claim: async () => {
    const { match } = get()
    if (!adapters || !match) return null
    const sig = await adapters.chain.claim(match.matchId)
    // Payout is derived on-chain; re-read the SPL balance after finality.
    void refreshBalance(set)
    return sig
  },

  refund: async () => {
    const { match } = get()
    if (!adapters || !match) return null
    const sig = await adapters.chain.refund(match.matchId)
    void refreshBalance(set)
    return sig
  },

  setReviewing: (v) => set({ reviewing: v }),

  /** Leave the finished match and matchmake into a fresh one — no page refresh.
   * Keeps the wallet/chain so the balance carries over; re-runs Play Now. */
  playAgain: async () => {
    set({
      match: null,
      yourTurn: null,
      sealStatus: 'unsealed',
      yourPrediction: null,
      settlement: null,
      voided: null,
      reviewing: false,
      seated: false,
      feed: [],
      priceHistory: [],
    })
    await get().createGame()
  },
}))

type SetState = (partial: Partial<GameState> | ((s: GameState) => Partial<GameState>)) => void

function handleServerMessage(
  msg: Parameters<Parameters<Gateway['subscribe']>[0]>[0],
  set: SetState,
  get: () => GameState,
) {
  switch (msg.type) {
    case 'authenticated':
      set({ walletAddress: msg.wallet, status: 'live' })
      break
    case 'tableTerms':
      // Merge: keep any on-chain ids we already resolved (create path) if the
      // gateway's terms omit them.
      set((s) => ({
        terms: {
          ...msg.terms,
          onchainMatchId: msg.terms.onchainMatchId ?? s.terms?.onchainMatchId,
          matchPda: msg.terms.matchPda ?? s.terms?.matchPda,
        },
      }))
      break
    case 'matchState':
      ingestMatchState(msg.state, set, get)
      break
    case 'yourTurn':
      set({ yourTurn: { toCall: msg.toCall, minRaiseTo: msg.minRaiseTo, deadline: msg.yourTurnDeadline ?? Date.now() + 30_000 } })
      break
    case 'event':
      set((s) => ({ feed: [...s.feed, msg.event].slice(-MAX_FEED) }))
      break
    case 'lobbyList':
      // Full snapshot of open rooms.
      set({ rooms: msg.rooms })
      break
    case 'roomsUpdated':
      // Incremental upsert; a 'started' room is no longer joinable → drop it.
      set((s) => ({ rooms: applyRoomsUpdate(s.rooms, msg.update) }))
      break
    case 'settled':
      set({ settlement: msg.result, yourTurn: null })
      break
    case 'void':
      set({ voided: { reason: msg.reason }, yourTurn: null })
      break
    case 'error':
      console.error('gateway error:', msg.reason)
      break
    default:
      break // queueStatus/profile/leaderboard handled by their own surfaces later
  }
}

/** Apply an incremental roomsUpdated to the open-rooms list. */
function applyRoomsUpdate(
  rooms: RoomListing[],
  u: import('@/lib/protocol').RoomsUpdate,
): RoomListing[] {
  if (u.kind === 'started') return rooms.filter((r) => r.matchId !== u.matchId)
  const existing = rooms.find((r) => r.matchId === u.matchId)
  const merged: RoomListing = {
    roomCode: u.roomCode ?? existing?.roomCode ?? '',
    matchId: u.matchId,
    onchainMatchId: existing?.onchainMatchId,
    feedId: u.feedId ?? existing?.feedId ?? '',
    tierId: u.tierId ?? existing?.tierId ?? '',
    configHash: u.configHash ?? existing?.configHash,
    buyIn: u.buyIn ?? existing?.buyIn,
    seated: u.seated,
    minPlayers: existing?.minPlayers ?? 0,
    maxPlayers: u.maxPlayers ?? existing?.maxPlayers ?? 0,
    fillDeadline: u.fillDeadline ?? existing?.fillDeadline ?? 0,
  }
  return [...rooms.filter((r) => r.matchId !== u.matchId), merged]
}



function ingestMatchState(state: MatchStateView, set: SetState, get: () => GameState) {
  const terms = get().terms
  // Convert the protocol's fixed-point feed price to a float for the chart.
  const decimals = terms?.decimals ?? 2
  const point: PricePoint = { price: state.feedPrice / 10 ** decimals, ts: Date.now() }

  set((s) => ({
    match: state,
    priceHistory: [...s.priceHistory, point].slice(-MAX_HISTORY),
  }))
  // No auto-deposit — real custody always requires the explicit lobby deposit (§7).
}

async function refreshBalance(set: SetState) {
  if (!adapters) return
  try {
    const balance = await adapters.chain.chipBalance()
    set({ chipBalance: balance })
  } catch {
    /* live chain not wired yet — leave balance null */
  }
}
