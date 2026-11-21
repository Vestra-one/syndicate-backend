import { isLite } from '@/lib/liteMode'
import { formatChips } from '@/lib/format'
import { HAND_FIBS, WIN_FIBS, addFibs, recordHand } from '@/lib/sessionStats'
import { isGuestWallet } from '@/lib/guestWallet'
import { create } from 'zustand'
import type {
  BettingAction,
  Chips,
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
import { DRAND } from '@/lib/protocol'
import type { ServerFrame, WsMatchState, WsAction, WsTurn } from '@/lib/realtime/wsTypes'
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
import { setServerChipsMint } from '@/lib/adapters/live'
import { createGateway, type Gateway } from '@/lib/realtime/gateway'
import { fetchActiveGames, fetchUpcomingGames, fetchHistory } from '@/lib/discovery'
import { isHouseBot, isScheduledTable, setHouseBots } from '@/lib/houseBots'
import { setSeatWallets } from '@/lib/seats'
import { log } from '@/lib/log'
import {
  loadSessionKey,
  newSessionKey,
  saveSessionKey,
  sessionKeyGrantMessage,
  signWithSessionKey,
  type SessionKey,
} from '@/lib/sessionKey'
import { ed25519 } from '@noble/curves/ed25519' // TEMP: seal signature self-verify diagnostic
import { walletBridge } from '@/lib/walletBridge' // TEMP: seal signature diagnostic (wallet name)
import type { PastHand } from '@/lib/protocol'
import { reportFibs } from '@/lib/api'
import {
  api,
  ensureSession,
  ApiError,
  type ApiConfig,
  type CreateIntentResponse,
  type MatchDetail,
  type LeaderboardEntry,
  requestFaucet, requestFees,
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
  amount: Chips // total committed, token base units
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
  walletBalance?: Chips
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

/** The join/create sheet currently open over the Room page (discovery view), if any. */
export type RoomModal = { kind: 'join'; matchId: string } | { kind: 'create' } | null

export type LeaderboardPeriod = 'day' | 'all'

export interface PlayerProfile {
  wallet: string
  handle: string | null
  stats: { tablesPlayed: number; potsWon: number; netChips: Chips; bestPot: Chips | null }
}

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
  chipBalance: Chips | null
  /** Test-chips faucet on this deployment (devnet), or null. */
  faucet: { chips: number } | null
  faucetBusy: boolean
  /** Last faucet outcome, shown next to the button. */
  faucetNote: string | null
  /** Ask the server for test chips (signs in first if needed). */
  getTestChips: () => Promise<void>

  terms: TableTerms | null
  match: MatchStateView | null
  yourTurn: { toCall: number; minRaiseTo: number; deadline: number } | null
  /** The action being signed+sent right now — set the instant a poker button is clicked so
   *  the action panel shows immediate "Sending…" feedback while the wallet signs (§8). */
  actPending: BettingAction | null
  /** Epoch-ms the fill window closes (room voids if under min). Drives the waiting-room countdown. */
  fillDeadline: number | null
  /** Creator-selectable ranges for a new table — buy-in in token base units, fill window in seconds. */
  createLimits: CreateLimits | null
  /** Epoch-ms the current round began — anchors the price-board chart's x-axis to the round. */
  roundStartedAt: number | null
  /** Per-street windows (epoch-ms) from the server's street schedule — streets advance on
   *  this clock, not on betting, so the HUD counts it down instead of looking frozen. */
  streetSchedule: StreetWindow[] | null

  // self-centric, derived from the feed
  sealStatus: SealStatus
  yourPrediction: FixedPrice | null // plaintext, client-only — never sent in the clear
  /** Early lock-in made before the table locks — the drand round (and your engine seat)
   *  only exist once phase → SEALING, so the call is held locally and auto-sealed then. */
  queuedPrediction: FixedPrice | null
  /** The server closed the seal window (§6) — no further seals are accepted. */
  sealClosed: boolean
  /** Engine seats that have sealed so far (from `seal_status`) — powers the "N/5 sealed" strip. */
  sealedSeats: number[]
  /** Epoch-ms the seal window closes (from `seal_status`/`phase`) — drives the in-panel countdown. */
  sealDeadline: number | null
  defaultAction: DefaultAction

  priceHistory: PricePoint[]
  /** Selected timeframe tab on the price cabinet's chart — cabinet-display state only. */
  priceBoardRange: PriceRange
  /** Full-screen BTC/USD analysis chart, launched from the cabinet's brass chart button. */
  priceChartOpen: boolean
  feed: PublicEvent[]
  /** Table talk, newest last (bounded). */
  talk: { seat: number; emote: string; at: number }[]
  /** Send a reaction to the table (seated players only). */
  sendEmote: (emote: string) => Promise<void>
  /** Deal the next table for friends only: hidden from the lobby, joined with a code. */
  privateTable: boolean
  setPrivateTable: (on: boolean) => void
  /** The friends-only table this player holds a seat at (it is not listed anywhere else). */
  myRoom: { code: string; matchId: string } | null
  /** A friends-table code that arrived in a link, waiting for the player to accept it. */
  pendingCode: string | null
  /** The code of the friends-only table we are at (shown to share), if it is one. */
  roomCode: string | null
  /** Take a seat at a friends-only table by its code. */
  joinByCode: (code: string) => Promise<void>
  /** Someone at the table just finished dealt the next one: where to follow them. */
  nextTable: { by: number | null; byWallet?: string; matchId?: string; code?: string } | null
  /** Ask the server whether someone from the finished table has dealt the next one. */
  checkNextTable: () => Promise<void>
  followTable: () => Promise<void>

  settlement: SettlementView | null
  voided: { reason: VoidReason } | null
  reviewing: boolean // resolution dismissed to inspect the final table
  seated: boolean // deposit confirmed → seat taken (gates the lobby)

  // Play Now matchmaking
  playResolving: boolean // true while deciding join-vs-create
  /** Looking for the next house table to sit at (shown as a curtain, not an empty lobby). */
  findingTable: boolean
  /** Chips that just landed from a hand the player had already left. */
  collectNote: { id: string; label: string } | null
  /** Tables (match ids) the connected wallet holds a seat at right now. */
  mySeats: string[]
  /** Back to a table we are seated at (from the lobby). */
  returnToSeat: (matchId: string) => Promise<void>
  playMode: PlayMode | null // resolved action for the current lobby card
  playError: string | null // resolution / commit failure surfaced to the user
  walletError: string | null // wallet-extension connect failure (set by main.tsx's onError, cleared on connect)
  lobbySeated: number | null // seats already taken in the room being joined (from the lobby listing)
  lastTx: { sig: string; label: string } | null // most recent on-chain tx (banner + explorer link)
  txProgress: TxCommit | null // live commit tx being narrated by the waiting ceremony
  pendingInvite: string | null // matchId from a ?table=… deep-link, awaiting the user's accept
  inviteFrom: string | null // the inviter's pseudonymous alias from the deep-link's ?from= param

  // The Room lobby (discovery view): join/create sheet + settled hands + leaderboard + profile
  roomModal: RoomModal
  historyGames: PastHand[]
  historyCursor: string | null
  historyStatus: DiscoveryStatus
  leaderboardPeriod: LeaderboardPeriod
  leaderboard: { entries: LeaderboardEntry[] } | null
  profile: PlayerProfile | null

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
  /** Close the join/create sheet and clear its resolved state. Replaces the old
   *  `backToDashboard` — the Room page never leaves `view: 'discovery'` for this. */
  closeRoomModal: () => void
  connect: () => Promise<void>
  disconnect: () => void
  joinGame: (matchId: string, room?: { code: string; commitment: string }) => Promise<void>
  createGame: () => Promise<void>
  /** Set the buy-in (token base units) for the table being created — clamped to createLimits. */
  setCreateBuyIn: (baseUnits: number) => void
  /** Set the fill window (seconds) for the table being created — clamped to createLimits. */
  setCreateFillWindow: (sec: number) => void
  /** Switch the market (price feed) for the table being created, keeping the host's buy-in & fill window. */
  setCreateFeed: (feed: string) => void
  /** Set the max-seats for the table being created — clamped to createLimits. */
  setCreateSeats: (seats: number) => void
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
  /** Deal the table that just finished again: same market, stakes and seats, one click. */
  rematch: () => Promise<void>
  /** One click from a finished hand to a seat at the open house table (the join sheet). */
  playHouse: (opts?: { sit?: boolean }) => Promise<void>
  /** Out of this hand (folded, or everyone folded to us): go to the next table now and
   *  let this one settle behind us — the chips are collected automatically. */
  moveOn: () => Promise<void>
  /** Walk away from the table to the lobby; a hand in progress settles behind us. */
  leaveHand: () => void

  /** Load a page of settled hands. `more: true` appends the next page via cursor. */
  loadHistory: (opts?: { more?: boolean }) => Promise<void>
  loadLeaderboard: (period?: LeaderboardPeriod) => Promise<void>
  /** Load the connected wallet's profile (handle + stats). No-op when disconnected. */
  loadProfile: () => Promise<void>
  /** Claim a handle for the connected wallet (signs in if needed). */
  saveHandle: (handle: string) => Promise<void>
}

/** One street's scheduled window, epoch-ms. `close` ends betting; `end` includes observation. */
export interface StreetWindow {
  street: number
  open: number
  close: number
  end: number
}

/** Creator-selectable ranges for a new table. */
export interface CreateLimits {
  buyInMin: number
  buyInMax: number
  fillWindowMinSec: number
  fillWindowMaxSec: number
  playersMin: number
  playersMax: number
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
  const playersMin = Math.max(2, b.players.min || 2)
  const playersMax = Math.max(playersMin, b.players.max || 6)
  return { buyInMin, buyInMax, fillWindowMinSec, fillWindowMaxSec, playersMin, playersMax }
}

const ORACLE_UNAVAILABLE_MSG = 'Settlement paused — the price oracle is unavailable. Your funds are safe and fully refundable.'

/** Default street schedule (count + per-street durations/observation) within config bounds. */
function defaultStreets(config: ApiConfig): { count: number; durations_sec: number[]; observation_sec: number[] } {
  const count = clamp(3, config.bounds.streets.min, config.bounds.streets.max)
  // 3 × (60s betting + 10s watching the price) = a 3½-minute hand. The old 3 × (180 + 20)
  // was ten minutes of mostly waiting: a street's betting is usually over in seconds.
  // Same pace as the house tables: 3 × (25s betting + 10s watching) — a hand in under two
  // minutes. Turns that open late in a round borrow from the watching gap.
  const dur = clamp(25, config.bounds.street_duration_sec.min, config.bounds.street_duration_sec.max)
  const obs = clamp(10, config.bounds.observation_sec.min, config.bounds.observation_sec.max)
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
    chipsTokenMint: config.chips_token_mint || undefined,
    decimals: 2,
    oracleAdapter: 'signed-price',
    settlementMode: 'exact-timestamp',
    oracleUnavailableMessage: ORACLE_UNAVAILABLE_MSG,
    buyIn: BigInt(buyIn),
    entryFee: BigInt(d.entry_fee),
    rakeBps: d.rake_bps,
    rakeCap: BigInt(Math.floor(buyIn / 10)), // the server's rule: 10% of the buy-in
    smallBlind: BigInt(Math.max(1, Math.floor(buyIn / 200))),
    bigBlind: BigInt(Math.max(2, Math.floor(buyIn / 100))),
    ante: BigInt(Math.floor(buyIn / 10)),
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
    chipsTokenMint: p.chips_token_mint ?? undefined,
    decimals: 2,
    oracleAdapter: 'signed-price',
    settlementMode: 'exact-timestamp',
    oracleUnavailableMessage: ORACLE_UNAVAILABLE_MSG,
    buyIn: BigInt(p.buy_in),
    entryFee: BigInt(p.entry_fee),
    rakeBps: p.rake_bps,
    rakeCap: BigInt(p.rake_cap),
    smallBlind: BigInt(p.small_blind),
    bigBlind: BigInt(p.big_blind),
    ante: BigInt(p.ante ?? 0),
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
/** The wallet the CURRENT socket is authenticated as (from its `authenticated` frame);
 *  null on a fresh/unauthenticated socket. Acts, seals and defaults need this — spectating
 *  does not. */
let wsAuthedWallet: string | null = null
/** The match whose frames drive the table right now. Match-scoped frames for any other
 *  match are dropped — without this a previous table's `settled` frame put ITS result
 *  screen over the table the player had just created. */
let activeMatchId: string | null = null

/** Everything that belongs to one table. Applied whenever the player starts toward a new
 *  one, so nothing from the last hand (result screen, seal state, feed) leaks into it. */
const FRESH_TABLE = {
  match: null,
  talk: [] as { seat: number; emote: string; at: number }[],
  yourTurn: null,
  actPending: null,
  sealStatus: 'unsealed',
  yourPrediction: null,
  queuedPrediction: null,
  sealClosed: false,
  sealedSeats: [],
  sealDeadline: null,
  settlement: null,
  voided: null,
  reviewing: false,
  feed: [],
  roundStartedAt: null,
  streetSchedule: null,
} satisfies Partial<GameState>

/** Stop following the current table (new table / back to the lobby). */
function leaveActiveMatch() {
  if (activeMatchId) gateway?.send({ t: 'unsubscribe', channel: { match: activeMatchId } })
  activeMatchId = null
  stopMatchPoll()
}

/** Action-chain state for signed betting (§8), reset per match. `head` seeds `prev_head`
 *  for the next `act`; `nonce` increments per action; `engineSeat` is this wallet's seat. */
let actionHead: Uint8Array = new Uint8Array(32)
let actionNonce = 0
let myEngineSeat: number | null = null
// Highest engine `seq` applied to the store — a watchdog reconnect resubscribes from here so
// the server replays only the delta (subscribing from 0 re-delivers the whole history, and the
// transport does no dedup, so every reconnect otherwise reprocessed every past frame).
let lastAppliedSeq = 0
// Highest engine `seq` already APPENDED to the action feed. Kept separate from lastAppliedSeq
// (which a full-state snapshot advances without touching the feed) so a replayed frame can't
// double-append a feed line, while genuinely-new backfill (seq beyond anything appended) still
// shows. The head/pot/nonce updates stay idempotent and unconditional — only the feed dedups.
let lastFeedSeq = 0
// Bounds the on-demand context refresh a Seal click can trigger, so a window that
// never gets its drand round assigned can't hammer REST in a tight retry loop.
let sealContextTries = 0
/**
 * Sign an intent message (act / default / seal) in the wallet-safe TEXT form: the wallet
 * signs `base58(intent_bytes)` as an ASCII string. Browser wallets (MetaMask observed)
 * transform raw binary payloads before signing — proven by local ed25519 verification —
 * but sign display-safe text verbatim; the server's `verify_ed25519` accepts a signature
 * over either the raw bytes or their base58 text (see BACKEND-HANDOFF.md / verify.rs).
 *
 * VITE_DEV_SIGNATURES=1 sends a `sig-` placeholder instead (no wallet prompt) — honored
 * only when the server sets SYNDICATE_ALLOW_DEV_SIGNATURES=1 (devnet).
 */
const DEV_SIGNATURES = (import.meta.env.VITE_DEV_SIGNATURES as string | undefined) === '1'
let devSigCounter = 0

/** This match's session key ("one-tap play") once the wallet has granted it. */
let sessionKey: SessionKey | null = null
/** In-flight grant, so concurrent callers share one wallet prompt. */
let sessionKeyGrant: Promise<SessionKey | null> | null = null
/** The player dismissed the grant prompt (or the server has no session keys) for this
 *  match — don't nag; fall back to signing each intent with the wallet. */
let sessionKeyUnavailableFor: string | null = null

/**
 * Get this match's session key, asking the wallet for the one-time grant if needed. Returns
 * null when one-tap play is unavailable (old server, prompt dismissed) — callers then sign
 * with the wallet as before, so nothing depends on it.
 */
async function ensureSessionKey(matchId: string, onchainMatchId: string): Promise<SessionKey | null> {
  if (DEV_SIGNATURES || !adapters) return null
  const wallet = adapters.wallet.address()
  if (!wallet) return null
  const usable = (k: SessionKey | null) =>
    !!k && k.matchId === matchId && k.wallet === wallet && k.expiresAt - 60_000 > Date.now()
  if (usable(sessionKey)) return sessionKey
  const stored = loadSessionKey(matchId, wallet)
  if (stored) return (sessionKey = stored)
  if (sessionKeyUnavailableFor === matchId) return null
  if (sessionKeyGrant) return sessionKeyGrant

  const wal = adapters.wallet
  sessionKeyGrant = (async () => {
    try {
      const config = await api.getConfig()
      adoptServerConfig(config)
      if (!config.session_keys) {
        sessionKeyUnavailableFor = matchId
        return null
      }
      const key = newSessionKey(matchId, wallet)
      const signature = await wal.signMessageBase64(
        sessionKeyGrantMessage(onchainMatchId, wallet, key.pubkey, key.expiresAt),
      )
      await api.registerSessionKey(matchId, {
        session_pubkey: bs58.encode(key.pubkey),
        expires_at: key.expiresAt,
        signature,
      })
      saveSessionKey(key)
      sessionKey = key
      log.info('[session-key] one-tap play enabled for match', matchId)
      return key
    } catch (err) {
      log.warn('[session-key] grant failed — falling back to wallet signatures:', err)
      sessionKeyUnavailableFor = matchId
      return null
    } finally {
      sessionKeyGrant = null
    }
  })()
  return sessionKeyGrant
}

/**
 * Sign an intent (act / default / seal). With a session key this is silent and instant —
 * the key signs the raw intent bytes. Otherwise the wallet signs the wallet-safe TEXT form
 * (`base58(intent_bytes)`): browser wallets mangle raw binary payloads but sign display-safe
 * text verbatim, and the server accepts a signature over either form.
 */
async function signIntent(msg: Uint8Array): Promise<string> {
  if (DEV_SIGNATURES) return `sig-dev-${++devSigCounter}`
  if (!adapters) throw new Error('adapters not ready')
  const st = useGameStore.getState()
  const matchId = st.match?.matchId ?? joinMatchId
  const onchainMatchId = st.terms?.onchainMatchId
  if (matchId && onchainMatchId) {
    const key = await ensureSessionKey(matchId, onchainMatchId)
    if (key) return signWithSessionKey(key, msg)
  }
  return adapters.wallet.signMessageBase64(bs58.encode(msg))
}

// One-shot latch for the live-start default registration (mints journal event seq 1).
let defaultArmed = false
function resetActionChain() {
  actionHead = new Uint8Array(32)
  actionNonce = 0
  myEngineSeat = null
  lastAppliedSeq = 0
  lastFeedSeq = 0
  defaultArmed = false
  sealContextTries = 0
  sessionKey = null
  sessionKeyUnavailableFor = null
}

/**
 * Learn the engine's action-chain head. Servers ≥ "wallet signing fixes" serve the LIVE
 * head in the match detail (event_cursor) — prefer it; it covers the genesis-only case
 * (the MatchStarted event is seq 0, which the journal API can never return). Fall back to
 * the newest journal event's hash for older servers.
 */
async function syncActionHead(matchId: string): Promise<boolean> {
  try {
    const detail = await api.getMatch(matchId)
    if (detail.head && !/^0+$/.test(detail.head)) {
      actionHead = hexToBytes32(detail.head)
      actionNonce = Math.max(actionNonce, detail.last_seq ?? 0)
      return true
    }
  } catch {
    /* fall through to the journal */
  }
  try {
    const { events } = await api.getEvents(matchId) // whole journal incl. genesis (seq 0)
    const last = events.at(-1)
    if (!last) return false
    actionHead = hexToBytes32(last.hash)
    actionNonce = Math.max(actionNonce, last.seq)
    return true
  } catch (err) {
    log.warn('[head] journal sync failed:', err)
    return false
  }
}

/**
 * Make the action chain signable at live start. On an unpatched server the snapshot's
 * `head` is a stale DB copy and genesis (seq 0) is unfetchable, so when the journal shows
 * nothing we register our default policy — the ONLY signed intent with no prev_head
 * requirement — which appends journal event seq 1; its hash is then the true head and
 * acts can finally flow. (First act of every match was otherwise rejected with
 * "prev_head mismatch" — unlearnable head, see BACKEND-HANDOFF.md.)
 */
async function armActionChain(get: () => GameState): Promise<void> {
  const matchId = get().match?.matchId ?? joinMatchId
  if (!matchId) return
  if (await syncActionHead(matchId)) return
  if (defaultArmed) return
  defaultArmed = true
  log.info('[head] journal empty — registering default policy to mint a fetchable event')
  get().setDefault(get().defaultAction)
}

/**
 * Make sure the socket can carry a signed gameplay frame for the connected wallet: open AND
 * authenticated as that wallet. `gateway.send` silently drops frames on a closed socket and
 * the server rejects acts from an unauthenticated one, and either way the turn was burning
 * down with the panel already cleared. So before signing: wait out an auth that is still in
 * flight; if the socket is dead or was never authenticated (challenge prompt dismissed,
 * dropped connection), rebuild it and resubscribe — silent when a session token exists.
 */
async function ensureActionSocket(get: () => GameState, matchId: string): Promise<boolean> {
  const wallet = adapters?.wallet.address() ?? null
  if (!wallet) return false
  const ready = () => !!gateway?.isOpen() && wsAuthedWallet === wallet
  const waitReady = async (ms: number) => {
    for (let waited = 0; waited < ms && !ready(); waited += 100) await new Promise((r) => setTimeout(r, 100))
    return ready()
  }
  if (ready()) return true
  if (gateway?.isOpen() && (await waitReady(1500))) return true
  log.warn('[ws] socket not ready for a signed frame — reconnecting')
  if (gateway) {
    unsub?.()
    gateway.disconnect()
    gateway = null
    unsub = null
  }
  await get().connect()
  // `connect()` reassigned the module-level gateway (TS narrowed it to null above).
  const fresh = gateway as Gateway | null
  fresh?.send({ t: 'subscribe', channel: { match: matchId }, last_seq: lastAppliedSeq })
  return waitReady(6000)
}

/** Subscribe the open socket to a match channel — server replies with a snapshot then the
 *  ordered event stream (gap-free, dedup by seq). Pass `lastSeq` to fetch only the delta. */
function subscribeMatch(matchId: string, lastSeq = 0) {
  // One table at a time: leave the previous match's channel so its late frames (a
  // settlement that lands while the player is already at a new table) stop arriving.
  if (activeMatchId && activeMatchId !== matchId) {
    gateway?.send({ t: 'unsubscribe', channel: { match: activeMatchId } })
  }
  activeMatchId = matchId
  gateway?.send({ t: 'subscribe', channel: { match: matchId }, last_seq: lastSeq })
  startMatchPoll()
  // Immediate pre-lock fill-count read so the counter is right on entry instead of waiting for
  // the first poll (or an unreliable WS `seat_update`). Harmless post-lock: the room drops off
  // the lobby listing, so the reconcile no-ops.
  void reconcileFillCount(matchId, useGameStore.setState as SetState)
}

// The devnet gateway journals engine events but has been observed broadcasting NONE of
// them — street closes, settlement, even phase moves reach a subscribed client as pure
// silence while the match runs on. Poll the REST detail as a safety net while a table is
// open, so the HUD self-heals instead of showing "LIVE" forever after the match settled.
const MATCH_POLL_MS = 10_000
/** While your own seat is still unresolved after the lock, look every couple of seconds. */
const SEAT_POLL_MS = 2_000
let matchPoll: ReturnType<typeof setInterval> | null = null
function startMatchPoll() {
  stopMatchPoll()
  matchPoll = setInterval(() => {
    const s = useGameStore.getState()
    if (s.view !== 'table' || s.settlement || s.voided) return stopMatchPoll()
    // Watchdog: the transport has no auto-reconnect, so a dropped socket silently eats
    // every broadcast (your_turn included). Rebuild + resubscribe the moment it's noticed.
    if (gateway && !gateway.isOpen()) {
      log.warn('[ws] socket dead — reconnecting and resubscribing')
      void s.connect().then(() => {
        const matchId = useGameStore.getState().match?.matchId ?? joinMatchId
        // Resume from the last applied seq — the server replays only what we missed.
        if (matchId) gateway?.send({ t: 'subscribe', channel: { match: matchId }, last_seq: lastAppliedSeq })
      })
    }
    void refreshMatchSeats(useGameStore.setState as SetState, useGameStore.getState)
  }, MATCH_POLL_MS)
  // The seat number is what lets you seal and act. If the lock's own frames were missed
  // (slow device, dropped socket), do not wait ten seconds for it.
  seatPoll = setInterval(() => {
    const s = useGameStore.getState()
    if (s.view !== 'table' || s.settlement || s.voided) return
    const locked = s.match?.phase === 'SEALING' || s.match?.phase === 'LIVE'
    if (s.seated && locked && s.match?.yourSeat == null) {
      void refreshMatchSeats(useGameStore.setState as SetState, useGameStore.getState)
    }
  }, SEAT_POLL_MS)
}
let seatPoll: ReturnType<typeof setInterval> | null = null
function stopMatchPoll() {
  if (seatPoll) {
    clearInterval(seatPoll)
    seatPoll = null
  }
  if (matchPoll) {
    clearInterval(matchPoll)
    matchPoll = null
  }
}

/** REST context for the CREATE flow: server config (for building the intent), the chosen
 *  feed, and the reserved intent once `/v1/rooms/intents` has returned it. */
let createCtx: { config: ApiConfig; feed: string; intent: CreateIntentResponse | null } | null = null
/** The match UUID we resolved to JOIN — target of the deposit POST + candidate polling. */
/** Friends-only table we are joining: its code and our proof of knowing it. */
let roomJoin: { code: string; commitment: string } | null = null
/** The table a rematch was dealt from (told where the next one is once it exists). */
let rematchFrom: string | null = null
let joinMatchId: string | null = null

/** The drand beacon the SERVER decrypts against (`GET /v1/config`.drand). The seal must
 *  time-lock against THIS beacon, not a hardcoded one: encrypting to a different drand chain
 *  yields a ciphertext the settlement worker can't open ("ciphertext failed to decrypt" →
 *  the match is voided). Cached on first config load; lazily fetched for joiners (who don't
 *  hit the create path). Falls back to the compiled-in quicknet constant only if config is
 *  unreachable. */
let serverDrand: ApiConfig['drand'] | null = null
/** Remember what `GET /v1/config` told us: the drand beacon to seal against and the
 *  operator's default chip mint (so balances/deposits never depend on a build-time env). */
function adoptServerConfig(config: ApiConfig) {
  serverDrand = config.drand
  setServerChipsMint(config.chips_token_mint)
  setHouseBots(config.house_bot_wallets)
  useGameStore.setState({ faucet: config.faucet ? { chips: config.faucet.chips } : null })
}
let serverConfigLoad: Promise<void> | null = null
/** Load the server config once (deduped); failures are retried on the next call. */
function ensureServerConfig(): Promise<void> {
  if (serverDrand) return Promise.resolve()
  serverConfigLoad ??= api.getConfig()
    .then(adoptServerConfig)
    .catch((e) => log.warn('[config] server config fetch failed:', e))
    .finally(() => { serverConfigLoad = null })
  return serverConfigLoad
}
async function resolveDrand(): Promise<{ chainHash: string; api: string }> {
  if (!serverDrand) await ensureServerConfig()
  if (!serverDrand) log.warn('[seal] drand config unavailable, using fallback beacon')
  return serverDrand
    ? { chainHash: serverDrand.chain_hash, api: serverDrand.api }
    : { chainHash: DRAND.chainHash, api: DRAND.api }
}

/** Auto-resume latch, keyed by wallet: dedupes autoConnect re-fires for the SAME wallet, but
 *  a wallet switch (new address) re-attempts instead of being stuck on the first wallet. */
let resumedForWallet: string | null = null

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

/** Map a raw chain error to friendly copy for the simple money actions (claim/refund/reclaim). */
function friendlyChainError(err: unknown): Error {
  if (err instanceof ApiError) return err
  const msg = err instanceof Error ? err.message : String(err)
  if (/User rejected|rejected the request|denied|declined|cancell?ed/i.test(msg)) {
    return new Error('You dismissed the approval in your wallet — nothing was sent.')
  }
  if (/AlreadyClaimed/i.test(msg)) return new Error('This payout was already claimed.')
  return err instanceof Error ? err : new Error(msg)
}

/**
 * The single path for a wallet-signed, one-shot on-chain money action (claim/refund). Runs
 * the instruction, records the tx for the banner + explorer link, and forces a post-finality
 * balance refresh. Errors are logged + classified here, then RE-THROWN so the calling UI can
 * surface them and re-enable its button — this is what keeps every money action failing the
 * same way (see the H3-class "button bricks on rejection" bug). Returns null if no adapter.
 */
async function runChainAction(
  set: SetState,
  label: string,
  run: (chain: Adapters['chain']) => Promise<string>,
): Promise<string | null> {
  if (!adapters) return null
  try {
    const sig = await run(adapters.chain)
    set({ lastTx: { sig, label } })
    void refreshBalance(set, true) // balance moved on-chain — force past the throttle
    return sig
  } catch (err) {
    log.warn(`[chain] ${label} failed:`, rawErrorText(err))
    throw friendlyChainError(err)
  }
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
  log.warn(`[tx:${kind}] commit failed — ${code}:`, raw)

  let walletBalance: Chips | undefined
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
    log.warn('[session] auth failed:', err)
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
  talk: [],
  faucet: null,
  faucetBusy: false,
  faucetNote: null,

  terms: null,
  match: null,
  yourTurn: null,
  actPending: null,
  fillDeadline: null,
  createLimits: null,
  roundStartedAt: null,
  streetSchedule: null,

  sealStatus: 'unsealed',
  yourPrediction: null,
  queuedPrediction: null,
  sealClosed: false,
  sealedSeats: [],
  sealDeadline: null,
  defaultAction: 'check_fold',

  priceHistory: [],
  priceBoardRange: '1m',
  priceChartOpen: false,
  feed: [],

  settlement: null,
  voided: null,
  reviewing: false,
  seated: false,

  mySeats: [],
  collectNote: null,
  findingTable: false,
  playResolving: false,
  playMode: null,
  playError: null,
  walletError: null,
  lobbySeated: null,
  lastTx: null,
  txProgress: null,
  pendingInvite: null,
  inviteFrom: null,

  roomModal: null,
  historyGames: [],
  historyCursor: null,
  historyStatus: 'idle',
  leaderboardPeriod: 'all',
  leaderboard: null,
  profile: null,

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
      ensureServerConfig(), // house-bot wallets, so the lobby can label the house table
    ])
    const active = activeResult.status === 'fulfilled' ? activeResult.value : []
    const upcoming = upcomingResult.status === 'fulfilled' ? upcomingResult.value : []
    if (activeResult.status === 'rejected') log.warn('active-games fetch failed:', activeResult.reason)
    if (upcomingResult.status === 'rejected') log.warn('upcoming-games fetch failed:', upcomingResult.reason)
    // Only surface error if BOTH endpoints fail.
    if (activeResult.status === 'rejected' && upcomingResult.status === 'rejected') {
      // A transient blip on a background poll shouldn't blank a working lobby — keep the last-good list.
      if (!silent) set({ activeGames: [], upcomingGames: [], discoveryStatus: 'error' })
    } else {
      set({ activeGames: active, upcomingGames: upcoming, discoveryStatus: 'ready', discoveryUpdatedAt: Date.now() })
      // Which of these tables is the player sitting at? The lobby must say so.
      const me = adapters?.wallet.address() ?? get().walletAddress
      if (me) {
        void api.getActive(me)
          .then((r) => set({ mySeats: r.active.filter((a) => a.phase in RESUME_PHASE_RANK).map((a) => a.match_id) }))
          .catch(() => {})
      }
    }
  },

  /**
   * Push a spot tick from the always-on price feed into the chart history (§2).
   * The gateway's feedPrice only becomes authoritative once the hand is LIVE (it
   * rides in on `action` frames). Through FILLING *and* SEALING no gateway price
   * flows, so the spot feed must keep the chart — and the seal panel's live price
   * (which seeds the seal input) — alive; otherwise the Seal button stays disabled.
   */
  ingestLivePrice: (price, ts) => {
    // The spot feed drives the chart in every phase of a hand. It used to step aside once
    // the hand was LIVE in favour of the price riding on action frames — which only arrive
    // when someone acts, so the "live" price sat still through every think, every gap and
    // the whole run to settlement, then jumped. Only a finished hand stops the tape.
    const m = get().match
    if (m && (m.phase === 'SETTLED' || m.phase === 'VOID')) return
    set((s) => ({ priceHistory: [...s.priceHistory, { price, ts }].slice(-MAX_HISTORY) }))
  },

  setPriceBoardRange: (range) => set({ priceBoardRange: range }),
  // Never over the seal box: while a number still has to be sealed the big chart stays shut.
  openPriceChart: () => { const st = get(); if (isLite() || st.yourTurn || (st.match?.phase === 'SEALING' && st.yourPrediction == null)) return; set({ priceChartOpen: true }) },
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
    if (resumedForWallet === wallet) return
    resumedForWallet = wallet
    if (pendingCollects(wallet).length > 0) {
      if (!adapters) adapters = createAdapters()
      startCollector(set, get)
    }
    // Don't hijack an explicit flow: a ?table=… invite, or a join/create in progress.
    const s = get()
    if (s.view !== 'discovery' || s.seated || s.playResolving || s.pendingInvite) return
    set({ walletAddress: wallet })

    let seat: { match_id: string; phase: string } | undefined
    try {
      const { active } = await api.getActive(wallet)
      seat = active
        // A hand we already walked away from settles on its own — never drag the player back.
        .filter((a) => a.phase in RESUME_PHASE_RANK && !pendingCollects(wallet).some((c) => c.matchId === a.match_id))
        .sort((a, b) => RESUME_PHASE_RANK[a.phase] - RESUME_PHASE_RANK[b.phase])[0]
    } catch (err) {
      log.warn('[resume] active-seats lookup failed:', err)
      return
    }
    if (!seat) return
    // The user may have clicked Play Now while we awaited — re-check before taking over.
    if (get().view !== 'discovery' || get().seated || get().playResolving) return

    log.info('[resume] found active seat — match', seat.match_id, 'phase', seat.phase)
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
        sealDeadline: detail.timing.seal_deadline != null ? toEpochMs(detail.timing.seal_deadline) : null,
      })
    } catch (err) {
      log.warn('[resume] match detail failed — staying on dashboard:', err)
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
    set({ view: 'table', match: null, feed: [], priceHistory: [], settlement: null, voided: null, streetSchedule: null })
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
   * Close the join/create sheet (pre-seat) and stay on the Room page. The cached REST
   * session (24h Bearer) persists, so the next create/join skips the wallet-signed nonce
   * handshake. Leaves the gateway connected (cheap; `terms` is cleared so any stray
   * `seat_update` for the abandoned room is harmless).
   */
  closeRoomModal: () => {
    joinMatchId = null
    createCtx = null
    leaveActiveMatch()
    set({
      roomModal: null,
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
  },

  /** Join a FILLING game by its match UUID — opens the join sheet immediately (resolving
   *  spinner), then connects the wallet, opens a REST session, and loads the match detail
   *  (§5). Stays on the Room page throughout (§ locked decision: in-page modals). */
  joinGame: async (matchId: string, room?: { code: string; commitment: string }) => {
    if (!adapters) adapters = createAdapters()
    joinMatchId = null
    createCtx = null
    roomJoin = room ?? null
    leaveActiveMatch()
    set({
      ...FRESH_TABLE,
      playError: null, pendingInvite: null, inviteFrom: null, nextTable: null, roomCode: room?.code ?? null,
      roomModal: { kind: 'join', matchId }, playResolving: true, playMode: null,
      terms: null, seated: false, lobbySeated: null,
    })

    try {
      const addr = await adapters.wallet.connect()
      set({ walletAddress: addr })
    } catch {
      set({ playResolving: false, playError: 'Wallet connection was cancelled.' })
      return
    }

    set({ status: 'connecting' })
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

  /** Create a new game — opens the create sheet immediately, then connects the wallet,
   *  opens a REST session, and loads `GET /v1/config` (the intent is reserved later, in
   *  createTable). Stays on the Room page throughout. */
  createGame: async () => {
    if (!adapters) adapters = createAdapters()
    joinMatchId = null
    createCtx = null
    leaveActiveMatch()
    set({
      ...FRESH_TABLE,
      playError: null,
      roomModal: { kind: 'create' }, playResolving: true, playMode: null,
      terms: null, seated: false, lobbySeated: null,
    })

    try {
      const addr = await adapters.wallet.connect()
      set({ walletAddress: addr })
    } catch {
      set({ playResolving: false, playError: 'Wallet connection was cancelled.' })
      return
    }

    set({ status: 'connecting' })
    const wallet = adapters.wallet.address()
    if (!wallet || !(await ensureRestSession(adapters, wallet, set))) {
      set({ playResolving: false, playError: 'Could not reach the table server (sign-in failed).' })
      return
    }

    try {
      const config = await api.getConfig()
      adoptServerConfig(config)
      const feed = config.feeds[0]?.feed ?? 'BTC/USD'
      createCtx = { config, feed, intent: null }
      const limits = configToCreateLimits(config)
      const base = configToTerms(config, feed)
      set({
        terms: {
          ...base,
          // Seed the host's editable choices with in-range defaults.
          buyIn: BigInt(clamp(Number(base.buyIn), limits.buyInMin, limits.buyInMax)),
          fillWindowSec: clamp(base.fillWindowSec ?? limits.fillWindowMinSec, limits.fillWindowMinSec, limits.fillWindowMaxSec),
          maxPlayers: clamp(base.maxPlayers, limits.playersMin, limits.playersMax),
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
    const buyIn = BigInt(clamp(Math.round(baseUnits), s.createLimits.buyInMin, s.createLimits.buyInMax))
    return { terms: { ...s.terms, buyIn } }
  }),

  setCreateFillWindow: (sec) => set((s) => {
    if (!s.terms || !s.createLimits) return {}
    const fillWindowSec = clamp(Math.round(sec), s.createLimits.fillWindowMinSec, s.createLimits.fillWindowMaxSec)
    return { terms: { ...s.terms, fillWindowSec } }
  }),

  setCreateSeats: (seats) => set((s) => {
    if (!s.terms || !s.createLimits) return {}
    const maxPlayers = clamp(Math.round(seats), Math.max(2, s.createLimits.playersMin), s.createLimits.playersMax)
    const minPlayers = Math.min(s.terms.minPlayers, maxPlayers)
    return { terms: { ...s.terms, maxPlayers, minPlayers } }
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
        rakeCap: s.terms.buyIn / 10n,
        smallBlind: BigInt(Math.max(1, Math.floor(Number(s.terms.buyIn) / 200))),
        bigBlind: BigInt(Math.max(2, Math.floor(Number(s.terms.buyIn) / 100))),
        fillWindowSec: s.terms.fillWindowSec,
        maxPlayers: s.terms.maxPlayers,
        minPlayers: s.terms.minPlayers,
      },
    }
  }),

  /** Open the v2 WebSocket (idempotent). Spectate needs no wallet; if one is connected the
   *  transport answers the auth challenge so the same socket can also act/seal (§12). */
  connect: async () => {
    if (gateway?.isOpen()) return
    if (gateway) {
      // A gateway exists but its socket is dead (server closed it, idle drop, HMR orphan).
      // The old early-return here left the app "connected" to nothing — every broadcast,
      // your_turn included, went nowhere while the UI just looked quiet. Rebuild instead.
      log.warn('[ws] stale socket — rebuilding connection')
      unsub?.()
      gateway.disconnect()
      gateway = null
      unsub = null
    }
    set({ status: 'connecting' })
    if (!adapters) adapters = createAdapters()
    // Capture the instance locally — `gateway` (module-global) can be reassigned by a
    // StrictMode unmount/remount across the await; act on the instance we created.
    const gw = createGateway(adapters)
    gateway = gw
    wsAuthedWallet = null // a new socket starts unauthenticated
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
      log.error('gateway connect failed:', err)
      set({ status: 'offline' })
    }
  },

  disconnect: () => {
    stopMatchPoll()
    activeMatchId = null
    unsub?.()
    gateway?.disconnect()
    gateway = null
    unsub = null
    wsAuthedWallet = null
    adapters = null
    joinMatchId = null
    createCtx = null
    set({
      status: 'offline',
      match: null,
      yourTurn: null,
      actPending: null,
      sealStatus: 'unsealed',
      yourPrediction: null,
      queuedPrediction: null,
      sealClosed: false,
      sealedSeats: [],
      sealDeadline: null,
      settlement: null,
      voided: null,
      seated: false,
      playMode: null,
      playResolving: false,
      playError: null,
      lobbySeated: null,
      fillDeadline: null,
      createLimits: null,
      streetSchedule: null,
    })
  },

  /** Take your seat: deposit buy-in + entry fee into an OPEN table (§7). */
  joinTable: async () => {
    const { match, terms, seated } = get()
    if (!adapters || !terms || seated) return
    await ensureFees()

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
        log.info('[joinTable] wallet already deposited (engineSeat', existing.engineSeat, 'confirmed', existing.confirmed, ') — entering table')
        set({ seated: true, view: 'table', roomModal: null })
        void refreshBalance(set)
        // The chips are in, but the server may never have heard (a reload between the
        // transaction and the report). An unreported deposit is a seat the table deals
        // without — so report it again; the server treats a repeat as a no-op.
        if (!existing.confirmed) {
          const sig = recallDeposit(matchId) ?? (await adapters.chain.findDepositSig(onchainMatchId).catch(() => null))
          if (sig) void reportDeposit(matchId, sig, set)
        }
        resetActionChain()
        await get().connect()
        subscribeMatch(matchId)
        return
      }
    } catch (err) {
      // A read failure here isn't fatal — fall through to the deposit attempt.
      log.warn('[joinTable] seat pre-check failed:', err)
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
      const txSig = await adapters.chain.deposit(matchId, roomJoin?.commitment, terms.buyIn + terms.entryFee, txProgressCallback(set))
      set((s) => ({
        lastTx: { sig: txSig, label: 'Deposit confirmed on-chain' },
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'confirmed', sig: txSig } : null,
        // Hand off to the table view; the ceremony (mounted at the app root) keeps
        // narrating its "you're in" beat across the flip, then dismisses itself.
        view: 'table',
        roomModal: null,
      }))
      // Report the deposit txhash so the backend RPC-verifies it into a candidate (§5).
      // Capital safety never depends on this — an unheard-of deposit is still refundable.
      rememberDeposit(matchId, txSig)
      void reportDeposit(matchId, txSig, set)
      // Open the WS + subscribe so the waiting room / live play get seat/phase/turn pushes.
      resetActionChain()
      await get().connect()
      subscribeMatch(matchId)
      void refreshBalance(set)
      // One-tap play: ask for the session-key grant now, while the table is still filling,
      // so the seal and every bet later need no wallet prompt.
      void ensureSessionKey(matchId, onchainMatchId)
    } catch (err) {
      await failCommit(set, err, 'join')
    }
  },

  /** Host create: open a new table on-chain and seat yourself (§7). */
  createTable: async () => {
    const { seated, terms } = get()
    if (!adapters || !createCtx || !terms || seated) return
    await ensureFees()
    const { config, feed } = createCtx

    // The host may have edited buy-in / fill window in the create Lobby (§4) — clamp to bounds.
    // Keep a number copy for the wire (the intent request is JSON u64s) and a bigint for the commit.
    const limits = get().createLimits
    const buyInNum = limits ? clamp(Number(terms.buyIn), limits.buyInMin, limits.buyInMax) : Number(terms.buyIn)
    const buyIn = BigInt(buyInNum)
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
        buy_in: buyInNum,
        fill_window_sec: fillWindowSec,
        min_players: terms.minPlayers,
        max_players: terms.maxPlayers,
        streets: { count: streets.count, durations_sec: streets.durations_sec, observation_sec: streets.observation_sec },
        visibility: get().privateTable ? 'private' : 'public',
      })
      roomJoin = null
      set({ roomCode: intent.room_code ?? null })
      createCtx = { config, feed, intent }
      const cp = intent.create_params

      // 2. Sign + send create_and_deposit built from the SERVER's create_params (config_hash,
      //    price_token, room_commitment, oracle params all come from the backend).
      const { txSig, matchPda } = await adapters.chain.createAndDeposit({
        onchainMatchId: String(cp.match_id),
        chipsTokenMint: intent.chips_token_mint,
        configHash: cp.config_hash,
        priceTokenHex: cp.price_token,
        buyIn: BigInt(cp.buy_in),
        entryFee: BigInt(cp.entry_fee),
        rakeBps: cp.rake_bps,
        rakeCap: BigInt(cp.rake_cap),
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
        log.info('[createTable] room registered — match_id:', room.match_id, 'seat_status:', room.seat_status)
      } catch (e) {
        log.warn('[createTable] submitRoom failed (room still refundable on-chain):', e)
      }

      // Record the on-chain ids so subsequent ix (seal/claim) derive the right PDAs.
      set((s) => ({
        terms: s.terms
          ? { ...s.terms, onchainMatchId: String(cp.match_id), matchPda, chipsTokenMint: intent.chips_token_mint ?? s.terms.chipsTokenMint }
          : s.terms,
        lastTx: { sig: txSig, label: 'Table created on-chain' },
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'confirmed', sig: txSig } : null,
        fillDeadline: Date.now() + cp.fill_window_sec * 1000,
        // Hand off to the table view; the ceremony (mounted at the app root) keeps
        // narrating its "your table is live" beat across the flip, then dismisses itself.
        view: 'table',
        roomModal: null,
      }))
      // Open the WS + subscribe to the new match so the waiting room gets live seat/phase pushes.
      if (matchUuid) {
        resetActionChain()
        await get().connect()
        subscribeMatch(matchUuid)
        void ensureSessionKey(matchUuid, String(cp.match_id)) // one-tap play (see joinTable)
      }
      // Dealt as a rematch: tell the table we just left where the next hand is, so the
      // same people can follow with one click instead of hunting for a link.
      if (intent.room_code && matchUuid) set({ myRoom: { code: intent.room_code, matchId: matchUuid } })
      if (rematchFrom) {
        const where = intent.room_code ? `next:code:${intent.room_code}` : matchUuid ? `next:${matchUuid}` : null
        if (where) gateway?.send({ t: 'emote', match_id: rematchFrom, emote: where })
        rematchFrom = null
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
    if (!adapters || !terms || sealStatus !== 'unsealed' || sealClosed) {
      // seal-once — but log why so a no-op click in the seal window is never a silent mystery.
      log.warn('[seal] click ignored', {
        hasAdapters: !!adapters, hasTerms: !!terms, sealStatus, sealClosed,
      })
      return
    }
    const targetRound = terms.timelockTargetRound
    const seatIndex = myEngineSeat ?? match?.yourSeat
    if (!targetRound || seatIndex == null || !match) {
      // The drand round + engine seat are assigned when the table locks (phase → SEALING).
      // Hold the call locally; ensureSealContext auto-seals it the moment the window opens.
      const windowOpen = match?.phase === 'SEALING' && !sealClosed
      log.warn('[seal] context not ready — holding prediction locally', {
        targetRound, seatIndex, hasMatch: !!match, phase: match?.phase, windowOpen,
      })
      set({
        queuedPrediction: price,
        // Pre-lock (WaitingRoom) this is expected and the room shows the "locked in" state.
        // But if the seal window is already open, silence reads as a dead button — say so,
        // and pull the missing round/seat from REST so the queued call can auto-fire. The
        // usual cause here is the server not having assigned the drand round yet (targetRound 0).
        playError: windowOpen
          ? (!targetRound
              ? 'Waiting for the server to assign the seal round — your prediction is saved and will seal automatically once it does.'
              : 'Preparing the seal window — your prediction is saved and will seal in a moment.')
          : get().playError,
      })
      if (windowOpen && sealContextTries < 4) {
        sealContextTries++
        void ensureSealContext(set, get)
      }
      return
    }
    const onchainMatchId = terms.onchainMatchId
    const wallet = adapters.wallet.address()
    if (!onchainMatchId || !wallet) {
      log.warn('[seal] missing context', { onchainMatchId, targetRound, seatIndex })
      set({ playError: 'Sealing is not ready yet — wait for the seal window to open.' })
      return
    }
    set({ sealStatus: 'sealing' })
    try {
      // 1. Time-lock encrypt the WAD price, derive ciphertext_b64 + commitment = sha256(ct).
      const decimals = terms.decimals ?? 2
      const priceWad = BigInt(Math.round(price)) * 10n ** BigInt(18 - decimals)
      const drand = await resolveDrand()
      const ciphertext = await adapters.tlock.seal(priceWad, targetRound, drand.chainHash, drand.api)
      const ciphertextB64 = btoa(String.fromCharCode(...ciphertext))
      const commitment = await ciphertextCommitment(ciphertext)
      const commitmentHex = bytesToHex(commitment)

      // 2. Register the commitment on-chain (the strong seal proof).
      // The program only accepts a commitment while the account is Sealing. Two races make a
      // raw `BadStatus` here otherwise: the `phase:sealing` WS push can beat the lock tx's
      // propagation to our RPC node (status still Filling), and a slow seal can miss the
      // window (status already Live). Poll briefly for Sealing and give a clear message.
      let chainStatus = (await adapters.chain.getMatchStatus(onchainMatchId))?.status
      for (let i = 0; chainStatus === 'FILLING' && i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        chainStatus = (await adapters.chain.getMatchStatus(onchainMatchId))?.status
      }
      if (chainStatus !== 'SEALING') {
        log.warn('[seal] on-chain not Sealing at register time', { chainStatus })
        set({
          sealStatus: 'unsealed',
          playError: chainStatus === 'FILLING'
            ? 'The table is still locking on-chain — wait a moment and seal again.'
            : 'The on-chain seal window has already closed for this match.',
        })
        return
      }
      let sealTxSig: string
      try {
        sealTxSig = await adapters.chain.registerPredictionCommitment(onchainMatchId, commitmentHex, targetRound)
      } catch (e) {
        log.error('[seal] on-chain register failed:', e)
        set({ sealStatus: 'unsealed', playError: 'Could not register your sealed prediction on-chain.' })
        return
      }

      // 3. Sign the seal-intent message and submit the ciphertext to the backend (§7 / App. B).
      // TEMP DIAGNOSTIC — the backend rebuilds this message from match_seats.seat_index + its
      // session wallet; log what WE sign so a mismatch (seat_index, or connected wallet ≠ the
      // session wallet the backend verifies against) is visible when submit returns 401.
      log.info('[seal] signing intent', {
        onchainMatchId, seatIndex, myEngineSeat, yourSeat: match.yourSeat,
        connectedWallet: wallet, sessionWallet: get().walletAddress,
        targetRound, commitmentHex,
      })
      const msg = predictionCommitmentMessage({
        matchId: BigInt(onchainMatchId),
        onchainMatchId: BigInt(onchainMatchId),
        seatIndex,
        seatPubkey: bs58.decode(wallet),
        timelockTarget: targetRound,
        commitment,
      })
      const signature = await signIntent(msg)
      // TEMP DIAGNOSTIC — dump the exact signed bytes + self-verify the signature against our own
      // pubkey. selfVerify=true ⇒ the signature is valid over THIS message, so a 401 is a backend
      // problem (deployed format drift, or it rebuilds a different message). selfVerify=false ⇒
      // the wallet adapter signed different bytes than `msg` (an FE/wallet signing bug).
      let selfVerify: boolean | string = 'n/a'
      let verifyUtf8: boolean | string = 'n/a'
      let verifyBase58: boolean | string = 'n/a'
      try {
        const sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0))
        const pk = bs58.decode(wallet)
        selfVerify = ed25519.verify(sigBytes, msg, pk)
        // What did the wallet actually sign? Two common adapter bugs for BINARY messages:
        //  - UTF-8 round-trip (corrupts 0x00/high bytes) → signs the mangled bytes.
        //  - signs the base58-string form (WalletConnect/AppKit wire format) instead of raw.
        verifyUtf8 = ed25519.verify(sigBytes, new TextEncoder().encode(new TextDecoder().decode(msg)), pk)
        verifyBase58 = ed25519.verify(sigBytes, new TextEncoder().encode(bs58.encode(msg)), pk)
      } catch (e) { selfVerify = `err:${(e as Error).message}` }
      log.info('[seal] signed bytes', {
        selfVerify, verifyUtf8, verifyBase58,
        walletName: walletBridge.adapter?.name,
        msgLen: msg.length, msgHex: bytesToHex(msg), signature,
      })
      const body = { ciphertext_b64: ciphertextB64, commitment_hex: commitmentHex, timelock_target: targetRound, signature, seal_tx_sig: sealTxSig }
      // REST only (not the WS `seal` frame): the socket's ack/error frames aren't correlated
      // to this request, so awaiting the HTTP response — same server handler — is the only
      // way to know the seal was accepted before latching 'sealed'.
      await api.submitSeal(match.matchId, body)
      // The plaintext stays on the client for the distance-to-conviction chart.
      sealContextTries = 0
      rememberCall(joinMatchId ?? match?.matchId, price)
      set({ sealStatus: 'sealed', yourPrediction: price, queuedPrediction: null, playError: null })
    } catch (err) {
      log.error('seal failed:', err)
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
    // Instant feedback: flip the panel to "Sending…" now, before the (slow) wallet sign —
    // otherwise the button looks dead for the whole signature round-trip.
    set({ actPending: action })
    // The act travels over the socket and needs it authenticated as this wallet.
    if (!(await ensureActionSocket(get, match.matchId))) {
      set({ actPending: null, playError: 'Reconnecting to the table — try that again in a moment.' })
      return
    }
    // Freshen the action-chain head from the journal at the last moment: the engine rejects
    // any intent whose prev_head isn't its CURRENT head, and another seat's event (default
    // registration, timeout) may have moved it since we last heard. ~1 RTT before the wallet
    // prompt — worth it, a stale head costs the whole turn.
    if (!(await syncActionHead(match.matchId))) {
      // Journal still genesis-only — the head is UNLEARNABLE and this act is doomed no
      // matter what we sign. Drive the bootstrap (a default registration mints journal
      // event seq 1) and wait for it to land; the panel shows "Sending…" meanwhile.
      console.log('[act] no fetchable head yet — bootstrapping via default registration')
      void armActionChain(get)
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (await syncActionHead(match.matchId)) break
      }
    }
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
      const signature = await signIntent(msg)
      gateway?.send({
        t: 'act',
        match_id: match.matchId,
        seat_index: seatIndex,
        nonce,
        prev_head_hex: bytesToHex(prevHead),
        action: wire,
        signature,
      })
      set({ yourTurn: null, actPending: null }) // optimistic; the broadcast `action` frame is authoritative
    } catch (err) {
      actionNonce-- // signing was cancelled/failed — free the nonce for a retry
      set({ actPending: null }) // re-enable the buttons so they can try again
      log.error('act failed:', err)
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
    signIntent(msg)
      .then((signature) => gateway?.send({ t: 'set_default', match_id: match.matchId, seat_index: seatIndex, policy: def, signature }))
      .catch((e) => {
        // Un-latch the live-start bootstrap so a dismissed prompt can retry (the default
        // registration is what mints the journal event the action chain bootstraps from).
        defaultArmed = false
        log.warn('[setDefault] sign failed:', e)
      })
  },

  claim: async () => {
    const { match } = get()
    if (!match) return null
    return runChainAction(set, 'Payout claimed on-chain', (chain) => chain.claim(match.matchId))
  },

  refund: async () => {
    const { match } = get()
    if (!match) return null
    return runChainAction(set, 'Refund confirmed on-chain', (chain) => chain.refund(match.matchId))
  },

  setReviewing: (v) => set({ reviewing: v }),

  /** Leave the finished match and matchmake into a fresh one — no page refresh.
   * Keeps the wallet/chain so the balance carries over; re-runs Play Now. */
  privateTable: false,
  myRoom: null,
  pendingCode: null,
  setPrivateTable: (on) => set({ privateTable: on }),
  roomCode: null,
  nextTable: null,
  checkNextTable: async () => {
    const st = get()
    const id = st.settlement?.matchId ?? st.match?.matchId
    if (!id || st.nextTable || st.view !== 'table') return
    try {
      const { next } = await api.getNextTable(id)
      if (!next) return
      const seat = get().match?.seats.find((x) => x.wallet === next.by)?.seat ?? null
      set({ nextTable: next.place.startsWith('code:') ? { by: seat, byWallet: next.by, code: next.place.slice(5) } : { by: seat, byWallet: next.by, matchId: next.place } })
    } catch { /* not seated there, or offline: nothing to show */ }
  },
  followTable: async () => {
    const next = get().nextTable
    if (!next) return
    set({ view: 'discovery' })
    if (next.code) await get().joinByCode(next.code)
    else if (next.matchId) await get().joinGame(next.matchId)
  },
  joinByCode: async (raw) => {
    const code = raw.trim().toUpperCase()
    if (!code) return
    if (!adapters) adapters = createAdapters()
    set({ playError: null, playResolving: true, pendingCode: null })
    try {
      const addr = await adapters.wallet.connect()
      set({ walletAddress: addr })
      const wallet = adapters.wallet.address()
      if (!wallet || !(await ensureRestSession(adapters, wallet, set))) throw new Error('Could not reach the table server (sign-in failed).')
      const room = await api.getRoomByCode(code)
      await get().joinGame(room.match_id, { code, commitment: room.join_commitment })
      set({ myRoom: { code, matchId: room.match_id } })
    } catch (e) {
      const msg = e instanceof Error && /sign-in|reach/.test(e.message) ? e.message : 'No open table has that code — it may have started already. Ask for the new one.'
      set({ playResolving: false, playError: msg })
    }
  },
  sendEmote: async (emote) => {
    const matchId = get().match?.matchId
    if (!matchId || (get().match?.yourSeat == null && !get().seated)) return
    if (!(await ensureActionSocket(get, matchId))) return
    gateway?.send({ t: 'emote', match_id: matchId, emote })
  },

  getTestChips: async () => {
    if (!adapters) adapters = createAdapters()
    const wallet = get().walletAddress ?? adapters.wallet.address()
    if (!wallet || get().faucetBusy) return
    set({ faucetBusy: true, faucetNote: null })
    try {
      if (!(await ensureRestSession(adapters, wallet, set))) throw new Error('Sign in to get chips')
      const res = await requestFaucet()
      set({ faucetNote: res.chips > 0 ? `${formatChips(BigInt(res.chips))} test chips sent` : 'Fee money topped up — more chips after the cooldown' })
      await refreshBalance(set, true)
    } catch (err) {
      set({ faucetNote: err instanceof Error ? err.message : 'Could not send chips — try again' })
    } finally {
      set({ faucetBusy: false })
    }
  },

  playHouse: async (opts) => {
    get().leaveToDiscovery()
    // The house opens its next table as the last one locks, so one is nearly always up;
    // give it a few seconds if we arrive in the gap.
    let table: UpcomingGame | undefined
    set({ findingTable: true, playError: null })
    try {
      for (let i = 0; i < 20 && !table; i++) {
        await get().loadDiscovery({ silent: i > 0 })
        table = get().upcomingGames.find((g) => isHouseBot(g.creatorWallet) && !isScheduledTable(g))
        if (!table) await new Promise((r) => setTimeout(r, 2000))
      }
      if (!table) {
        set({ playError: 'No table is open this second — a new one opens every few minutes. Try again shortly.' })
        return
      }
      await get().joinGame(table.matchId)
      // Staying at the table: take the seat straight away instead of stopping at the sheet.
      if (opts?.sit && get().playMode === 'join' && get().terms) await get().joinTable()
    } finally {
      set({ findingTable: false })
    }
  },

  returnToSeat: async (matchId) => {
    const wallet = adapters?.wallet.address() ?? get().walletAddress
    if (!wallet) return
    // We are going back in: this hand is no longer one we walked away from.
    saveCollects(wallet, pendingCollects(wallet).filter((c) => c.matchId !== matchId))
    resumedForWallet = null
    await get().resumeActiveTable(wallet)
  },

  leaveHand: () => {
    const s = get()
    const matchId = s.match?.matchId ?? joinMatchId
    const onchainMatchId = s.terms?.onchainMatchId
    const wallet = adapters?.wallet.address() ?? s.walletAddress
    if (s.seated && matchId && onchainMatchId && wallet && s.terms && !s.settlement && !s.voided) {
      rememberCollect(wallet, { matchId, onchainMatchId, staked: String(s.terms.buyIn + s.terms.entryFee) })
      startCollector(set, get)
    }
    get().leaveToDiscovery()
  },

  moveOn: async () => {
    const s = get()
    const matchId = s.match?.matchId ?? joinMatchId
    const onchainMatchId = s.terms?.onchainMatchId
    const wallet = adapters?.wallet.address() ?? s.walletAddress
    if (matchId && onchainMatchId && wallet && s.terms) {
      rememberCollect(wallet, { matchId, onchainMatchId, staked: String(s.terms.buyIn + s.terms.entryFee) })
      startCollector(set, get)
    }
    await get().playHouse({ sit: true })
  },

  rematch: async () => {
    const prev = get().terms
    rematchFrom = get().match?.matchId ?? null
    const wasPrivate = !!get().roomCode
    if (!prev) return get().playAgain()
    const keep = { feed: prev.priceFeedId, buyIn: prev.buyIn, maxPlayers: prev.maxPlayers }
    await get().playAgain() // back to the lobby and open a fresh create context
    const t = get().terms
    if (!createCtx || !t) return // connection or config failed; the create sheet says why
    const limits = get().createLimits
    createCtx.feed = keep.feed
    set({
      terms: {
        ...t,
        priceFeedId: keep.feed,
        buyIn: keep.buyIn,
        maxPlayers: keep.maxPlayers,
        // The players are already here but need a moment to see the invitation and click;
        // a full table deals at once, and on a public one bots take what is left.
        fillWindowSec: limits ? Math.max(limits.fillWindowMinSec, wasPrivate ? 120 : 60) : 60,
      },
    })
    set({ privateTable: wasPrivate })
    await get().createTable()
  },

  playAgain: async () => {
    set({
      // Back to the Room page first — createGame() now opens the create sheet as an
      // overlay on discovery rather than switching views, so this must happen before it.
      view: 'discovery',
      match: null,
      roomCode: null,
      myRoom: null,
      nextTable: null,
      yourTurn: null,
      actPending: null,
      sealStatus: 'unsealed',
      yourPrediction: null,
      queuedPrediction: null,
      sealClosed: false,
      sealedSeats: [],
      sealDeadline: null,
      settlement: null,
      voided: null,
      reviewing: false,
      seated: false,
      feed: [],
      priceHistory: [],
      fillDeadline: null,
      roundStartedAt: null,
      streetSchedule: null,
    })
    await get().createGame()
  },

  loadHistory: async (opts) => {
    const more = opts?.more ?? false
    const cursor = more ? get().historyCursor ?? undefined : undefined
    if (!more) set({ historyStatus: 'loading' })
    try {
      const { hands, nextCursor } = await fetchHistory(cursor)
      set((s) => ({
        historyGames: more ? [...s.historyGames, ...hands] : hands,
        historyCursor: nextCursor,
        historyStatus: 'ready',
      }))
    } catch (err) {
      log.warn('[loadHistory] failed:', err)
      if (!more) set({ historyStatus: 'error' })
    }
  },

  loadLeaderboard: async (period) => {
    const p = period ?? get().leaderboardPeriod
    try {
      const { leaders } = await api.getLeaderboard({ period: p })
      set({ leaderboardPeriod: p, leaderboard: { entries: leaders } })
    } catch (err) {
      log.warn('[loadLeaderboard] failed:', err)
    }
  },

  loadProfile: async () => {
    const wallet = get().walletAddress
    if (!wallet) {
      set({ profile: null })
      return
    }
    try {
      const p = await api.getProfile(wallet)
      set({
        profile: {
          wallet: p.wallet,
          handle: p.handle,
          stats: {
            tablesPlayed: p.stats.tables_played,
            potsWon: p.stats.pots_won,
            netChips: BigInt(p.stats.net_chips),
            bestPot: p.stats.best_pot != null ? BigInt(p.stats.best_pot) : null,
          },
        },
      })
    } catch (err) {
      log.warn('[loadProfile] failed:', err)
    }
  },

  saveHandle: async (handle) => {
    if (!adapters) adapters = createAdapters()
    const addr = adapters.wallet.address() ?? (await adapters.wallet.connect())
    set({ walletAddress: addr })
    if (!(await ensureRestSession(adapters, addr, set))) {
      throw new Error('Could not sign in to save your handle.')
    }
    const res = await api.updateProfile({ handle })
    set((s) => ({
      profile: s.profile
        ? { ...s.profile, handle: res.handle }
        : { wallet: res.wallet, handle: res.handle, stats: { tablesPlayed: 0, potsWon: 0, netChips: 0n, bestPot: null } },
    }))
  },
}))

/** On-chain deadlines are unix seconds; the UI counts down in epoch-ms. Pass through values already in ms. */
function toEpochMs(deadline: number): number {
  return deadline > 1e12 ? deadline : deadline * 1000
}

/** Normalize the server street schedule to epoch-ms windows; null when absent/empty. */
function normalizeSchedule(
  sched: { street: number; open: number; close: number; end: number }[] | null | undefined,
): StreetWindow[] | null {
  if (!sched || sched.length === 0) return null
  return sched.map((e) => ({ street: e.street, open: toEpochMs(e.open), close: toEpochMs(e.close), end: toEpochMs(e.end) }))
}

/**
 * Poll a deposit's candidate → confirmed lifecycle after reporting the txhash (§5). A
 * terminal `not_confirmed`/`rejected` means the table filled first — the buy-in is fully
 * refundable — so surface it. `confirmed` is the happy path (engine seat assigned at lock).
 */
// — our own sealed number, kept in this browser so a reload does not lose it ———————————
const callKey = (matchId: string) => `st-call:${matchId}`
function rememberCall(matchId: string | null | undefined, price: FixedPrice): void {
  if (!matchId) return
  try { localStorage.setItem(callKey(matchId), String(price)) } catch { /* private mode */ }
}
function recallCall(matchId: string | null | undefined): FixedPrice | null {
  if (!matchId) return null
  try {
    const v = Number(localStorage.getItem(callKey(matchId)))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null }
}

// — hands left early: collect behind the player's back ————————————————————————————
type Collect = { matchId: string; onchainMatchId: string; staked: string; tries?: number }
const collectKey = (wallet: string) => `st-collect-v1:${wallet}`
function pendingCollects(wallet: string): Collect[] {
  try { return JSON.parse(localStorage.getItem(collectKey(wallet)) ?? '[]') as Collect[] } catch { return [] }
}
function saveCollects(wallet: string, list: Collect[]): void {
  try { localStorage.setItem(collectKey(wallet), JSON.stringify(list.slice(-12))) } catch { /* private mode */ }
}
function rememberCollect(wallet: string, c: Collect): void {
  const list = pendingCollects(wallet).filter((x) => x.matchId !== c.matchId)
  saveCollects(wallet, [...list, c])
}

let collector: ReturnType<typeof setInterval> | null = null
let collecting = false
/**
 * Watches the hands the player left before they settled and pulls each payout the moment
 * it exists. Only a table wallet signs silently, so only it collects by itself; any other
 * wallet finds the usual Collect card in the lobby.
 */
function startCollector(set: SetState, get: () => GameState): void {
  if (collector) return
  collector = setInterval(async () => {
    const wallet = adapters?.wallet.address() ?? get().walletAddress
    if (!wallet || !adapters || collecting) return
    const list = pendingCollects(wallet)
    if (list.length === 0) { clearInterval(collector!); collector = null; return }
    collecting = true
    try {
      for (const c of list) {
        const drop = () => saveCollects(wallet, pendingCollects(wallet).filter((x) => x.matchId !== c.matchId))
        let detail: MatchDetail
        try { detail = await api.getMatch(c.matchId) } catch { continue }
        const phase = detail.phase.toLowerCase()
        if (phase === 'voided') { drop(); continue } // refund shows as a card in the lobby
        if (phase !== 'settled') continue
        const mine = detail.seats.find((x) => x.wallet === wallet)
        const payout = BigInt(mine?.payout_chips ?? 0)
        const won = BigInt(mine?.pot_won_chips ?? 0) > 0n
        recordHand(wallet, c.matchId, payout - BigInt(c.staked), won)
        // The points for that hand too — leaving early must not cost them.
        const earned = HAND_FIBS + (won ? WIN_FIBS : 0)
        addFibs(wallet, earned)
        void reportFibs(earned).catch(() => {})
        if (payout === 0n || !isGuestWallet(wallet)) { drop(); continue }
        try {
          const sig = await adapters.chain.claimSettled(c.onchainMatchId)
          // The line the result card would have shown, so skipping ahead does not cost
          // the player the best part of the hand they left.
          let tail = won ? ' — you won it' : ''
          try {
            const px = Number((detail as { settlement_price_wad?: string | null }).settlement_price_wad ?? 0)
            const dist = (w?: string | null) => (w != null && px > 0 ? Math.abs(Number(w) - px) : Infinity)
            const winner = detail.seats.find((x) => BigInt(x.pot_won_chips ?? 0) > 0n)
            if (!won && winner && dist(mine?.prediction_wad) < dist(winner.prediction_wad)) tail = ' — and you had folded a closer number than the winner'
          } catch { /* the plain line is fine */ }
          set({ collectNote: { id: sig, label: `${won ? `You won your last hand: +${formatChips(payout - BigInt(c.staked))}` : `${formatChips(payout)} back from your last hand`}${won ? '' : tail}` } })
          drop()
          void refreshBalance(set, true)
        } catch (err) {
          if ((err as Error).message === 'AlreadyClaimed') { drop(); continue }
          // The payout account can trail the settle by a few seconds — try again, not forever.
          const tries = (c.tries ?? 0) + 1
          if (tries >= 8) drop()
          else saveCollects(wallet, pendingCollects(wallet).map((x) => (x.matchId === c.matchId ? { ...x, tries } : x)))
        }
      }
    } finally {
      collecting = false
    }
  }, 6_000)
}

/** The dealer button of the hand in view (see matchFromState). */
let liveButton: number | null = null

/** Consecutive seat reads of a dealt hand that did not include us (one could be a race). */
let dealtOutStrikes = 0

const depositKey = (matchId: string) => `st-deposit:${matchId}`
function rememberDeposit(matchId: string, sig: string): void {
  try { localStorage.setItem(depositKey(matchId), sig) } catch { /* private mode */ }
}
function recallDeposit(matchId: string): string | null {
  try { return localStorage.getItem(depositKey(matchId)) } catch { return null }
}

/**
 * Tell the server about a deposit until it has heard. One lost request here used to cost
 * the player the hand: the chips were in, the table dealt without them.
 */
/** On a test network, make sure the wallet can pay the network fee before a transaction
 *  that needs one (dealing a table costs noticeably more than sitting at one). Silent:
 *  where there is no faucet this does nothing, and the transaction reports its own error. */
async function ensureFees(): Promise<void> {
  try { await requestFees() } catch { /* no faucet here, or it is busy */ }
}

async function reportDeposit(matchId: string, txSig: string, set: SetState): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await api.submitDeposit(matchId, txSig, roomJoin?.code)
      log.info('[deposit] reported — status:', r.status)
      void pollCandidate(matchId, adapters?.wallet.address() ?? '', set)
      return
    } catch (e) {
      log.warn('[deposit] report failed, retrying:', e)
      await new Promise((r) => setTimeout(r, 1500 + i * 1500))
    }
  }
}

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
      log.info('[candidate] confirmed — engine seat', s.seat_index)
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
    stack: BigInt(s.stack ?? 0),
    committedThisStreet: BigInt(s.committed ?? 0),
    totalContribution: BigInt(s.total_contribution ?? 0),
    folded: s.folded ?? false,
    allIn: s.all_in ?? false,
  }))
  // Prefer the wallet match; fall back to our known engine seat (set from `your_turn`/lock)
  // so a wallet-casing/absent-wallet snapshot still resolves our stack instead of showing 0.
  const mine =
    (myWallet ? state.seats.find((s) => s.wallet === myWallet) : undefined) ??
    (myEngineSeat != null ? state.seats.find((s) => s.seat_index === myEngineSeat) : undefined)
  return {
    matchId: state.match_id,
    phase: mapPhase(state.phase),
    round: state.round ?? 1,
    pot: BigInt(state.pot ?? 0),
    currentBet: BigInt(state.current_bet ?? 0),
    // Action frames do not repeat the button; the go-live frame and the record carry it.
    buttonSeat: state.button ?? liveButton ?? 0,
    toActSeat: state.to_act ?? null,
    seats,
    feedPrice: 0, // live price arrives via `action` frames / the price WS, not the snapshot
    yourSeat: mine?.seat_index,
    yourStack: mine?.stack != null ? BigInt(mine.stack) : undefined,
    yourExposure: mine?.total_contribution != null ? BigInt(mine.total_contribution) : undefined,
  }
}

/** Canonicalise the engine's Rust `Action` Debug variant ("BetTo(120)", "AllIn", …) to the
 *  UI's camelCase action tag (`betTo`/`raiseTo`/`allIn`/`call`/`check`/`fold`). The pod tooltip
 *  and status line switch on these exact tags, so lowercasing them ("betto"/"allin") silently
 *  fell through to the raw-string/"Called" defaults. */
function normalizeAction(variant: string): string {
  switch (variant) {
    case 'BetTo': return 'betTo'
    case 'RaiseTo': return 'raiseTo'
    case 'AllIn': return 'allIn'
    case 'Call': return 'call'
    case 'Check': return 'check'
    case 'Fold': return 'fold'
    default: return variant ? variant.charAt(0).toLowerCase() + variant.slice(1) : variant
  }
}

/**
 * Translate a v2 engine event into a public feed entry. The SAME engine event reaches us in two
 * wire shapes: the LIVE broadcast (view.rs `public_event` — type `action`/`street_closed`, seat
 * under `body.seat`) and the BACKFILL/REST journal (persistence.rs payload — type
 * `player.action`/`snapshot.written`, seat under `body.seat_index`). A joiner's *history* arrives
 * as backfill, so recognising only the live shape dropped every pre-existing bet on the floor —
 * the pod hover tooltip and the table feed stayed empty until a new action happened live.
 */
function wsEventToFeed(ev: { type: string; body: Record<string, unknown>; seq?: number }, matchId: string, pot: Chips, feedPrice: number): PublicEvent | null {
  const seat = Number(ev.body.seat ?? ev.body.seat_index ?? ev.body.player_id ?? 0)
  switch (ev.type) {
    case 'action':
    case 'player.action': {
      const raw = String(ev.body.action ?? '') // Rust Debug: "Fold", "BetTo(120)", "RaiseTo(240)", "Call", "Check", "AllIn"
      const m = /^(\w+)(?:\((\d+)\))?/.exec(raw)
      const action = normalizeAction(m?.[1] ?? '')
      const amount = m?.[2] ? BigInt(m[2]) : 0n
      if (action === 'fold') return { kind: 'fold', matchId, seat, ts: Date.now() }
      return { kind: 'action', matchId, seat, action, amount, feedPrice, pot, ts: Date.now() }
    }
    case 'timeout_default':
    case 'timeout.default': {
      // The clock played the seat's default. Put it on the record — and tell the player
      // it happened to, because a silent fold reads as the game eating a hand.
      const st = useGameStore.getState()
      if (st.match?.yourSeat === seat) {
        useGameStore.setState({ collectNote: { id: `timeout-${matchId}-${ev.seq ?? Date.now()}`, label: 'Your clock ran out — your time-out choice was played for you.' } })
      }
      return { kind: 'action', matchId, seat, action: 'timeout', amount: 0n, feedPrice, pot, ts: Date.now() }
    }
    case 'street_closed':
    case 'snapshot.written': {
      // The engine's round counter has already advanced past the street that closed, so
      // after the LAST street it reads count + 1 — "Round 3" in a two-round hand. There is
      // no such round; don't announce one.
      const round = Number(ev.body.round ?? 0)
      const total = useGameStore.getState().terms?.roundCount
      if (total != null && round > total) return null
      return { kind: 'round', matchId, round, ts: Date.now() }
    }
    default:
      return null
  }
}

/** Map a client `BettingAction` to its signed-intent tag/amount + the WS `action` payload. */
function bettingActionToWire(a: BettingAction): { tag: number; amount: Chips; wire: WsAction } {
  switch (a.type) {
    case 'fold': return { tag: 0, amount: 0n, wire: 'fold' }
    case 'check': return { tag: 1, amount: 0n, wire: 'check' }
    case 'call': return { tag: 2, amount: 0n, wire: 'call' }
    // The signed intent carries the exact bigint; the WS wire payload is JSON, so it takes a number.
    case 'betTo': return { tag: 3, amount: a.amount, wire: { kind: 'bet_to', amount: Number(a.amount) } }
    case 'raiseTo': return { tag: 4, amount: a.amount, wire: { kind: 'raise_to', amount: Number(a.amount) } }
    case 'allIn': return { tag: 5, amount: 0n, wire: 'all_in' }
  }
}

function handleServerFrame(frame: ServerFrame, set: SetState, get: () => GameState) {
  // Match-scoped frames only count for the table on screen.
  const frameMatch = (frame as { match_id?: string }).match_id
  if (frameMatch && frameMatch !== activeMatchId) return
  switch (frame.t) {
    case 'authenticated':
      wsAuthedWallet = frame.wallet
      set({ walletAddress: frame.wallet, status: 'live' })
      break

    case 'snapshot': {
      const myWallet = adapters?.wallet.address() ?? get().walletAddress
      const view = snapshotToMatchState(frame.state, myWallet)
      myEngineSeat = view.yourSeat ?? myEngineSeat
      // Seed the action-chain head + nonce from the snapshot so the first `act` chains correctly.
      try { actionHead = hexToBytes32(frame.state.head) } catch { /* keep zero head */ }
      actionNonce = Math.max(actionNonce, frame.state.last_seq)
      lastAppliedSeq = Math.max(lastAppliedSeq, frame.state.last_seq)
      const t = frame.state.timing
      set((s) => ({
        match: view,
        // The server's match params are the truth for this table — a host's terms start as
        // the create sheet's defaults, which need not be what the match was created with.
        terms: s.terms
          ? {
              ...s.terms,
              onchainMatchId: String(frame.state.onchain_match_id),
              timelockTargetRound: t.timelock_target ?? s.terms.timelockTargetRound,
              roundCount: frame.state.params.round_count ?? s.terms.roundCount,
              roundDurationsSec: frame.state.params.round_durations_sec ?? s.terms.roundDurationsSec,
              actionTimerSec: frame.state.params.action_timeout_ms != null
                ? Math.round(frame.state.params.action_timeout_ms / 1000)
                : s.terms.actionTimerSec,
            }
          : s.terms,
        fillDeadline: t.fill_deadline != null ? toEpochMs(t.fill_deadline) : s.fillDeadline,
        roundStartedAt: t.live_start != null ? toEpochMs(t.live_start) : s.roundStartedAt,
        streetSchedule: normalizeSchedule(t.street_schedule) ?? s.streetSchedule,
        sealClosed: s.sealClosed || frame.state.phase === 'sealing_closed',
      }))
      // Reconnected mid-seal-window: recover the engine seat + our sealed flag, and fire
      // any early prediction queued before the disconnect.
      if (frame.state.phase === 'sealing') void ensureSealContext(set, get)
      // Mid-turn refresh recovery: a patched server puts the open turn (with its TRUE
      // deadline) in the snapshot — latch it if it's ours and still live.
      const turn = frame.state.turn ?? frame.state.open_turn
      if (turn) adoptTurnHead(turn)
      if (turn && turn.seat === view.yourSeat && Date.now() < turn.deadline_ms) {
        set({ yourTurn: { toCall: turn.to_call, minRaiseTo: turn.min_raise_to, deadline: turn.deadline_ms }, actPending: null })
      }
      // Reconnected mid-hand: pull seats immediately — this also reconstructs an open turn
      // (see refreshMatchSeats) so a refresh during your turn no longer means a timeout fold.
      if (frame.state.phase === 'live') void refreshMatchSeats(set, get)
      break
    }

    case 'schedule': {
      const next = normalizeSchedule(frame.street_schedule)
      if (next) set({ streetSchedule: next })
      break
    }

    case 'phase': {
      const phase = mapPhase(frame.phase)
      if (phase === 'SEALING') set({ priceChartOpen: false })
      const fb = (frame as { button?: number | null }).button
      if (fb != null) liveButton = fb
      set((s) => ({
        match: s.match ? { ...s.match, phase, buttonSeat: fb ?? s.match.buttonSeat } : s.match,
        terms: s.terms && frame.timelock_target != null ? { ...s.terms, timelockTargetRound: frame.timelock_target } : s.terms,
        fillDeadline: frame.seal_deadline != null ? toEpochMs(frame.seal_deadline) : s.fillDeadline,
        sealDeadline: frame.seal_deadline != null ? toEpochMs(frame.seal_deadline) : s.sealDeadline,
        roundStartedAt: frame.live_start != null ? toEpochMs(frame.live_start) : s.roundStartedAt,
        sealClosed: s.sealClosed || frame.phase === 'sealing_closed',
      }))
      // The lock broadcast carries no seats — fetch our engine seat (needed to sign the
      // seal intent) and fire any queued early prediction now that the window is open.
      if (frame.phase === 'sealing') void ensureSealContext(set, get)
      // No live frame carries per-seat stacks, so pull them once the hand starts (blinds
      // posted) — otherwise stack/committed/all-in stay 0 for the whole match.
      if (frame.phase === 'live') {
        // Bootstrap the action chain: the genesis event (seq 0) is unfetchable, so learn
        // the head from the journal — or mint event seq 1 via our default policy if empty.
        void armActionChain(get)
        void refreshMatchSeats(set, get)
      }
      break
    }

    case 'seat_update':
      set({ lobbySeated: frame.confirmed })
      break

    case 'event': {
      // Each journaled event's hash IS the action-chain head after it — track it so `act`
      // signs the right prev_head. The engine appends genesis/blind events at live start
      // (moving the head) with no other frame carrying the new value; signing against the
      // snapshot's stale copy rejected EVERY act with "prev_head mismatch".
      try { actionHead = hexToBytes32(frame.hash) } catch { /* keep */ }
      actionNonce = Math.max(actionNonce, frame.seq)
      lastAppliedSeq = Math.max(lastAppliedSeq, frame.seq)
      // Standalone engine events. Timer-driven street transitions land HERE, not inside an
      // `action` broadcast — when a street closes with nobody acting there is no action frame
      // to carry the new round, so ignoring these froze the round counter until the next bet.
      const m = get().match
      // Feed append is the one non-idempotent bit — dedup by seq so a reconnect replay of an
      // already-shown event can't double it (the head/nonce/pot updates above stay unconditional).
      if (frame.seq > lastFeedSeq) {
        lastFeedSeq = frame.seq
        const item = wsEventToFeed(
          { type: frame.type, body: frame.body, seq: frame.seq },
          frame.match_id,
          m?.pot ?? 0n,
          m?.feedPrice ?? 0,
        )
        if (item) set((s) => ({ feed: [...s.feed, item].slice(-MAX_FEED) }))
      }
      // Resync round/pot/current_bet/to_act (+ per-seat stacks) from REST — event-paced, cheap.
      void refreshMatchSeats(set, get)
      break
    }

    case 'emote': {
      if (frame.match_id !== activeMatchId) return
      // Not table talk: a player who dealt the next table telling this one where it is.
      if (frame.emote.startsWith('next:')) {
        if (frame.seat_index === get().match?.yourSeat) return
        const rest = frame.emote.slice(5)
        set({ nextTable: rest.startsWith('code:') ? { by: frame.seat_index, code: rest.slice(5) } : { by: frame.seat_index, matchId: rest } })
        return
      }
      set((s) => ({ talk: [...s.talk, { seat: frame.seat_index, emote: frame.emote, at: Date.now() }].slice(-6) }))
      return
    }
    case 'seal_status': {
      // `sealed`/`just_sealed` list engine seats — recognising our own covers the reload
      // case where the latch was lost (the plaintext is gone, but re-sealing would 409).
      const mineSealed =
        myEngineSeat != null && (frame.just_sealed === myEngineSeat || (frame.sealed?.includes(myEngineSeat) ?? false))
      set((s) => {
        // Merge the sealed-seat set so a `just_sealed`-only delta still advances the strip.
        const merged = new Set(s.sealedSeats)
        frame.sealed?.forEach((x) => merged.add(x))
        if (frame.just_sealed != null) merged.add(frame.just_sealed)
        return {
          sealClosed: s.sealClosed || frame.closed === true,
          sealStatus: mineSealed ? 'sealed' : s.sealStatus,
          yourPrediction: s.yourPrediction ?? (mineSealed ? recallCall(s.match?.matchId ?? joinMatchId) : null),
          sealedSeats: [...merged].sort((a, b) => a - b),
          sealDeadline: frame.deadline_ms != null ? toEpochMs(frame.deadline_ms) : s.sealDeadline,
        }
      })
      break
    }

    // The server announces every turn twice: `turn_update` to EVERY subscriber (public table
    // state) and `your_turn` only to the acting wallet's authenticated socket. Both carry the
    // same payload, so handle them identically — and never depend on the private frame: a
    // socket whose auth challenge was skipped/dismissed still gets `turn_update`, which is
    // enough to open the panel for our own seat.
    case 'turn_update':
    case 'your_turn': {
      // Never adopt frame.seat as our identity (that once made both browsers open the action
      // panel and sign acts with the wrong seat_index); only open the panel if the seat
      // verifiably matches our wallet-resolved engine seat.
      const turn = { toCall: frame.to_call, minRaiseTo: frame.min_raise_to, deadline: frame.deadline_ms }
      const mySeat = myEngineSeat ?? get().match?.yourSeat ?? null
      // The frame carries the live action-chain head — the exact prev_head the acting seat
      // must sign. Adopt it directly (no REST round-trip, no stale-head race).
      const gotHead = adoptTurnHead(frame)
      // Whoever it's for, the frame names the acting seat — keep the banner/pods honest.
      set((s) => ({
        match: s.match ? { ...s.match, toActSeat: frame.seat, round: frame.round ?? s.match.round } : s.match,
        // nothing may sit on top of the action buttons while the clock is running
        priceChartOpen: mySeat != null && mySeat === frame.seat ? false : s.priceChartOpen,
      }))
      if (mySeat == null) {
        // Seat unknown (e.g. reconnected mid-hand) — resolve it from REST, then decide.
        void refreshMatchSeats(set, get).then(() => {
          if (myEngineSeat === frame.seat && Date.now() < frame.deadline_ms) {
            set({ yourTurn: turn, actPending: null })
          }
        })
        break
      }
      const mine = frame.seat === mySeat
      // Don't clobber an in-flight act: the public + private frames for the same turn arrive
      // back-to-back, and the second must not reset a click made after the first.
      set((s) => ({
        yourTurn: mine ? turn : null,
        actPending: mine && s.yourTurn?.deadline === turn.deadline ? s.actPending : null,
      }))
      // Older servers send no head in the frame — fall back to the journal.
      if (mine && !gotHead) void syncActionHead(frame.match_id)
      // Make sure our own stack/committed are populated before the action panel opens — the
      // turn frame carries to_call/min_raise_to but no stacks.
      void refreshMatchSeats(set, get)
      break
    }

    case 'action': {
      // Advance the action-chain head + nonce so the next signed `act` uses the right prev_head.
      try { actionHead = hexToBytes32(frame.head_hex) } catch { /* keep */ }
      actionNonce = Math.max(actionNonce, frame.seq)
      lastAppliedSeq = Math.max(lastAppliedSeq, frame.seq)
      const decimals = get().terms?.decimals ?? 2
      const priceNum = frame.feed_price != null ? wadStringToFixed(frame.feed_price, frame.feed_price_expo, decimals) : 0
      // Dedup the feed by seq (a replayed action frame must not re-list its events); the
      // pot/current_bet/price updates below stay unconditional so a resync never regresses.
      const isFreshAction = frame.seq > lastFeedSeq
      if (isFreshAction) lastFeedSeq = frame.seq
      const framePot = BigInt(frame.pot)
      const frameCurrentBet = BigInt(frame.current_bet)
      const feedItems = isFreshAction
        ? frame.events
            .map((e) => wsEventToFeed(e, frame.match_id, framePot, priceNum))
            .filter((x): x is PublicEvent => x !== null)
        : []
      const now = Date.now()
      set((s) => ({
        feed: [...s.feed, ...feedItems].slice(-MAX_FEED),
        match: s.match
          ? { ...s.match, pot: framePot, currentBet: frameCurrentBet, toActSeat: frame.to_act ?? null, round: frame.round, feedPrice: priceNum }
          : s.match,
        // PricePoint.price is DOLLARS (the spot feed pushes floats); priceNum is the
        // protocol's fixed-point int — convert, or the chart/seal/position math explodes
        // (a $62,750.40 call rendered as "$6.2M above market").
        priceHistory: priceNum > 0 ? [...s.priceHistory, { price: priceNum / 10 ** decimals, ts: now }].slice(-MAX_HISTORY) : s.priceHistory,
        yourTurn: frame.to_act != null && frame.to_act === myEngineSeat ? s.yourTurn : null,
      }))
      // Action frames move pot/current_bet but not per-seat stacks — pull the fresh stacks so
      // the HUD's stack/committed track the hand as bets/calls land (human-paced, so cheap).
      void refreshMatchSeats(set, get)
      break
    }

    case 'settled':
      // The frame carries only {seat, wallet} — no price, predictions, or amounts. Clear the
      // turn immediately for responsiveness, then hydrate the real ceremony from REST + chain.
      set({ yourTurn: null, actPending: null })
      void recoverSettlement(set, get, frame.payouts.map((p) => p.seat))
      break

    case 'voided':
      set({ voided: { reason: (frame.kind ?? 'Void') as VoidReason }, yourTurn: null, actPending: null })
      break

    case 'default_set': {
      // Registering a default policy appended a journal event — adopt its hash as the
      // action-chain head (this is the live-start bootstrap completing; see armActionChain).
      void syncActionHead(frame.match_id)
      break
    }

    case 'error':
      log.warn('[ws] error frame:', frame.code, frame.msg)
      // A rejected act otherwise leaves a silently dead table (yourTurn was optimistically
      // cleared on send). Resync the chain head + table so the turn is restored and the
      // retry signs against the real head.
      if (
        frame.code === 'bad_action' || frame.code === 'unauthorized' || frame.code === 'rate_limited' ||
        frame.code === 'betting_closed' || frame.code === 'not_live' || frame.code === 'not_found'
      ) {
        set({
          playError: frame.code === 'betting_closed'
            ? 'This round is not open for betting yet — your turn stays queued until it opens.'
            : `Action rejected — ${frame.msg}`,
        })
        const mid = get().match?.matchId ?? joinMatchId
        if (mid) void syncActionHead(mid)
        void refreshMatchSeats(set, get)
      }
      break

    default:
      break // lobby_delta / sealed / pong — no store action needed
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
    // The drand target round is the SERVER's to assign after lock — it must land in the
    // on-chain-validated window (seal_deadline + total_betting + begin_live_window, ±20s),
    // which the client can't reconstruct. So trust `timing.timelock_target` only; if it's
    // still null the seat can't seal yet (see the `!targetRound` guard in sealPrediction).
    if (detail.timing.timelock_target == null) {
      log.warn('[seal] server has not assigned timelock_target yet', detail.timing)
    }
    set((s) => ({
      sealStatus: mine?.sealed && s.sealStatus !== 'sealed' ? 'sealed' : s.sealStatus,
      terms:
        s.terms && detail.timing.timelock_target != null
          ? { ...s.terms, timelockTargetRound: detail.timing.timelock_target }
          : s.terms,
    }))
  } catch (err) {
    log.warn('[seal] match refresh at lock failed:', err) // the queued seal below may still succeed
  }
  const s = get()
  if (s.queuedPrediction != null && s.sealStatus === 'unsealed' && !s.sealClosed) {
    void s.sealPrediction(s.queuedPrediction)
  }
}

/**
 * Resolve the per-seat payout AWARDS for a settled match, winner first.
 *
 * A conviction match pays MULTIPLE seats (the pot winner + every other seat's un-bet stack),
 * so the ceremony needs every seat's amount, not just the winner's.
 *
 *  1. The server's settlement audit — `seats[].payout_chips` (what the seat can claim) and
 *     `pot_won_chips` (the winner signal). This is the exact data the settle transaction was
 *     built from, and it is available the instant the match reads `settled`.
 *  2. The on-chain `seat.payout`, for servers that predate those fields. NOTE this read runs
 *     at `finalized` commitment, which lags the settle transaction by ~15s: asked right at
 *     settlement it returns zeros, which is why it can no longer be the primary source (the
 *     ceremony latched a $0 result with no Claim button until the page was reloaded).
 *  3. Degraded: only the connected wallet's own payout, crowning the WS `winnerSeats` at 0.
 *
 * Returns `complete: false` when no amounts could be resolved yet, so callers keep polling
 * instead of latching an empty ceremony.
 */
async function computeSettlementAwards(
  detail: MatchDetail,
  onchainId: string | undefined,
  winnerSeats?: number[],
): Promise<{ awards: { seat: number; amount: Chips }[]; complete: boolean }> {
  const desc = (a: bigint, b: bigint) => (b > a ? 1 : b < a ? -1 : 0)

  // 1. Server audit.
  const audited = (detail.seats ?? []).filter((s) => s.payout_chips != null)
  if (audited.length > 0 && audited.some((s) => (s.payout_chips ?? 0) > 0)) {
    const rows = audited.map((s) => ({
      seat: s.seat_index,
      amount: BigInt(s.payout_chips ?? 0),
      won: BigInt(s.pot_won_chips ?? 0),
    }))
    // Crown by pot won (payout alone also counts each seat's returned, un-bet stack).
    rows.sort((a, b) => desc(a.won, b.won) || desc(a.amount, b.amount))
    return { awards: rows.map(({ seat, amount }) => ({ seat, amount })), complete: true }
  }

  // 2. On-chain seat payouts.
  if (adapters && onchainId) {
    const seatWallets = (detail.seats ?? [])
      .filter((s) => !!s.wallet)
      .map((s) => ({ wallet: s.wallet, seat: s.seat_index }))
    if (seatWallets.length) {
      try {
        const payouts = await adapters.chain.getSeatPayouts(onchainId, seatWallets.map((s) => s.wallet))
        const byWallet = new Map(payouts.map((p) => [p.wallet, p.payout]))
        const awards = seatWallets.map(({ wallet, seat }) => ({ seat, amount: byWallet.get(wallet) ?? 0n }))
        // A settled match always pays someone, so all-zero means the read missed (not finalized).
        if (awards.some((a) => a.amount > 0n)) {
          return { awards: awards.sort((a, b) => desc(a.amount, b.amount)), complete: true }
        }
      } catch (err) {
        log.warn('[settle] all-seat payout read failed, falling back:', err)
      }
    }
  }

  // 3. Degraded: only our own amount is knowable.
  let myPayout: { seat: number; amount: Chips } | null = null
  if (adapters && onchainId) {
    try {
      const seat = await adapters.chain.getMySeat(onchainId)
      if (seat && seat.payout > 0n) myPayout = { seat: seat.engineSeat, amount: seat.payout }
    } catch (err) {
      log.warn('[settle] on-chain payout read failed:', err)
    }
  }
  const awards = winnerSeats && winnerSeats.length
    ? winnerSeats.map((seat) => ({ seat, amount: myPayout && myPayout.seat === seat ? myPayout.amount : 0n }))
    : myPayout
      ? [myPayout]
      : []
  return { awards, complete: false }
}

/**
 * Build the full `SettlementView` from a REST match detail's `reveal` block (settlement price +
 * every revealed prediction) and the pre-resolved per-seat `awards` (see `computeSettlementAwards`).
 */
function settlementFromDetail(
  detail: MatchDetail,
  decimals: number,
  awards: { seat: number; amount: Chips }[],
): SettlementView {
  const reveal = detail.reveal as {
    settlement_price_wad?: string | null
    predictions?: { engine_seat: number; prediction_wad: string | null }[] | null
    rake?: number | null
    final_pot_chips?: number | null
    uncontested?: boolean | null
  } | null
  return {
    uncontested: reveal?.uncontested === true,
    matchId: detail.match_id,
    settlementPrice: reveal?.settlement_price_wad ? wadToFixed(reveal.settlement_price_wad, decimals) : 0,
    awards,
    uncalledReturns: [],
    finalPot: reveal?.final_pot_chips != null ? BigInt(reveal.final_pot_chips) : undefined,
    rakeCollected: BigInt(reveal?.rake ?? 0),
    revealedPredictions: (reveal?.predictions ?? []).filter((p) => p.prediction_wad != null).map((p) => ({
      seat: p.engine_seat,
      prediction: wadToFixed(p.prediction_wad as string, decimals),
    })),
  }
}

/**
 * Land the resolution ceremony with REAL data (settlement price, every reveal, and the
 * player's own on-chain payout). Used by BOTH the WS `settled` frame and the REST self-heal —
 * the frame alone carries only seats+wallets, which previously rendered a blank $0 ceremony
 * with the winner's Claim button hidden. Idempotent + poll-stopping; safe to fire from either.
 */
async function recoverSettlement(set: SetState, get: () => GameState, winnerSeats?: number[]): Promise<void> {
  if (get().settlement) return
  const matchId = get().match?.matchId ?? joinMatchId
  if (!matchId) return
  const decimals = get().terms?.decimals ?? 2

  let detail: MatchDetail
  try {
    detail = await api.getMatch(matchId)
  } catch (err) {
    // REST unreachable — still surface a settled ceremony (empty reveal) so the table doesn't
    // sit on "LIVE" forever; the on-chain claim path stays available via the dashboard.
    log.warn('[settle] detail fetch failed — showing minimal ceremony:', err)
    set((s) =>
      s.settlement
        ? {}
        : {
            settlement: {
              matchId,
              settlementPrice: 0,
              awards: (winnerSeats ?? []).map((seat) => ({ seat, amount: 0n })),
              uncalledReturns: [],
              rakeCollected: 0n,
              revealedPredictions: [],
            },
            yourTurn: null,
            actPending: null,
          },
    )
    stopMatchPoll()
    return
  }

  await landSettlement(set, get, detail, decimals, winnerSeats)
}

/**
 * Put the settlement on screen and, if the payout amounts could not be resolved yet, keep
 * re-resolving them in the background until they land — the ceremony (and its Claim button)
 * then fills in by itself instead of staying at $0 forever.
 */
async function landSettlement(
  set: SetState,
  get: () => GameState,
  detail: MatchDetail,
  decimals: number,
  winnerSeats?: number[],
): Promise<void> {
  const matchId = detail.match_id
  if (matchId !== activeMatchId) return // the player has moved on to another table
  const onchainId = get().terms?.onchainMatchId
  const first = await computeSettlementAwards(detail, onchainId, winnerSeats)
  if (matchId !== activeMatchId) return
  set((s) =>
    s.settlement
      ? {}
      : {
          settlement: settlementFromDetail(detail, decimals, first.awards),
          match: s.match ? { ...s.match, phase: 'SETTLED' } : s.match,
          yourTurn: null,
          actPending: null,
        },
  )
  stopMatchPoll()
  if (first.complete) return

  // Keep at it for a few minutes, and show every improvement as it arrives: the settle
  // price and the revealed calls usually land before the exact payouts do, and a result
  // screen must never sit on an empty first read.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    if (get().settlement?.matchId !== matchId) return // left the table / new match
    let fresh: MatchDetail
    try {
      fresh = await api.getMatch(matchId)
    } catch {
      continue
    }
    const next = await computeSettlementAwards(fresh, onchainId, winnerSeats)
    set((s) =>
      s.settlement?.matchId === matchId
        ? { settlement: settlementFromDetail(fresh, decimals, next.awards) }
        : {},
    )
    if (next.complete) return
  }
  log.warn('[settle] payout amounts never resolved for', matchId)
}

/**
 * Refresh per-seat stacks/committed/folded from REST detail and merge them into `match`.
 *
 * Engine seats (and their buy-in stacks) are assigned at lock, and NO live frame carries
 * per-seat stacks: the `phase`/`your_turn`/`action` stream only moves pot/current_bet/turn.
 * A player connected straight through FILLING → lock only ever received the seatless FILLING
 * snapshot, so without this pull `match.yourStack`/`yourExposure` stay 0 for the whole match
 * (stack / committed / all-in all read 0.00). Called on the LIVE transition and after each
 * action so the HUD's own numbers track the hand as it plays out.
 */
async function refreshMatchSeats(set: SetState, get: () => GameState): Promise<void> {
  const matchId = get().match?.matchId ?? joinMatchId
  if (!matchId) return
  const wallet = adapters?.wallet.address() ?? get().walletAddress
  try {
    const detail = await api.getMatch(matchId)
    const phase = mapPhase(detail.phase)
    const prevPhase = get().match?.phase

    // Terminal phases are supposed to arrive as WS `settled`/`voided` frames, but the
    // gateway can stay silent — recover them from the detail so the resolution shows.
    if (phase === 'SETTLED' && !get().settlement) {
      // Reuse the shared award resolution so the REST self-heal and the WS `settled` frame land
      // an identical ceremony (price + reveals + every seat's real on-chain payout).
      await landSettlement(set, get, detail, get().terms?.decimals ?? 2)
    } else if (phase === 'VOID' && !get().voided) {
      set({ voided: { reason: (detail.void_kind ?? 'Void') as VoidReason }, yourTurn: null, actPending: null })
      stopMatchPoll()
    } else if (phase === 'SEALING' && prevPhase === 'FILLING') {
      // Missed lock broadcast — recover the engine seat / drand round and fire any queued seal.
      void ensureSealContext(set, get)
    }

    if (detail.seats.length === 0) {
      // Still pre-lock — no seats to merge, but keep the phase honest.
      set((s) => (s.match ? { match: { ...s.match, phase } } : {}))
      // The detail carries no seat/candidate count during FILLING, so the "N/M" fill counter
      // can't come from here — it's normally pushed via WS `seat_update`. That push doesn't
      // reliably reach every already-seated subscriber as new players deposit (it only spams at
      // lock), so each client freezes on its own optimistic `seated ? 1`. Reconcile from the
      // lobby listing, which DOES expose the live deposited count, so both clients agree.
      if (phase === 'FILLING') void reconcileFillCount(matchId, set)
      return
    }
    const seats: SeatView[] = detail.seats.map((s) => ({
      seat: s.seat_index,
      wallet: s.wallet,
      stack: BigInt(s.stack ?? 0),
      committedThisStreet: BigInt(s.committed ?? 0),
      totalContribution: BigInt(s.total_contribution ?? 0),
      folded: s.folded ?? false,
      allIn: s.all_in ?? false,
    }))
    const mine =
      (wallet ? detail.seats.find((x) => x.wallet === wallet) : undefined) ??
      (myEngineSeat != null ? detail.seats.find((x) => x.seat_index === myEngineSeat) : undefined)
    if (mine) myEngineSeat = mine.seat_index
    // The hand was dealt and we are not in it (our deposit landed too late, or was never
    // heard). Say so plainly instead of showing a seat that does not exist.
    if (mine || phase === 'FILLING') dealtOutStrikes = 0
    else if (wallet && get().seated && (phase === 'SEALING' || phase === 'LIVE') && get().match?.yourSeat == null && ++dealtOutStrikes >= 2) {
      set({
        seated: false,
        playError: 'This hand was dealt before your seat was confirmed, so you are watching it. Your buy-in is safe and comes back to you — take a seat at the next table.',
      })
    }
    set((s) =>
      s.match
        ? {
            streetSchedule: normalizeSchedule(detail.timing.street_schedule) ?? s.streetSchedule,
            // After a reload the sealed set and our own number are gone from memory: the
            // record says who sealed, and this browser kept what we sealed.
            sealedSeats: detail.seats.filter((x) => x.sealed).length > s.sealedSeats.length
              ? detail.seats.filter((x) => x.sealed).map((x) => x.seat_index)
              : s.sealedSeats,
            sealStatus: mine?.sealed && s.sealStatus === 'unsealed' ? 'sealed' : s.sealStatus,
            yourPrediction: s.yourPrediction ?? (mine?.sealed ? recallCall(matchId) : null),
            // The seal clock normally rides on a WS frame; after a reload that frame is gone.
            sealDeadline: detail.timing.seal_deadline != null ? toEpochMs(detail.timing.seal_deadline) : s.sealDeadline,
            match: {
              ...s.match,
              seats,
              // The detail is the same authoritative view the snapshot mirrors — sync the
              // table-level state too, so a missed WS frame (timer-driven street close,
              // reconnect gap) self-heals on the next pull instead of freezing the round.
              phase,
              round: detail.round ?? s.match.round,
              pot: detail.pot != null ? BigInt(detail.pot) : s.match.pot,
              currentBet: detail.current_bet != null ? BigInt(detail.current_bet) : s.match.currentBet,
              toActSeat: detail.to_act ?? null,
              buttonSeat: detail.button != null ? (liveButton = detail.button) : s.match.buttonSeat,
              yourSeat: mine?.seat_index ?? s.match.yourSeat,
              yourStack: mine?.stack != null ? BigInt(mine.stack) : s.match.yourStack,
              yourExposure: mine?.total_contribution != null ? BigInt(mine.total_contribution) : s.match.yourExposure,
            },
          }
        : {},
    )

    // Refresh-proof turns: `your_turn` fires ONCE and is never re-sent — a reload or socket
    // blip during your turn used to mean a guaranteed timeout fold. If the detail says our
    // seat is to act and no turn is latched, recover it. A patched server includes the open
    // turn verbatim (`detail.turn`, TRUE deadline); otherwise reconstruct: to_call derives
    // exactly; min_raise_to is a floor approximation (the server rejects an under-raise,
    // and fold/check/call/all-in stay valid regardless); the deadline is an ESTIMATE.
    const st = get()
    if (
      phase === 'LIVE' &&
      mine != null &&
      detail.to_act === mine.seat_index &&
      st.yourTurn == null &&
      st.actPending == null
    ) {
      const t = detail.turn ?? detail.open_turn
      if (t && t.seat === mine.seat_index) {
        adoptTurnHead(t)
        if (Date.now() < t.deadline_ms) {
          log.debug('[turn] recovered from detail — to_call', t.to_call, 'deadline_ms', t.deadline_ms)
          set({ yourTurn: { toCall: t.to_call, minRaiseTo: t.min_raise_to, deadline: t.deadline_ms } })
        }
      } else {
        const currentBet = detail.current_bet ?? 0
        const toCall = Math.max(0, currentBet - (mine.committed ?? 0))
        const bigBlind = Number(st.terms?.bigBlind ?? 0) // yourTurn amounts are plain numbers (wire)
        const minRaiseTo = Math.max(currentBet * 2, currentBet + bigBlind, bigBlind)
        const timeoutMs = (st.terms?.actionTimerSec ?? 25) * 1000
        log.debug('[turn] reconstructed from REST detail — to_call', toCall, 'minRaiseTo', minRaiseTo)
        set({ yourTurn: { toCall, minRaiseTo, deadline: Date.now() + timeoutMs } })
      }
    }
  } catch (err) {
    log.warn('[seats] refresh failed:', err)
  }
}

/** Pre-lock (FILLING) fill-count reconcile. Neither the snapshot nor the match detail carries
 *  a seat/candidate count until engine seats assign at lock, and the WS `seat_update` push
 *  doesn't reliably reach every subscriber as players join — so the "N/M" counter can freeze on
 *  each client's own optimistic 1. The public lobby listing DOES expose the live deposited
 *  count; pull it so the waiting room self-heals to the true number. Public rooms only (private
 *  rooms aren't listed — they fall back to the WS push). */
async function reconcileFillCount(matchId: string, set: SetState): Promise<void> {
  try {
    const { rooms } = await api.getLobby()
    const room = rooms.find((r) => r.match_id === matchId)
    if (!room) return
    // `candidates` counts everyone who has deposited (what "waiting" should show); `confirmed`
    // is the post-verification subset. Take the larger so the count is right under either
    // backend semantic and can only ever advance toward the true occupancy.
    const count = Math.max(room.candidates ?? 0, room.confirmed ?? 0)
    set((s) => (s.lobbySeated === count ? {} : { lobbySeated: count }))
  } catch (err) {
    log.warn('[fill] lobby count reconcile failed:', err)
  }
}

/** Adopt the action-chain head a turn frame/view carries (`head_hex`). Returns false when
 *  the server sent none (older builds) so callers can fall back to the journal. */
function adoptTurnHead(turn: Pick<WsTurn, 'head_hex'>): boolean {
  if (!turn.head_hex) return false
  try {
    actionHead = hexToBytes32(turn.head_hex)
    return true
  } catch {
    return false
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

/** Convert a raw integer WAD string ("63056845000000000000000" = 63056.845e18) to fixed-point. */
function wadToFixed(wad: string, decimals: number): number {
  try {
    return Number(BigInt(wad) / 10n ** BigInt(18 - decimals))
  } catch {
    return 0
  }
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
      await ensureServerConfig() // the server's default chip mint (no build-time env needed)
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

// Seat aliases follow the wallet, so the same player reads as the same name hand after hand.
useGameStore.subscribe((s, prev) => {
  if (s.match?.seats !== prev.match?.seats) setSeatWallets(s.match?.seats ?? [])
})
