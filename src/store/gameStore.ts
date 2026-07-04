import { create } from 'zustand'
import type {
  BettingAction,
  DashboardSortKey,
  DefaultAction,
  FixedPrice,
  LiveGame,
  MatchPhase,
  MatchStateView,
  PublicEvent,
  SeatView,
  SettlementView,
  TableTerms,
  UpcomingGame,
  VoidReason,
} from '@/lib/protocol'
import { DRAND, PAST_FILLING_PHASES } from '@/lib/protocol'
import type { ServerFrame, WsMatchState, WsAction } from '@/lib/realtime/wsTypes'
import {
  actionIntentMessage,
  defaultPolicyMessage,
  predictionCommitmentMessage,
  ciphertextCommitment,
  bytesToHex,
} from '@/lib/intent'
import bs58 from 'bs58'
import type { ConnectionStatus, PricePoint } from '@/lib/ui'
import type { PriceRange } from '@/lib/priceRanges'
import { createAdapters, type Adapters, type TxProgressFn } from '@/lib/adapters'
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

/**
 * Distinct commit-failure states, each with its own copy + recovery path in the ceremony:
 *  - rejected       → user declined the wallet prompt
 *  - insufficient    → not enough USDC (or SOL for fees) to cover the buy-in
 *  - seat_taken      → the table filled while the user was signing
 *  - already_seated  → the wallet already holds a seat at this table
 *  - closed          → deposits closed / the match already started
 *  - network         → RPC congestion / dropped tx / server (intent) error
 *  - unknown         → an unmatched program/simulation error (raw kept for support)
 */
export type TxErrorCode =
  | 'rejected'
  | 'insufficient'
  | 'seat_taken'
  | 'already_seated'
  | 'closed'
  | 'network'
  | 'unknown'

export type TxCommit = {
  kind: PlayMode
  stage: TxStageName
  amount: number // total committed, token base units
  chipsToken: string
  feed?: string
  seats?: string // e.g. "2/6" at commit time
  sig?: string
  /** Epoch-ms the tx was broadcast (stage → confirming) — anchors the finality elapsed clock. */
  confirmingAt?: number
  error?: string
  /** Classified failure state — drives the ceremony's error copy + recovery affordances. */
  errorCode?: TxErrorCode
  /** The raw underlying error, verbatim — surfaced in the collapsible "Technical details" row. */
  errorRaw?: string
  /** Wallet's spendable chip balance (base units) snapshotted at an `insufficient` failure,
   *  so the card can show "you need X — your wallet has Y" against a stable number. */
  walletBalance?: number
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
  /** Epoch-ms of the last successful discovery load — drives the live "updated Xs ago" label. */
  discoveryUpdatedAt: number | null
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
  /** Early lock-in made before the table locks — the drand round (and your engine seat)
   *  only exist once phase → SEALING, so the call is held locally and auto-sealed then. */
  queuedPrediction: FixedPrice | null
  /** The server closed the seal window (§6) — no further seals are accepted. */
  sealClosed: boolean
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
  playResolving: boolean // true while deciding join-vs-create
  playMode: PlayMode | null // resolved action for the current lobby card
  playError: string | null // resolution / commit failure surfaced to the user
  lobbySeated: number | null // seats already taken in the room being joined (from the lobby listing)
  lastTx: { sig: string; label: string } | null // most recent on-chain tx (banner + explorer link)
  txProgress: TxCommit | null // live commit tx being narrated by the waiting ceremony
  pendingInvite: string | null // matchId from a ?table=… deep-link, awaiting the user's accept
  inviteFrom: string | null // the inviter's pseudonymous alias from the deep-link's ?from= param

  // actions
  fetchBalance: () => Promise<void>
  /** Load the discovery feed. `silent` polls skip the loading flash and keep the
   *  last-good list on a transient failure (used by the dashboard's live ticker). */
  loadDiscovery: (opts?: { silent?: boolean }) => Promise<void>
  ingestLivePrice: (price: number, ts: number) => void
  setPriceBoardRange: (range: PriceRange) => void
  openPriceChart: () => void
  closePriceChart: () => void
  setDashboardSort: (key: DashboardSortKey) => void
  /** Returning player: if the wallet already holds a waiting/live seat, skip the
   *  dashboard and drop straight back into that table (§ reconnect). */
  resumeActiveTable: (wallet: string) => Promise<void>
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
  /** Switch the market (price feed) for the table being created, keeping the host's buy-in & fill window. */
  setCreateFeed: (feed: string) => void
  dismissInvite: () => void
  joinTable: () => Promise<void>
  createTable: () => Promise<void>
  dismissTxProgress: () => void
  /** Bail out of a commit before it's signed — reverts the optimistic seat and clears the ceremony. */
  abortTxCommit: () => void
  sealPrediction: (price: FixedPrice) => Promise<void>
  /** Withdraw an early lock-in that hasn't been sealed yet. */
  clearQueuedPrediction: () => void
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
    fillWindowSec: clamp(300, config.bounds.fill_window_sec.min, config.bounds.fill_window_sec.max),
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

/** Action-chain state for signed betting (§8), reset per match. `head` seeds `prev_head`
 *  for the next `act`; `nonce` increments per action; `engineSeat` is this wallet's seat. */
let actionHead: Uint8Array = new Uint8Array(32)
let actionNonce = 0
let myEngineSeat: number | null = null
function resetActionChain() {
  actionHead = new Uint8Array(32)
  actionNonce = 0
  myEngineSeat = null
}

/** Subscribe the open socket to a match channel — server replies with a snapshot then the
 *  ordered event stream (gap-free, dedup by seq). Pass `lastSeq` to fetch only the delta. */
function subscribeMatch(matchId: string, lastSeq = 0) {
  gateway?.send({ t: 'subscribe', channel: { match: matchId }, last_seq: lastSeq })
}

/** REST context for the CREATE flow: server config (for building the intent), the chosen
 *  feed, and the reserved intent once `/v1/rooms/intents` has returned it. */
let createCtx: { config: ApiConfig; feed: string; intent: CreateIntentResponse | null } | null = null
/** The match UUID we resolved to JOIN — target of the deposit POST + candidate polling. */
let joinMatchId: string | null = null

/** One-shot latch: only auto-resume once per page load (wallet autoConnect can re-fire). */
let resumeAttempted = false

/** Reconnect priority — a live game outranks a still-filling one if the wallet holds both. */
const RESUME_PHASE_RANK: Record<string, number> = {
  live: 0,
  sealing_closed: 1,
  sealing: 2,
  filling: 3,
}

/**
 * Classify a raw commit error into one of the distinct `TxErrorCode` states.
 * `simulateSignAndSend` throws `Error(<AnchorErrorCode>)` for program errors, the wallet
 * throws its own reject/decline message, and the RPC throws blockhash/timeout text — each
 * maps to a bucket the ceremony narrates with its own copy and recovery path.
 */
function classifyDepositError(err: unknown): TxErrorCode {
  if (err instanceof ApiError) return 'network' // intent/room reservation failed server-side
  const msg = err instanceof Error ? err.message : String(err)
  if (/User rejected|rejected the request|denied|declined|cancell?ed/i.test(msg)) return 'rejected'
  if (/already in use|SeatAlreadyExists|AlreadySeated/i.test(msg)) return 'already_seated'
  if (/MatchFull|SeatTaken|TableFull/i.test(msg)) return 'seat_taken'
  if (/DepositsClosed|MatchStarted|NotFilling/i.test(msg)) return 'closed'
  if (/insufficient|0x1\b|InsufficientFunds/i.test(msg)) return 'insufficient'
  if (/block height exceeded|blockhash|expired|timed out|congest/i.test(msg)) return 'network'
  return 'unknown'
}

/** The verbatim error text, kept for the ceremony's "Technical details" copy row. */
function rawErrorText(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status} — ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

/**
 * A short user-facing summary per failure state. The ceremony renders richer, context-aware
 * copy (required-vs-actual balance, refund note, faucet) on top of this, but this string is
 * the single source for `playError` toasts and the card's fallback sub-headline.
 */
function depositErrorMessage(code: TxErrorCode, kind: PlayMode): string {
  switch (code) {
    case 'rejected':
      return 'You dismissed the approval in your wallet — nothing was sent.'
    case 'insufficient':
      return "You don't have enough USDC to cover the buy-in and entry fee."
    case 'seat_taken':
      return 'This table filled while you were signing — no funds left your wallet.'
    case 'already_seated':
      return 'You already have a seat at this table.'
    case 'closed':
      return 'This table already started — deposits are closed.'
    case 'network':
      return 'The network dropped the transaction. Check your connection and try again.'
    default:
      return kind === 'create'
        ? "Couldn't open the table — the transaction was rejected on-chain."
        : "Couldn't take your seat — the transaction was rejected on-chain."
  }
}

/**
 * Land a commit failure: classify it, log the distinct state, revert the optimistic seat,
 * and drive the ceremony into its error view. For an `insufficient` failure we refetch the
 * chip balance so the card can show "you need X — your wallet has Y" against a live number.
 * An ApiError carries a specific server message, so we surface that verbatim over the generic
 * network copy while still tagging the state `network` for the card's treatment.
 */
async function failCommit(set: SetState, err: unknown, kind: PlayMode): Promise<void> {
  const code = classifyDepositError(err)
  const raw = rawErrorText(err)
  const message = err instanceof ApiError ? err.message : depositErrorMessage(code, kind)
  console.warn(`[tx:${kind}] commit failed — ${code}:`, raw)

  let walletBalance: number | undefined
  if (code === 'insufficient' && adapters) {
    try {
      walletBalance = await adapters.chain.chipBalance()
      set({ chipBalance: walletBalance })
    } catch {
      /* leave undefined — the card falls back to the last-known balance */
    }
  }

  set((s) => ({
    seated: false,
    playError: message,
    txProgress: s.txProgress
      ? { ...s.txProgress, stage: 'error', error: message, errorCode: code, errorRaw: raw, walletBalance }
      : null,
  }))
}

/**
 * The stage callback the chain adapter drives during a commit tx. It advances
 * `txProgress.stage`, captures the tx signature once broadcast (so the ceremony can
 * link it to Solscan for verification), and stamps `confirmingAt` the first time we
 * enter finality — the anchor for the finalize step's elapsed-time clock.
 */
function txProgressCallback(set: SetState): TxProgressFn {
  return (stage, sig) =>
    set((s) => {
      if (!s.txProgress) return {}
      const next: TxCommit = { ...s.txProgress, stage }
      if (sig) next.sig = sig
      if (stage === 'confirming' && next.confirmingAt == null) next.confirmingAt = Date.now()
      return { txProgress: next }
    })
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
  discoveryUpdatedAt: null,
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
  queuedPrediction: null,
  sealClosed: false,
  defaultAction: 'check_fold',

  priceHistory: [],
  priceBoardRange: '1m',
  priceChartOpen: false,
  feed: [],

  settlement: null,
  voided: null,
  reviewing: false,
  seated: false,

  playResolving: false,
  playMode: null,
  playError: null,
  lobbySeated: null,
  lastTx: null,
  txProgress: null,
  pendingInvite: null,
  inviteFrom: null,

  fetchBalance: async () => {
    if (!adapters) adapters = createAdapters()
    // Explicit user/post-tx refresh — always hit the chain, never coalesce away.
    await refreshBalance(set, true)
  },

  loadDiscovery: async (opts) => {
    const silent = opts?.silent ?? false
    // Silent polls must never flash the spinner — only an explicit/first load flips to 'loading'.
    if (!silent) set({ discoveryStatus: 'loading' })
    const [activeResult, upcomingResult] = await Promise.allSettled([
      fetchActiveGames(),
      fetchUpcomingGames(),
    ])
    const active = activeResult.status === 'fulfilled' ? activeResult.value : []
    const upcoming = upcomingResult.status === 'fulfilled' ? upcomingResult.value : []
    if (activeResult.status === 'rejected') console.warn('active-games fetch failed:', activeResult.reason)
    if (upcomingResult.status === 'rejected') console.warn('upcoming-games fetch failed:', upcomingResult.reason)
    // Only surface error if BOTH endpoints fail.
    if (activeResult.status === 'rejected' && upcomingResult.status === 'rejected') {
      // A transient blip on a background poll shouldn't blank a working lobby — keep the last-good list.
      if (!silent) set({ activeGames: [], upcomingGames: [], discoveryStatus: 'error' })
    } else {
      set({ activeGames: active, upcomingGames: upcoming, discoveryStatus: 'ready', discoveryUpdatedAt: Date.now() })
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

  /**
   * Returning-player reconnect (§ `GET /v1/wallets/{wallet}/active`). Called on the
   * wallet's silent autoConnect: if the wallet already holds a seat in a waiting or
   * live match, restore the table view (WaitingRoom while FILLING/SEALING, live HUD
   * once LIVE) instead of leaving the player on the dashboard. Public reads + the WS
   * challenge only — no Bearer handshake, so no signature prompt on page load.
   */
  resumeActiveTable: async (wallet) => {
    if (resumeAttempted) return
    resumeAttempted = true
    // Don't hijack an explicit flow: a ?table=… invite, or a join/create in progress.
    const s = get()
    if (s.view !== 'discovery' || s.seated || s.playResolving || s.pendingInvite) return
    set({ walletAddress: wallet })

    let seat: { match_id: string; phase: string } | undefined
    try {
      const { active } = await api.getActive(wallet)
      seat = active
        .filter((a) => a.phase in RESUME_PHASE_RANK)
        .sort((a, b) => RESUME_PHASE_RANK[a.phase] - RESUME_PHASE_RANK[b.phase])[0]
    } catch (err) {
      console.warn('[resume] active-seats lookup failed:', err)
      return
    }
    if (!seat) return
    // The user may have clicked Play Now while we awaited — re-check before taking over.
    if (get().view !== 'discovery' || get().seated || get().playResolving) return

    console.log('[resume] found active seat — match', seat.match_id, 'phase', seat.phase)
    if (!adapters) adapters = createAdapters()
    joinMatchId = seat.match_id
    try {
      const detail = await api.getMatch(seat.match_id)
      set({
        view: 'table',
        seated: true,
        playMode: null,
        playResolving: false,
        playError: null,
        match: null,
        feed: [],
        settlement: null,
        voided: null,
        terms: matchDetailToTerms(detail),
        // FILLING details carry no seats (engine seats assign at lock) — WS `seat_update`
        // delivers the live confirmed count right after subscribe.
        lobbySeated: detail.seats.length > 0 ? detail.seats.length : null,
        fillDeadline: detail.timing.fill_deadline != null ? toEpochMs(detail.timing.fill_deadline) : null,
        roundStartedAt: detail.timing.live_start != null ? toEpochMs(detail.timing.live_start) : null,
      })
    } catch (err) {
      console.warn('[resume] match detail failed — staying on dashboard:', err)
      joinMatchId = null
      return
    }
    resetActionChain()
    await get().connect()
    subscribeMatch(seat.match_id)
    void refreshBalance(set)
  },

  /** Spectate a table from the dashboard: open the WS, subscribe to its match channel,
   *  and seed terms from REST detail for an instant render (§6). No auth needed to watch. */
  enterTable: async (matchId) => {
    set({ view: 'table', match: null, feed: [], priceHistory: [], settlement: null, voided: null })
    resetActionChain()
    if (!adapters) adapters = createAdapters()
    await get().connect()
    try {
      const detail = await api.getMatch(matchId)
      set({ terms: matchDetailToTerms(detail) })
    } catch {
      /* the WS snapshot will populate the view */
    }
    subscribeMatch(matchId)
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
    set({ playError: null, pendingInvite: null, inviteFrom: null })

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
      // During FILLING `detail.seats` is EMPTY (engine seats assign at lock) — the confirmed
      // count lives on the lobby listing; WS `seat_update` keeps it live from here on.
      const listed = get().upcomingGames.find((g) => g.matchId === matchId)
      set({
        terms: matchDetailToTerms(detail),
        lobbySeated: listed?.seated ?? detail.seats.length,
        playMode: 'join',
        playResolving: false,
        fillDeadline: detail.timing.fill_deadline != null ? toEpochMs(detail.timing.fill_deadline) : null,
      })
      // Watch the room live (spectate needs no auth) — seat_update/phase flow pre-deposit.
      resetActionChain()
      await get().connect()
      subscribeMatch(matchId)
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

  setCreateFeed: (feed) => set((s) => {
    if (!s.terms || !createCtx) return {}
    if (feed === s.terms.priceFeedId) return {}
    if (!s.terms.supportedFeeds.includes(feed)) return {}
    createCtx = { ...createCtx, feed }
    // Rebuild the feed-derived defaults (blinds scale off buy-in, etc.) but keep
    // the host's own choices so switching markets doesn't reset their edits.
    const base = configToTerms(createCtx.config, feed)
    return {
      terms: {
        ...base,
        buyIn: s.terms.buyIn,
        rakeCap: s.terms.buyIn,
        smallBlind: Math.max(1, Math.floor(s.terms.buyIn / 200)),
        bigBlind: Math.max(2, Math.floor(s.terms.buyIn / 100)),
        fillWindowSec: s.terms.fillWindowSec,
      },
    }
  }),

  /** Open the v2 WebSocket (idempotent). Spectate needs no wallet; if one is connected the
   *  transport answers the auth challenge so the same socket can also act/seal (§12). */
  connect: async () => {
    if (gateway) return
    set({ status: 'connecting' })
    if (!adapters) adapters = createAdapters()
    // Capture the instance locally — `gateway` (module-global) can be reassigned by a
    // StrictMode unmount/remount across the await; act on the instance we created.
    const gw = createGateway(adapters)
    gateway = gw
    unsub = gw.subscribe((frame) => handleServerFrame(frame, set, get))
    try {
      await gw.connect() // resolves on socket open; auto-answers a challenge if a wallet exists
      set({ status: 'live' })
      const addr = adapters.wallet.address()
      if (addr) {
        set({ walletAddress: addr })
        void refreshBalance(set)
      }
    } catch (err) {
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
      queuedPrediction: null,
      sealClosed: false,
      settlement: null,
      voided: null,
      seated: false,
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
      const txSig = await adapters.chain.deposit(matchId, undefined, terms.buyIn + terms.entryFee, txProgressCallback(set))
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
      // Open the WS + subscribe so the waiting room / live play get seat/phase/turn pushes.
      resetActionChain()
      await get().connect()
      subscribeMatch(matchId)
      void refreshBalance(set)
    } catch (err) {
      await failCommit(set, err, 'join')
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
      }, txProgressCallback(set))

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
      // Open the WS + subscribe to the new match so the waiting room gets live seat/phase pushes.
      if (matchUuid) {
        resetActionChain()
        await get().connect()
        subscribeMatch(matchUuid)
      }
      void refreshBalance(set)
    } catch (err) {
      await failCommit(set, err, 'create')
    }
  },

  dismissTxProgress: () => set({ txProgress: null }),

  // User cancelled from the ceremony before signing. Safe only pre-signature: no
  // funds have moved yet, so we just revert the optimistic seat and close the view.
  // If the wallet prompt is up, the in-flight sign() still resolves/rejects, but its
  // downstream set()s are all guarded by `s.txProgress` and become no-ops.
  abortTxCommit: () => set({ txProgress: null, seated: false }),

  dismissInvite: () => set({ pendingInvite: null, inviteFrom: null }),

  sealPrediction: async (price) => {
    const { terms, match, sealStatus, sealClosed } = get()
    if (!adapters || !terms || sealStatus !== 'unsealed' || sealClosed) return // seal-once
    const targetRound = terms.timelockTargetRound
    const seatIndex = myEngineSeat ?? match?.yourSeat
    if (!targetRound || seatIndex == null || !match) {
      // The drand round + engine seat are assigned when the table locks (phase → SEALING).
      // Hold the call locally; ensureSealContext auto-seals it the moment the window opens.
      set({ queuedPrediction: price })
      return
    }
    const onchainMatchId = terms.onchainMatchId
    const wallet = adapters.wallet.address()
    if (!onchainMatchId || !wallet) {
      console.warn('[seal] missing context', { onchainMatchId, targetRound, seatIndex })
      set({ playError: 'Sealing is not ready yet — wait for the seal window to open.' })
      return
    }
    set({ sealStatus: 'sealing' })
    try {
      // 1. Time-lock encrypt the WAD price, derive ciphertext_b64 + commitment = sha256(ct).
      const decimals = terms.decimals ?? 2
      const priceWad = BigInt(Math.round(price)) * 10n ** BigInt(18 - decimals)
      const ciphertext = await adapters.tlock.seal(priceWad, targetRound, DRAND.chainHash, DRAND.api)
      const ciphertextB64 = btoa(String.fromCharCode(...ciphertext))
      const commitment = await ciphertextCommitment(ciphertext)
      const commitmentHex = bytesToHex(commitment)

      // 2. Register the commitment on-chain (the strong seal proof).
      let sealTxSig: string
      try {
        sealTxSig = await adapters.chain.registerPredictionCommitment(onchainMatchId, commitmentHex, targetRound)
      } catch (e) {
        console.error('[seal] on-chain register failed:', e)
        set({ sealStatus: 'unsealed', playError: 'Could not register your sealed prediction on-chain.' })
        return
      }

      // 3. Sign the seal-intent message and submit the ciphertext to the backend (§7 / App. B).
      const msg = predictionCommitmentMessage({
        matchId: BigInt(onchainMatchId),
        onchainMatchId: BigInt(onchainMatchId),
        seatIndex,
        seatPubkey: bs58.decode(wallet),
        timelockTarget: targetRound,
        commitment,
      })
      const signature = await adapters.wallet.signBytesBase64(msg)
      const body = { ciphertext_b64: ciphertextB64, commitment_hex: commitmentHex, timelock_target: targetRound, signature, seal_tx_sig: sealTxSig }
      // REST only (not the WS `seal` frame): the socket's ack/error frames aren't correlated
      // to this request, so awaiting the HTTP response — same server handler — is the only
      // way to know the seal was accepted before latching 'sealed'.
      await api.submitSeal(match.matchId, body)
      // The plaintext stays on the client for the distance-to-conviction chart.
      set({ sealStatus: 'sealed', yourPrediction: price, queuedPrediction: null })
    } catch (err) {
      console.error('seal failed:', err)
      const msg = err instanceof ApiError ? `Sealing failed — ${err.message}` : 'Sealing failed — try again before the window closes.'
      set({ sealStatus: 'unsealed', playError: msg })
    }
  },

  clearQueuedPrediction: () => set({ queuedPrediction: null }),

  act: async (action) => {
    const { match, yourTurn, terms } = get()
    if (!adapters || !gateway || !match || !yourTurn || !terms?.onchainMatchId) return
    const wallet = adapters.wallet.address()
    const seatIndex = myEngineSeat ?? match.yourSeat
    if (!wallet || seatIndex == null) return
    // Signed action intent (§8): both u64 slots carry onchain_match_id; nonce increments per
    // seat; prev_head is the current action-chain head. Sign the byte-exact message.
    const { tag, amount, wire } = bettingActionToWire(action)
    const nonce = ++actionNonce
    const prevHead = actionHead
    try {
      const msg = actionIntentMessage({
        matchId: BigInt(terms.onchainMatchId),
        onchainMatchId: BigInt(terms.onchainMatchId),
        seatIndex,
        seatPubkey: bs58.decode(wallet),
        nonce,
        prevHead,
        actionTag: tag,
        amount,
      })
      const signature = await adapters.wallet.signBytesBase64(msg)
      gateway.send({
        t: 'act',
        match_id: match.matchId,
        seat_index: seatIndex,
        nonce,
        prev_head_hex: bytesToHex(prevHead),
        action: wire,
        signature,
      })
      set({ yourTurn: null }) // optimistic; the broadcast `action` frame is authoritative
    } catch (err) {
      actionNonce-- // signing was cancelled/failed — free the nonce for a retry
      console.error('act failed:', err)
    }
  },

  setDefault: (def) => {
    const { match, terms } = get()
    set({ defaultAction: def })
    if (!gateway || !match || !adapters || !terms?.onchainMatchId) return
    const wallet = adapters.wallet.address()
    const seatIndex = myEngineSeat ?? match.yourSeat
    if (!wallet || seatIndex == null) return
    const policyTag = def === 'check_call_any' ? 1 : 0
    const msg = defaultPolicyMessage({
      matchId: BigInt(terms.onchainMatchId),
      onchainMatchId: BigInt(terms.onchainMatchId),
      seatIndex,
      seatPubkey: bs58.decode(wallet),
      policyTag,
    })
    adapters.wallet
      .signBytesBase64(msg)
      .then((signature) => gateway?.send({ t: 'set_default', match_id: match.matchId, seat_index: seatIndex, policy: def, signature }))
      .catch((e) => console.warn('[setDefault] sign failed:', e))
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
      queuedPrediction: null,
      sealClosed: false,
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

/** Map a v2 WS phase string to the client `MatchPhase` union. */
const WS_PHASE: Record<string, MatchPhase> = {
  filling: 'FILLING',
  sealing: 'SEALING',
  sealing_closed: 'SEALING',
  live: 'LIVE',
  settlement_pending: 'SETTLEMENT_WINDOW',
  settled: 'SETTLED',
  voided: 'VOID',
}
function mapPhase(p: string): MatchPhase {
  return WS_PHASE[p.toLowerCase()] ?? 'FILLING'
}

/** Map a v2 snapshot `state` to the client's `MatchStateView` (what the HUD renders). */
function snapshotToMatchState(state: WsMatchState, myWallet: string | null): MatchStateView {
  const seats: SeatView[] = state.seats.map((s) => ({
    seat: s.seat_index,
    wallet: s.wallet,
    stack: s.stack ?? 0,
    committedThisStreet: s.committed ?? 0,
    totalContribution: s.total_contribution ?? 0,
    folded: s.folded ?? false,
    allIn: s.all_in ?? false,
  }))
  const mine = myWallet ? state.seats.find((s) => s.wallet === myWallet) : undefined
  return {
    matchId: state.match_id,
    phase: mapPhase(state.phase),
    round: state.round ?? 1,
    pot: state.pot ?? 0,
    currentBet: state.current_bet ?? 0,
    buttonSeat: state.button ?? 0,
    toActSeat: state.to_act ?? null,
    seats,
    feedPrice: 0, // live price arrives via `action` frames / the price WS, not the snapshot
    yourSeat: mine?.seat_index,
    yourStack: mine?.stack ?? undefined,
    yourExposure: mine?.total_contribution ?? undefined,
  }
}

/** Translate a v2 engine event (from `action`/`event` frames) into a public feed entry. */
function wsEventToFeed(ev: { type: string; body: Record<string, unknown>; seq?: number }, matchId: string, pot: number, feedPrice: number): PublicEvent | null {
  const seat = Number(ev.body.seat ?? ev.body.player_id ?? 0)
  switch (ev.type) {
    case 'action': {
      const raw = String(ev.body.action ?? '') // e.g. "Fold", "BetTo(120)", "Call"
      const m = /^(\w+)(?:\((\d+)\))?/.exec(raw)
      const kind = (m?.[1] ?? '').toLowerCase()
      const amount = m?.[2] ? Number(m[2]) : 0
      if (kind === 'fold') return { kind: 'fold', matchId, seat, ts: Date.now() }
      return { kind: 'action', matchId, seat, action: kind, amount, feedPrice, pot, ts: Date.now() }
    }
    case 'street_closed':
      return { kind: 'round', matchId, round: Number(ev.body.round ?? 0), ts: Date.now() }
    default:
      return null
  }
}

/** Map a client `BettingAction` to its signed-intent tag/amount + the WS `action` payload. */
function bettingActionToWire(a: BettingAction): { tag: number; amount: number; wire: WsAction } {
  switch (a.type) {
    case 'fold': return { tag: 0, amount: 0, wire: 'fold' }
    case 'check': return { tag: 1, amount: 0, wire: 'check' }
    case 'call': return { tag: 2, amount: 0, wire: 'call' }
    case 'betTo': return { tag: 3, amount: a.amount, wire: { kind: 'bet_to', amount: a.amount } }
    case 'raiseTo': return { tag: 4, amount: a.amount, wire: { kind: 'raise_to', amount: a.amount } }
    case 'allIn': return { tag: 5, amount: 0, wire: 'all_in' }
  }
}

function handleServerFrame(frame: ServerFrame, set: SetState, get: () => GameState) {
  switch (frame.t) {
    case 'authenticated':
      set({ walletAddress: frame.wallet, status: 'live' })
      break

    case 'snapshot': {
      const myWallet = adapters?.wallet.address() ?? get().walletAddress
      const view = snapshotToMatchState(frame.state, myWallet)
      myEngineSeat = view.yourSeat ?? myEngineSeat
      // Seed the action-chain head + nonce from the snapshot so the first `act` chains correctly.
      try { actionHead = hexToBytes32(frame.state.head) } catch { /* keep zero head */ }
      actionNonce = Math.max(actionNonce, frame.state.last_seq)
      const t = frame.state.timing
      set((s) => ({
        match: view,
        terms: s.terms
          ? { ...s.terms, onchainMatchId: String(frame.state.onchain_match_id), timelockTargetRound: t.timelock_target ?? s.terms.timelockTargetRound }
          : s.terms,
        fillDeadline: t.fill_deadline != null ? toEpochMs(t.fill_deadline) : s.fillDeadline,
        roundStartedAt: t.live_start != null ? toEpochMs(t.live_start) : s.roundStartedAt,
        sealClosed: s.sealClosed || frame.state.phase === 'sealing_closed',
      }))
      // Reconnected mid-seal-window: recover the engine seat + our sealed flag, and fire
      // any early prediction queued before the disconnect.
      if (frame.state.phase === 'sealing') void ensureSealContext(set, get)
      break
    }

    case 'phase': {
      const phase = mapPhase(frame.phase)
      set((s) => ({
        match: s.match ? { ...s.match, phase } : s.match,
        terms: s.terms && frame.timelock_target != null ? { ...s.terms, timelockTargetRound: frame.timelock_target } : s.terms,
        fillDeadline: frame.seal_deadline != null ? toEpochMs(frame.seal_deadline) : s.fillDeadline,
        roundStartedAt: frame.live_start != null ? toEpochMs(frame.live_start) : s.roundStartedAt,
        sealClosed: s.sealClosed || frame.phase === 'sealing_closed',
      }))
      // The lock broadcast carries no seats — fetch our engine seat (needed to sign the
      // seal intent) and fire any queued early prediction now that the window is open.
      if (frame.phase === 'sealing') void ensureSealContext(set, get)
      break
    }

    case 'seat_update':
      set({ lobbySeated: frame.confirmed })
      break

    case 'seal_status': {
      // `sealed`/`just_sealed` list engine seats — recognising our own covers the reload
      // case where the latch was lost (the plaintext is gone, but re-sealing would 409).
      const mineSealed =
        myEngineSeat != null && (frame.just_sealed === myEngineSeat || (frame.sealed?.includes(myEngineSeat) ?? false))
      set((s) => ({
        sealClosed: s.sealClosed || frame.closed === true,
        sealStatus: mineSealed ? 'sealed' : s.sealStatus,
      }))
      break
    }

    case 'your_turn':
      myEngineSeat = frame.seat
      set({ yourTurn: { toCall: frame.to_call, minRaiseTo: frame.min_raise_to, deadline: frame.deadline_ms } })
      break

    case 'action': {
      // Advance the action-chain head + nonce so the next signed `act` uses the right prev_head.
      try { actionHead = hexToBytes32(frame.head_hex) } catch { /* keep */ }
      actionNonce = Math.max(actionNonce, frame.seq)
      const decimals = get().terms?.decimals ?? 2
      const priceNum = frame.feed_price != null ? wadStringToFixed(frame.feed_price, frame.feed_price_expo, decimals) : 0
      const feedItems = frame.events
        .map((e) => wsEventToFeed(e, frame.match_id, frame.pot, priceNum))
        .filter((x): x is PublicEvent => x !== null)
      const now = Date.now()
      set((s) => ({
        feed: [...s.feed, ...feedItems].slice(-MAX_FEED),
        match: s.match
          ? { ...s.match, pot: frame.pot, currentBet: frame.current_bet, toActSeat: frame.to_act ?? null, round: frame.round, feedPrice: priceNum }
          : s.match,
        priceHistory: priceNum > 0 ? [...s.priceHistory, { price: priceNum, ts: now }].slice(-MAX_HISTORY) : s.priceHistory,
        yourTurn: frame.to_act != null && frame.to_act === myEngineSeat ? s.yourTurn : null,
      }))
      break
    }

    case 'settled':
      set({
        settlement: {
          matchId: frame.match_id,
          settlementPrice: 0,
          awards: frame.payouts.map((p) => ({ seat: p.seat, amount: 0 })),
          uncalledReturns: [],
          rakeCollected: 0,
          revealedPredictions: [],
        },
        yourTurn: null,
      })
      break

    case 'voided':
      set({ voided: { reason: (frame.kind ?? 'Void') as VoidReason }, yourTurn: null })
      break

    case 'error':
      console.warn('[ws] error frame:', frame.code, frame.msg)
      break

    default:
      break // lobby_delta / default_set / sealed / pong — no store action needed
  }
}

/**
 * The seal window just opened (or we reconnected inside it). The WS lock broadcast carries
 * only the drand round — the engine seat assignments (needed to sign the seal intent with
 * the server's seat_index) live in the REST detail, so refetch it, sync our sealed flag,
 * then auto-seal any prediction the player locked in early from the waiting room.
 */
async function ensureSealContext(set: SetState, get: () => GameState): Promise<void> {
  const matchId = get().match?.matchId ?? joinMatchId
  if (!matchId) return
  const wallet = adapters?.wallet.address() ?? get().walletAddress
  try {
    const detail = await api.getMatch(matchId)
    const mine = wallet ? detail.seats.find((x) => x.wallet === wallet) : undefined
    if (mine) myEngineSeat = mine.seat_index
    set((s) => ({
      sealStatus: mine?.sealed && s.sealStatus !== 'sealed' ? 'sealed' : s.sealStatus,
      terms:
        s.terms && detail.timing.timelock_target != null
          ? { ...s.terms, timelockTargetRound: detail.timing.timelock_target }
          : s.terms,
    }))
  } catch (err) {
    console.warn('[seal] match refresh at lock failed:', err) // the queued seal below may still succeed
  }
  const s = get()
  if (s.queuedPrediction != null && s.sealStatus === 'unsealed' && !s.sealClosed) {
    void s.sealPrediction(s.queuedPrediction)
  }
}

/** Parse a 32-byte hex string into bytes (throws if malformed). */
function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  if (clean.length !== 64) throw new Error('expected 32-byte hex')
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Convert a WAD decimal price string ("64123.5") at `expo` to the UI's fixed-point (decimals dp). */
function wadStringToFixed(price: string, _expo: number, decimals: number): number {
  const n = Number(price)
  return Number.isFinite(n) ? Math.round(n * 10 ** decimals) : 0
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
