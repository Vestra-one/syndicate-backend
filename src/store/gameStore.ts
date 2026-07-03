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
import { DRAND, PAST_FILLING_PHASES } from '@/lib/protocol'
import type { ConnectionStatus, PricePoint } from '@/lib/ui'
import type { PriceRange } from '@/lib/priceRanges'
import { createAdapters, type Adapters } from '@/lib/adapters'
import { createGateway, type Gateway } from '@/lib/realtime/gateway'
import { fetchActiveGames, fetchUpcomingGames } from '@/lib/discovery'
import {
  api,
  ensureSession,
  ApiError,
  type ApiConfig,
  type CreateIntentResponse,
  type MatchDetail,
} from '@/lib/api'

/** Resolved Play Now action: join an existing open table, or create a new one. */
export type PlayMode = 'join' | 'create'

/**
 * A live on-chain commit (create-and-deposit or join-deposit), tracked stage-by-stage
 * so the waiting UI narrates the real transaction lifecycle instead of a blind spinner.
 *  preparing  → building the ix + simulating (before the wallet prompt)
 *  signing    → the wallet approval prompt is up; we're waiting on the user
 *  confirming → broadcast; waiting for Solana to finalize (the long wait)
 *  confirmed  → finalized on-chain; the seat is real
 *  error      → simulation/send/confirm failed (message in `error`)
 */
export type TxStageName = 'preparing' | 'signing' | 'confirming' | 'confirmed' | 'error'
export type TxCommit = {
  kind: PlayMode
  stage: TxStageName
  amount: number // total committed, token base units
  chipsToken: string
  feed?: string
  seats?: string // e.g. "2/6" at commit time
  sig?: string
  error?: string
}

// ~1h at 500ms snapshots — covers the price cabinet's widest trailing-window tab ('1H')
const MAX_HISTORY = 7200
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
  /** Epoch-ms the fill window closes (room voids if under min). Drives the waiting-room countdown. */
  fillDeadline: number | null
  /** Creator-selectable ranges for a new table — buy-in in token base units, fill window in seconds. */
  createLimits: CreateLimits | null
  /** Epoch-ms the current round began — anchors the price-board chart's x-axis to the round. */
  roundStartedAt: number | null

  // self-centric, derived from the feed
  sealStatus: SealStatus
  yourPrediction: FixedPrice | null // plaintext, client-only — never sent in the clear
  defaultAction: DefaultAction

  priceHistory: PricePoint[]
  /** Selected timeframe tab on the price cabinet's chart — cabinet-display state only. */
  priceBoardRange: PriceRange
  /** Full-screen BTC/USD analysis chart, launched from the cabinet's brass chart button. */
  priceChartOpen: boolean
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
  lobbySeated: number | null // seats already taken in the room being joined (from the lobby listing)
  lastTx: { sig: string; label: string } | null // most recent on-chain tx (banner + explorer link)
  txProgress: TxCommit | null // live commit tx being narrated by the waiting ceremony
  pendingInvite: string | null // matchId from a ?table=… deep-link, awaiting the user's accept

  // actions
  fetchBalance: () => Promise<void>
  loadDiscovery: () => Promise<void>
  ingestLivePrice: (price: number, ts: number) => void
  setPriceBoardRange: (range: PriceRange) => void
  openPriceChart: () => void
  closePriceChart: () => void
  setDashboardSort: (key: DashboardSortKey) => void
  enterTable: (matchId: string) => Promise<void>
  leaveToDiscovery: () => void
  backToDashboard: () => void
  connect: () => Promise<void>
  disconnect: () => void
  joinGame: (matchId: string) => Promise<void>
  createGame: () => Promise<void>
  /** Set the buy-in (token base units) for the table being created — clamped to createLimits. */
  setCreateBuyIn: (baseUnits: number) => void
  /** Set the fill window (seconds) for the table being created — clamped to createLimits. */
  setCreateFillWindow: (sec: number) => void
  dismissInvite: () => void
  joinTable: () => Promise<void>
  createTable: () => Promise<void>
  dismissTxProgress: () => void
  sealPrediction: (price: FixedPrice) => Promise<void>
  act: (action: BettingAction) => Promise<void>
  setDefault: (def: DefaultAction) => void
  claim: () => Promise<string | null>
  refund: () => Promise<string | null>
  setReviewing: (v: boolean) => void
  playAgain: () => Promise<void>
}

/** Creator-selectable ranges for a new table. */
export interface CreateLimits {
  buyInMin: number
  buyInMax: number
  fillWindowMinSec: number
  fillWindowMaxSec: number
}

/** Hard floors on host-chosen create params (independent of the config's own range). */
const MIN_BUYIN_BASE = 100_000 // 0.1 USDC (6 decimals)
const MIN_FILL_WINDOW_SEC = 20

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Derive the effective creator ranges from `GET /v1/config` bounds, applying the hard floors. */
function configToCreateLimits(config: ApiConfig): CreateLimits {
  const b = config.bounds
  const buyInMin = Math.max(MIN_BUYIN_BASE, b.buy_in.min || MIN_BUYIN_BASE)
  const buyInMax = Math.max(buyInMin, b.buy_in.max || 1_000_000_000)
  const fillWindowMinSec = Math.max(MIN_FILL_WINDOW_SEC, b.fill_window_sec.min || MIN_FILL_WINDOW_SEC)
  const fillWindowMaxSec = Math.max(fillWindowMinSec, b.fill_window_sec.max || 86_400)
  return { buyInMin, buyInMax, fillWindowMinSec, fillWindowMaxSec }
}

const ORACLE_UNAVAILABLE_MSG = 'Settlement paused — the price oracle is unavailable. Your funds are safe and fully refundable.'

/** Default street schedule (count + per-street durations/observation) within config bounds. */
function defaultStreets(config: ApiConfig): { count: number; durations_sec: number[]; observation_sec: number[] } {
  const count = clamp(3, config.bounds.streets.min, config.bounds.streets.max)
  const dur = clamp(180, config.bounds.street_duration_sec.min, config.bounds.street_duration_sec.max)
  const obs = clamp(20, config.bounds.observation_sec.min, config.bounds.observation_sec.max)
  return {
    count,
    durations_sec: Array.from({ length: count }, () => dur),
    observation_sec: Array.from({ length: count }, () => obs),
  }
}

/** Build the create-Lobby `TableTerms` from config defaults/bounds for a chosen feed. */
function configToTerms(config: ApiConfig, feed: string): TableTerms {
  const d = config.defaults
  const buyIn = clamp(1_000_000, config.bounds.buy_in.min, config.bounds.buy_in.max)
  const streets = defaultStreets(config)
  return {
    tableId: feed,
    priceFeedId: feed,
    supportedFeeds: config.feeds.map((f) => f.feed),
    chipsToken: 'USDC',
    decimals: 2,
    oracleAdapter: 'signed-price',
    settlementMode: 'exact-timestamp',
    oracleUnavailableMessage: ORACLE_UNAVAILABLE_MSG,
    buyIn,
    entryFee: d.entry_fee,
    rakeBps: d.rake_bps,
    rakeCap: buyIn,
    smallBlind: Math.max(1, Math.floor(buyIn / 200)),
    bigBlind: Math.max(2, Math.floor(buyIn / 100)),
    minPlayers: config.bounds.players.min,
    maxPlayers: config.bounds.players.max,
    roundCount: streets.count,
    roundDurationsSec: streets.durations_sec,
    actionTimerSec: Math.round(d.action_timeout_ms / 1000),
    timeBankSec: d.time_bank_sec,
    settlementWindowSec: d.begin_live_window_sec,
    geofenceBlocklist: [],
    allowDuplicateWalletPerMatch: false,
    fillWindowSec: clamp(3600, config.bounds.fill_window_sec.min, config.bounds.fill_window_sec.max),
    practiceMode: false,
    timelockTargetRound: 0,
  }
}

/** Build `TableTerms` from a `GET /v1/matches/{id}` detail (join Lobby + table view). */
function matchDetailToTerms(detail: MatchDetail): TableTerms {
  const p = detail.params
  return {
    tableId: detail.feed,
    priceFeedId: detail.feed,
    supportedFeeds: [detail.feed],
    chipsToken: 'USDC',
    decimals: 2,
    oracleAdapter: 'signed-price',
    settlementMode: 'exact-timestamp',
    oracleUnavailableMessage: ORACLE_UNAVAILABLE_MSG,
    buyIn: p.buy_in,
    entryFee: p.entry_fee,
    rakeBps: p.rake_bps,
    rakeCap: p.rake_cap,
    smallBlind: p.small_blind,
    bigBlind: p.big_blind,
    minPlayers: p.min_players,
    maxPlayers: p.max_players,
    roundCount: p.round_count,
    roundDurationsSec: p.round_durations_sec,
    actionTimerSec: Math.round(p.action_timeout_ms / 1000),
    timeBankSec: 0,
    settlementWindowSec: 0,
    geofenceBlocklist: [],
    allowDuplicateWalletPerMatch: false,
    fillWindowSec: undefined,
    practiceMode: false,
    timelockTargetRound: detail.timing.timelock_target ?? 0,
    onchainMatchId: String(detail.onchain_match_id),
  }
}

let adapters: Adapters | null = null
let gateway: Gateway | null = null
let unsub: (() => void) | null = null

/** REST context for the CREATE flow: server config (for building the intent), the chosen
 *  feed, and the reserved intent once `/v1/rooms/intents` has returned it. */
let createCtx: { config: ApiConfig; feed: string; intent: CreateIntentResponse | null } | null = null
/** The match UUID we resolved to JOIN — target of the deposit POST + candidate polling. */
let joinMatchId: string | null = null

/**
 * Turn a raw deposit error into a user-facing message. `simulateSignAndSend` throws
 * `Error(<AnchorErrorCode>)` for program errors, or an Error with the raw message
 * otherwise — surface something actionable instead of "see console".
 */
function depositErrorMessage(err: unknown, kind: PlayMode = 'join'): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Anchor / SPL / system-program cases we can phrase better than the raw code.
  if (/User rejected|rejected the request|denied|declined|cancell?ed/i.test(msg)) {
    return 'You cancelled the transaction in your wallet.'
  }
  if (/already in use|SeatAlreadyExists|AlreadySeated/i.test(msg)) {
    return 'You already have a seat at this table.'
  }
  if (/MatchFull|SeatTaken|TableFull/i.test(msg)) return 'This table just filled up — pick another.'
  if (/DepositsClosed|MatchStarted|NotFilling/i.test(msg)) return 'This table already started — deposits are closed.'
  if (/insufficient|0x1\b|InsufficientFunds/i.test(msg)) {
    return 'Insufficient balance — you need enough USDC (buy-in + entry fee) plus SOL for fees.'
  }
  if (/block height exceeded|blockhash|expired|timed out/i.test(msg)) {
    return 'The network dropped the transaction (RPC congestion). Try again.'
  }
  // Unmatched program/simulation errors can be a wall of logs — keep the card readable.
  const verb = kind === 'create' ? 'open the table' : 'take your seat'
  return `Couldn't ${verb} — the transaction was rejected on-chain. Check your balance and try again.`
}

/**
 * Establish (or reuse) a v2 REST Bearer session for the connected wallet (§2). The
 * wallet signs a server nonce once; `ensureSession` caches the 24h token so subsequent
 * create/join calls skip the handshake. Returns false if auth fails (geofence/signature).
 */
async function ensureRestSession(adapters: Adapters, wallet: string, set: SetState): Promise<boolean> {
  try {
    await ensureSession(wallet, (msg) => adapters.wallet.signMessageBase64(msg))
    set({ status: 'live' })
    void refreshBalance(set)
    return true
  } catch (err) {
    console.warn('[session] auth failed:', err)
    return false
  }
}

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
  fillDeadline: null,
  createLimits: null,
  roundStartedAt: null,

  sealStatus: 'unsealed',
  yourPrediction: null,
  defaultAction: 'check_fold',

  priceHistory: [],
  priceBoardRange: '1m',
  priceChartOpen: false,
  feed: [],

  settlement: null,
  voided: null,
  reviewing: false,
  seated: false,

  rooms: [],
  playResolving: false,
  playMode: null,
  playError: null,
  lobbySeated: null,
  lastTx: null,
  txProgress: null,
  pendingInvite: null,

  fetchBalance: async () => {
    if (!adapters) adapters = createAdapters()
    // Explicit user/post-tx refresh — always hit the chain, never coalesce away.
    await refreshBalance(set, true)
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
    if (m && PAST_FILLING_PHASES.includes(m.phase)) return
    set((s) => ({ priceHistory: [...s.priceHistory, { price, ts }].slice(-MAX_HISTORY) }))
  },

  setPriceBoardRange: (range) => set({ priceBoardRange: range }),
  openPriceChart: () => set({ priceChartOpen: true }),
  closePriceChart: () => set({ priceChartOpen: false }),

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

  /**
   * Back out of the current create/join Lobby (pre-seat) to the dashboard. The cached REST
   * session (24h Bearer) persists, so the next create/join skips the wallet-signed nonce
   * handshake — avoiding the "double sign" this button exists to work around via refresh.
   */
  backToDashboard: () => {
    joinMatchId = null
    createCtx = null
    set({
      view: 'discovery',
      playMode: null,
      playResolving: false,
      playError: null,
      terms: null,
      match: null,
      lobbySeated: null,
      fillDeadline: null,
      createLimits: null,
      roundStartedAt: null,
    })
    void get().loadDiscovery()
  },

  /** Join a FILLING game by its match UUID — connect wallet, open a REST session, load the
   *  match detail (§5), then show the deposit Lobby. */
  joinGame: async (matchId: string) => {
    if (!adapters) adapters = createAdapters()
    joinMatchId = null
    createCtx = null
    set({ playError: null, pendingInvite: null })

    try {
      const addr = await adapters.wallet.connect()
      set({ walletAddress: addr })
    } catch {
      set({ playError: 'Wallet connection was cancelled.' })
      return
    }

    set({ view: 'table', status: 'connecting', playResolving: true, playMode: null, match: null, terms: null, seated: false, lobbySeated: null })
    const wallet = adapters.wallet.address()
    if (!wallet || !(await ensureRestSession(adapters, wallet, set))) {
      set({ playResolving: false, playError: 'Could not reach the table server (sign-in failed).' })
      return
    }

    try {
      const detail = await api.getMatch(matchId)
      if (detail.phase.toUpperCase() !== 'FILLING') {
        set({ playResolving: false, playError: 'That table already started — pick another.' })
        return
      }
      joinMatchId = detail.match_id
      const seated = detail.seats.length
      set({
        terms: matchDetailToTerms(detail),
        lobbySeated: seated,
        playMode: 'join',
        playResolving: false,
        fillDeadline: detail.timing.fill_deadline != null ? toEpochMs(detail.timing.fill_deadline) : null,
      })
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 404
        ? 'That table just closed or expired — pick another.'
        : 'Could not load the table.'
      set({ playResolving: false, playError: msg })
    }
  },

  /** Create a new game — connect wallet, open a REST session, load `GET /v1/config`, then
   *  show the create Lobby (the intent is reserved later, in createTable). */
  createGame: async () => {
    if (!adapters) adapters = createAdapters()
    joinMatchId = null
    createCtx = null
    set({ playError: null })

    try {
      const addr = await adapters.wallet.connect()
      set({ walletAddress: addr })
    } catch {
      set({ playError: 'Wallet connection was cancelled.' })
      return
    }

    set({ view: 'table', status: 'connecting', playResolving: true, playMode: null, match: null, terms: null, seated: false, lobbySeated: null })
    const wallet = adapters.wallet.address()
    if (!wallet || !(await ensureRestSession(adapters, wallet, set))) {
      set({ playResolving: false, playError: 'Could not reach the table server (sign-in failed).' })
      return
    }

    try {
      const config = await api.getConfig()
      const feed = config.feeds[0]?.feed ?? 'BTC/USD'
      createCtx = { config, feed, intent: null }
      const limits = configToCreateLimits(config)
      const base = configToTerms(config, feed)
      set({
        terms: {
          ...base,
          // Seed the host's editable choices with in-range defaults.
          buyIn: clamp(base.buyIn, limits.buyInMin, limits.buyInMax),
          fillWindowSec: clamp(base.fillWindowSec ?? limits.fillWindowMinSec, limits.fillWindowMinSec, limits.fillWindowMaxSec),
        },
        createLimits: limits,
        playMode: 'create',
        playResolving: false,
      })
    } catch {
      set({ playResolving: false, playMode: null, playError: 'Could not load table config.' })
    }
  },

  setCreateBuyIn: (baseUnits) => set((s) => {
    if (!s.terms || !s.createLimits) return {}
    const buyIn = clamp(Math.round(baseUnits), s.createLimits.buyInMin, s.createLimits.buyInMax)
    return { terms: { ...s.terms, buyIn } }
  }),

  setCreateFillWindow: (sec) => set((s) => {
    if (!s.terms || !s.createLimits) return {}
    const fillWindowSec = clamp(Math.round(sec), s.createLimits.fillWindowMinSec, s.createLimits.fillWindowMaxSec)
    return { terms: { ...s.terms, fillWindowSec } }
  }),

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
    joinMatchId = null
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
      lobbySeated: null,
      fillDeadline: null,
      createLimits: null,
    })
  },

  /** Take your seat: deposit buy-in + entry fee into an OPEN table (§7). */
  joinTable: async () => {
    const { match, terms, seated } = get()
    if (!adapters || !terms || seated) return

    // v2 has no client-chosen seat index — a deposit makes you a *candidate* and the backend
    // assigns the engine seat FCFS at lock (§5). matchId is the server UUID; onchainMatchId
    // (u64) drives PDA derivation.
    const matchId = joinMatchId ?? match?.matchId
    const onchainMatchId = terms.onchainMatchId
    if (!matchId || !onchainMatchId) {
      set({ playError: 'Table is still loading — try again in a moment.' })
      return
    }

    // Guard: a wallet can hold only one seat per match. Re-depositing reverts on-chain
    // ("account already in use"), so if a deposit already exists just take it.
    try {
      const existing = await adapters.chain.getMySeat(onchainMatchId)
      if (existing && existing.deposit > 0) {
        console.log('[joinTable] wallet already deposited (engineSeat', existing.engineSeat, 'confirmed', existing.confirmed, ') — entering table')
        set({ seated: true })
        void refreshBalance(set)
        return
      }
    } catch (err) {
      // A read failure here isn't fatal — fall through to the deposit attempt.
      console.warn('[joinTable] seat pre-check failed:', err)
    }

    const commit: TxCommit = {
      kind: 'join',
      stage: 'preparing',
      amount: terms.buyIn + terms.entryFee,
      chipsToken: terms.chipsToken,
      feed: terms.priceFeedId,
      seats: `${Math.max(match?.seats.length ?? 0, get().lobbySeated ?? 0)}/${terms.maxPlayers}`,
    }
    set({ seated: true, txProgress: commit }) // optimistic; revert on failure
    try {
      // Public room: default (zeroed) join commitment. Private-room joins bind the room
      // code via the /v1/rooms/code/{code} → join_commitment flow (follow-up).
      const txSig = await adapters.chain.deposit(matchId, undefined, terms.buyIn + terms.entryFee, (stage) =>
        set((s) => (s.txProgress ? { txProgress: { ...s.txProgress, stage } } : {})),
      )
      set((s) => ({
        lastTx: { sig: txSig, label: 'Deposit confirmed on-chain' },
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'confirmed', sig: txSig } : null,
      }))
      // Report the deposit txhash so the backend RPC-verifies it into a candidate (§5).
      // Capital safety never depends on this — an unheard-of deposit is still refundable.
      api.submitDeposit(matchId, txSig)
        .then((r) => {
          console.log('[joinTable] deposit reported — status:', r.status)
          void pollCandidate(matchId, adapters!.wallet.address() ?? '', set)
        })
        .catch((e) => console.warn('[joinTable] submitDeposit failed:', e))
      void refreshBalance(set)
    } catch (err) {
      console.error('deposit failed:', err)
      const msg = depositErrorMessage(err)
      set((s) => ({
        seated: false,
        playError: msg,
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'error', error: msg } : null,
      }))
    }
  },

  /** Host create: open a new table on-chain and seat yourself (§7). */
  createTable: async () => {
    const { seated, terms } = get()
    if (!adapters || !createCtx || !terms || seated) return
    const { config, feed } = createCtx

    // The host may have edited buy-in / fill window in the create Lobby (§4) — clamp to bounds.
    const limits = get().createLimits
    const buyIn = limits ? clamp(terms.buyIn, limits.buyInMin, limits.buyInMax) : terms.buyIn
    const fillWindowSec = limits
      ? clamp(terms.fillWindowSec ?? limits.fillWindowMinSec, limits.fillWindowMinSec, limits.fillWindowMaxSec)
      : (terms.fillWindowSec ?? 3600)
    const streets = defaultStreets(config)

    const commit: TxCommit = {
      kind: 'create',
      stage: 'preparing',
      amount: buyIn + terms.entryFee,
      chipsToken: terms.chipsToken,
      feed: terms.priceFeedId,
      seats: `1/${terms.maxPlayers}`,
    }
    set({ seated: true, txProgress: commit }) // optimistic
    try {
      // 1. Reserve an intent — the server allocates onchain_match_id + byte-exact create_params.
      const intent = await api.createIntent({
        feed,
        buy_in: buyIn,
        fill_window_sec: fillWindowSec,
        min_players: terms.minPlayers,
        max_players: terms.maxPlayers,
        streets: { count: streets.count, durations_sec: streets.durations_sec, observation_sec: streets.observation_sec },
        visibility: 'public',
      })
      createCtx = { config, feed, intent }
      const cp = intent.create_params

      // 2. Sign + send create_and_deposit built from the SERVER's create_params (config_hash,
      //    price_token, room_commitment, oracle params all come from the backend).
      const { txSig, matchPda } = await adapters.chain.createAndDeposit({
        onchainMatchId: String(cp.match_id),
        configHash: cp.config_hash,
        priceTokenHex: cp.price_token,
        buyIn: cp.buy_in,
        entryFee: cp.entry_fee,
        rakeBps: cp.rake_bps,
        rakeCap: cp.rake_cap,
        minPlayers: cp.min_players,
        maxPlayers: cp.max_players,
        isPrivate: cp.is_private,
        roomCommitmentHex: cp.room_commitment,
        totalBettingDurationSec: cp.total_betting_duration_sec,
        sealWindowSec: cp.seal_window_sec,
        beginLiveWindowSec: cp.begin_live_window_sec,
        fillWindowSec: cp.fill_window_sec,
        maxOracleConfidence: cp.max_oracle_confidence,
        oracleExponent: cp.oracle_exponent,
      }, (stage) => set((s) => (s.txProgress ? { txProgress: { ...s.txProgress, stage } } : {})))

      // 3. Report the finalized txhash — the server RPC-verifies it and registers the room.
      let matchUuid: string | null = null
      try {
        const room = await api.submitRoom(intent.intent_id, txSig)
        matchUuid = room.match_id
        joinMatchId = room.match_id
        console.log('[createTable] room registered — match_id:', room.match_id, 'seat_status:', room.seat_status)
      } catch (e) {
        console.warn('[createTable] submitRoom failed (room still refundable on-chain):', e)
      }

      // Record the on-chain ids so subsequent ix (seal/claim) derive the right PDAs.
      set((s) => ({
        terms: s.terms ? { ...s.terms, onchainMatchId: String(cp.match_id), matchPda } : s.terms,
        lastTx: { sig: txSig, label: 'Table created on-chain' },
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'confirmed', sig: txSig } : null,
        fillDeadline: Date.now() + cp.fill_window_sec * 1000,
      }))
      void matchUuid // reserved for the phase-4 WS subscribe / detail poll
      void refreshBalance(set)
    } catch (err) {
      console.error('create failed:', err)
      const msg = err instanceof ApiError ? err.message : depositErrorMessage(err, 'create')
      set((s) => ({
        seated: false,
        playError: msg,
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'error', error: msg } : null,
      }))
    }
  },

  dismissTxProgress: () => set({ txProgress: null }),

  dismissInvite: () => set({ pendingInvite: null }),

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
    set({ lastTx: { sig, label: 'Payout claimed on-chain' } })
    // Payout is derived on-chain; re-read the SPL balance after finality (force past the throttle).
    void refreshBalance(set, true)
    return sig
  },

  refund: async () => {
    const { match } = get()
    if (!adapters || !match) return null
    const sig = await adapters.chain.refund(match.matchId)
    set({ lastTx: { sig, label: 'Refund confirmed on-chain' } })
    void refreshBalance(set, true)
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
      fillDeadline: null,
      roundStartedAt: null,
    })
    await get().createGame()
  },
}))

/** On-chain deadlines are unix seconds; the UI counts down in epoch-ms. Pass through values already in ms. */
function toEpochMs(deadline: number): number {
  return deadline > 1e12 ? deadline : deadline * 1000
}

/**
 * Poll a deposit's candidate → confirmed lifecycle after reporting the txhash (§5). A
 * terminal `not_confirmed`/`rejected` means the table filled first — the buy-in is fully
 * refundable — so surface it. `confirmed` is the happy path (engine seat assigned at lock).
 */
async function pollCandidate(matchId: string, wallet: string, set: SetState, tries = 20): Promise<void> {
  if (!wallet) return
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    let s
    try {
      s = await api.getCandidate(matchId, wallet)
    } catch {
      continue // transient — keep polling
    }
    const st = s.status.toLowerCase()
    if (st === 'confirmed') {
      console.log('[candidate] confirmed — engine seat', s.seat_index)
      return
    }
    if (st === 'not_confirmed' || st === 'rejected') {
      set({
        playError: st === 'rejected'
          ? `Deposit rejected: ${s.reason ?? 'verification failed'}. Your buy-in is refundable.`
          : 'The table filled before your deposit finalized — your buy-in is refundable.',
      })
      return
    }
    // pending_verify | candidate → keep polling
  }
}

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
  const now = Date.now()
  // A new round (or the match's first LIVE state) restarts the price-board's
  // x-axis — the client-observed instant is close enough for a chart axis.
  const prevRound = get().match?.round
  const isNewRound = prevRound == null || state.round !== prevRound

  set((s) => ({
    match: state,
    priceHistory: [...s.priceHistory, point].slice(-MAX_HISTORY),
    roundStartedAt: isNewRound ? now : s.roundStartedAt,
  }))
  // No auto-deposit — real custody always requires the explicit lobby deposit (§7).
}

// The public devnet RPC (api.devnet.solana.com) rate-limits aggressively; refreshBalance
// gets called from several places in quick succession (wallet connect, gateway connect,
// post-deposit). Coalesce overlapping calls and skip redundant ones within a short window
// so we don't pile on duplicate getTokenAccountBalance requests.
let balanceInFlight: Promise<void> | null = null
let lastBalanceFetchAt = 0
const BALANCE_MIN_INTERVAL_MS = 2500

async function refreshBalance(set: SetState, force = false) {
  if (!adapters) return
  if (balanceInFlight) return balanceInFlight
  // Post-transaction refreshes (claim/refund/reclaim) must bypass the rate-limit
  // coalescing, or the balance can stay stale right after the balance actually moved.
  if (!force && Date.now() - lastBalanceFetchAt < BALANCE_MIN_INTERVAL_MS) return
  balanceInFlight = (async () => {
    try {
      const balance = await adapters!.chain.chipBalance()
      set({ chipBalance: balance })
    } catch {
      /* live chain not wired yet — leave balance null */
    } finally {
      lastBalanceFetchAt = Date.now()
      balanceInFlight = null
    }
  })()
  return balanceInFlight
}
