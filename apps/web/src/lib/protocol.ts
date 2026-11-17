/**
 * Satoshi Table — frontend ↔ backend protocol & shared types.
 *
 * Single source of wire types for the client. Mirrors the backend gateway
 * messages, the action-feed public events, the match-engine action set, and the
 * on-chain DTOs. Status: 🟢 live · 🟡 contract (backend wiring) · 🔵 client duty.
 *
 * Money convention: ALL amounts are integers in the betting token's smallest unit
 * (e.g. micro-USDC). ALL prices are fixed-point integers at the feed's `decimals`
 * (e.g. 63000.42 @ 2dp → 6300042). Never use floats for money or prices.
 */

// ---------------------------------------------------------------------------
// Lifecycle & primitives
// ---------------------------------------------------------------------------

export type MatchPhase =
  | 'FILLING'           // accepting deposits (seats open)
  | 'SEALING'           // seats frozen; predictions being time-lock sealed
  | 'LIVE'              // betting in progress
  | 'SETTLEMENT_WINDOW' // final window; oracle sampled
  | 'DECRYPT'           // time-lock opens; predictions decrypt
  | 'SETTLED'           // final; payouts claimable
  | 'VOID'              // aborted; full refund

/**
 * Phases meaning "this match has moved past the join window". Used as an allowlist
 * (not `phase !== 'FILLING'`) because the gateway's subscribe response for a room it
 * has no live engine state for yet comes back with an undocumented phase of "UNKNOWN" —
 * a blocklist check would misread that as "already started".
 */
export const PAST_FILLING_PHASES: MatchPhase[] = [
  'SEALING', 'LIVE', 'SETTLEMENT_WINDOW', 'DECRYPT', 'SETTLED', 'VOID',
]

/**
 * Phases in which the gateway supplies the authoritative price (it rides in on
 * `action` frames once the hand is LIVE). Through FILLING *and* SEALING no gateway
 * price flows, so the always-on spot feed must keep the chart — and the seal panel's
 * live price — alive. Notably this EXCLUDES 'SEALING', unlike PAST_FILLING_PHASES.
 */
export const GATEWAY_PRICE_PHASES: MatchPhase[] = [
  'LIVE', 'SETTLEMENT_WINDOW', 'DECRYPT', 'SETTLED', 'VOID',
]

export type Chips = bigint      // integer, token base units (u64 — exact, no float rounding)
export type FixedPrice = number // integer fixed-point at feed `decimals`
export type Wallet = string     // base58 Solana pubkey
export type SeatIndex = number  // 0..maxPlayers-1

// ---------------------------------------------------------------------------
// Betting actions (match-engine)  🟡
// ---------------------------------------------------------------------------

export type BettingAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'betTo'; amount: Chips }
  | { type: 'raiseTo'; amount: Chips }
  | { type: 'allIn' }

export type DefaultAction = 'check_fold' | 'check_call_any'

// ---------------------------------------------------------------------------
// Gateway auth handshake  🟢
// ---------------------------------------------------------------------------

export interface ChallengeMsg { type: 'challenge'; nonce: string }
/** signature = base64( ed25519_sign(wallet_privkey, utf8(nonce)) ) */
export interface AuthMsg { type: 'auth'; wallet: Wallet; signature: string }
export interface AuthenticatedMsg { type: 'authenticated'; wallet: Wallet }
export interface ErrorMsg { type: 'error'; reason: GatewayErrorReason }

export type GatewayErrorReason =
  | 'geo-blocked'
  | 'bad signature'
  | 'nonce expired'
  | 'wallet mismatch'
  | string

// ---------------------------------------------------------------------------
// Table / lobby / match views  🟡
// ---------------------------------------------------------------------------

export interface TableTerms {
  tableId: string
  priceFeedId: string       // e.g. "BTC/USD"
  supportedFeeds: string[]
  chipsToken: string        // e.g. "USDC"
  /** SPL mint the match is denominated in (`params.chips_token_mint`) — a match can use any
   *  operator-allowed token, so money instructions follow THIS, not a global default. */
  chipsTokenMint?: string
  decimals: number
  oracleAdapter: 'signed-price'
  settlementMode: 'exact-timestamp'
  oracleUnavailableMessage: string
  buyIn: Chips
  entryFee: Chips
  rakeBps: number
  rakeCap: Chips
  smallBlind: Chips
  bigBlind: Chips
  /** Posted by every seat at the start of the hand (10% of the buy-in). */
  ante?: Chips
  minPlayers: number
  maxPlayers: number
  roundCount: number
  roundDurationsSec: number[]
  actionTimerSec: number
  timeBankSec: number
  settlementWindowSec: number
  geofenceBlocklist: string[]
  allowDuplicateWalletPerMatch: false
  fillWindowSec?: number
  practiceMode?: boolean
  timelockTargetRound: number
  onchainMatchId?: string
  matchPda?: string
}

export interface QueueStatus {
  active: boolean
  playersWaiting: number
  seated: number
  minPlayers: number
  maxPlayers: number
  fillDeadline: number | null
  matchId?: string
  onchainMatchId?: string
  matchPda?: string
}

export interface RoomLobby {
  roomCode: string
  matchId: string
  onchainMatchId?: string
  matchPda?: string
  seated: number
  minPlayers: number
  maxPlayers: number
  canHostStart: boolean
  fillDeadline: number
  isHost: boolean
  phase: MatchPhase
}

export interface SeatView {
  seat: SeatIndex
  wallet?: Wallet
  stack: Chips
  committedThisStreet: Chips
  totalContribution: Chips
  folded: boolean
  allIn: boolean
}

export interface MatchStateView {
  matchId: string
  phase: MatchPhase
  round: number
  pot: Chips
  currentBet: Chips
  buttonSeat: SeatIndex
  toActSeat: SeatIndex | null
  seats: SeatView[]
  feedPrice: FixedPrice
  yourSeat?: SeatIndex
  yourStack?: Chips
  yourExposure?: Chips
}

// ---------------------------------------------------------------------------
// Public action-feed events  🟡
// ---------------------------------------------------------------------------

export type PublicEvent =
  | { kind: 'action'; matchId: string; seat: SeatIndex; action: string; amount: Chips; feedPrice: FixedPrice; pot: Chips; ts: number }
  | { kind: 'fold'; matchId: string; seat: SeatIndex; ts: number }
  | { kind: 'round'; matchId: string; round: number; ts: number }
  | { kind: 'settlement'; matchId: string; settlementPrice: FixedPrice; awards: { seat: SeatIndex; amount: Chips }[]; ts: number }
  | { kind: 'reveal'; matchId: string; seat: SeatIndex; prediction: FixedPrice; ts: number }

// ---------------------------------------------------------------------------
// Resolution  🟡
// ---------------------------------------------------------------------------

export interface SettlementView {
  matchId: string
  settlementPrice: FixedPrice
  awards: { seat: SeatIndex; amount: Chips }[]
  uncalledReturns: { seat: SeatIndex; amount: Chips }[]
  /** The pot that was actually contested (bets before rake). `awards` are larger: each
   *  also returns the seat's un-bet stack. Absent on servers that don't report it. */
  finalPot?: Chips
  rakeCollected: Chips
  oracleProof?: SignedPriceView
  revealedPredictions: { seat: SeatIndex; prediction: FixedPrice }[]
}

export interface SignedPriceView {
  adapter: 'signed-price'
  tokenHex: string
  priceInWadHex: string
  timestampMs: number
  v: number
  rHex: string
  sHex: string
  signerHex: string
  settlementTxSignatures: string[]
  price: FixedPrice
}

export type VoidReason =
  | 'EngineIncomplete' | 'OracleDegraded' | 'TimelockUnavailable'
  | 'MissingPrediction' | 'ConservationFailure' | 'NotEnoughPlayers' | string

// ---------------------------------------------------------------------------
// Dashboard / discovery  🟡
// ---------------------------------------------------------------------------

export interface LiveGame {
  matchId: string
  onchainMatchId?: string
  feed: string
  buyIn: Chips
  potSize: Chips
  spectators: number
  actionsPerMin: number
  startedAt: number
  seated?: number
  maxPlayers?: number
  round?: number
  roundCount?: number
  creatorWallet?: string
  creatorHandle?: string
}

export interface UpcomingGame {
  matchId: string
  onchainMatchId?: string
  feed: string
  buyIn: Chips
  entryFee?: Chips
  seated: number
  maxPlayers: number
  minPlayers?: number
  fillDeadline?: number
  creatorWallet?: string
  creatorHandle?: string
}

export type DashboardSortKey = 'gameTime' | 'potSize' | 'buyIn' | 'newest'

/** A settled (or voided) hand for the "Past hands" section — mapped from `HistoryMatch`. */
export interface PastHand {
  matchId: string
  onchainMatchId?: string
  feed: string
  buyIn: Chips
  maxPlayers?: number
  voidKind: string | null
  finalPot: Chips | null
  rake: Chips | null
  settlementPriceWad: string | null
  settlementTxSig: string | null
  endedAt: number
  winner: { wallet: string; handle: string | null; potWon: Chips | null } | null
}

export interface MatchHistorySummary {
  matchId: string
  status: 'live' | 'settled' | 'voided'
  feed: string
  buyIn: Chips
  startedAt: number
  lastEventTs: number
  settlementPrice?: FixedPrice
  oracleProof?: SignedPriceView
  replayBundleUri?: string
  summary: { finalPot: Chips; awardTotal: Chips; actionCount: number; revealCount: number }
}

export interface PublicProfile {
  userId: string
  handle: string
  avatarUri?: string
  house?: string
  chamber?: string
  rank?: string
  stats: {
    matchesPlayed: number
    matchesWon: number
    totalBuyIn: Chips
    totalPayout: Chips
    showdownCount: number
    foldCount: number
    achievementCount: number
  }
}

export interface LeaderboardEntry {
  userId: string
  handle: string
  matchesPlayed: number
  roi: number
  totalPayout: Chips
  achievements: number
}

// ---------------------------------------------------------------------------
// Lobby listings (matchmaking REST + WS)  🟡
// ---------------------------------------------------------------------------

export interface RoomListing {
  roomCode: string
  matchId: string
  onchainMatchId?: string
  feedId: string
  tierId: string
  configHash?: string
  buyIn?: Chips
  seated: number
  minPlayers: number
  maxPlayers: number
  fillDeadline: number
}

export interface RoomsUpdate {
  kind: 'upsert' | 'started'
  roomCode?: string
  matchId: string
  feedId?: string
  tierId?: string
  configHash?: string
  buyIn?: Chips
  seated: number
  maxPlayers?: number
  fillDeadline?: number
  version: number
}

/** POST /rooms — host reports a verified create_and_deposit txhash. */
export interface CreateRoomReport {
  createTxSig: string
  matchPda: string
  onchainMatchId: string
  configHash: string
  wallet: Wallet
  seatIndex?: SeatIndex
  maxPlayers?: number
}

/** POST /matches/:matchId/deposits — joiner reports a verified deposit txhash. */
export interface DepositReport {
  depositTxSig: string
  wallet: Wallet
  seatIndex?: SeatIndex
}

// ---------------------------------------------------------------------------
// Client → server  (after auth)  🟡
// ---------------------------------------------------------------------------

export type ClientMessage =
  | AuthMsg
  | { type: 'subscribe'; matchId: string }
  | {
      type: 'sealPrediction'
      matchId: string
      seatIndex: SeatIndex
      ciphertext: string
      commitmentHex: string
      targetRound: number
      blindingHex: string
      signature: string
    }
  | { type: 'act'; matchId: string; action: BettingAction; signature: string }
  | { type: 'setDefault'; matchId: string; default: DefaultAction }
  | { type: 'subscribeLobby'; feed?: string; template?: string; buyIn?: Chips }
  | { type: 'unsubscribeLobby' }
  | { type: 'ping' }

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | ChallengeMsg | AuthenticatedMsg | ErrorMsg
  | { type: 'tableTerms'; terms: TableTerms }
  | { type: 'matchState'; state: MatchStateView; sealEndsAt?: number; bettingEndsAt?: number; matchEndsAt?: number }
  | { type: 'yourTurn'; matchId: string; toCall: Chips; minRaiseTo: Chips; yourTurnDeadline?: number; sealEndsAt?: number; bettingEndsAt?: number; matchEndsAt?: number }
  | { type: 'event'; event: PublicEvent }
  | { type: 'activeGames'; games: LiveGame[] }
  | { type: 'matchHistory'; matches: MatchHistorySummary[] }
  | { type: 'profile'; profile: PublicProfile }
  | { type: 'leaderboard'; entries: LeaderboardEntry[] }
  | { type: 'settled'; result: SettlementView }
  | { type: 'void'; matchId: string; reason: VoidReason }
  | { type: 'lobbyState'; lobby: RoomLobby }
  | { type: 'lobbyList'; rooms: RoomListing[] }
  | { type: 'roomsUpdated'; update: RoomsUpdate }
  | { type: 'queueStatus'; status: QueueStatus }
  | { type: 'pong' }

/** Every server envelope is stamped with the gateway clock for clock-sync. */
export type ServerEnvelope = ServerMessage & { serverTime: number }

/** Compute remaining ms on an absolute deadline using the synced server clock. */
export function remainingMs(deadline: number, serverTime: number, localNow: number): number {
  const localOffset = localNow - serverTime
  return Math.max(0, deadline - (Date.now() - localOffset))
}

// ---------------------------------------------------------------------------
// On-chain DTOs  🟡🔵
// ---------------------------------------------------------------------------

export interface CreateAndDepositArgs {
  onchainMatchId: string
  configHash: string
  priceTokenHex: string
  seatIndex: SeatIndex
}
export interface DepositArgs { matchId: string; seatIndex: SeatIndex }
export interface RegisterPredictionCommitmentArgs {
  onchainMatchId: string
  commitmentHex: string
  timelockTargetRound: number
}
export interface ClaimArgs { matchId: string }
export interface RefundArgs { matchId: string }

/** PDA seeds (for deriving accounts client-side; mirrors IDL seeds). */
export const PDA_SEEDS = {
  match: (onchainMatchId: string) => ['match', u64LeBytes(onchainMatchId)] as const,
  vault: (matchPda: string) => ['vault', matchPda] as const,
  seat: (matchPda: string, player: Wallet) => ['seat', matchPda, player] as const,
  seatIndex: (matchPda: string, seatIndex: number) => ['seat-index', matchPda, u16LeBytes(seatIndex)] as const,
} as const

function u64LeBytes(id: string): Uint8Array {
  let v = BigInt(id)
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n }
  return out
}

function u16LeBytes(n: number): Uint8Array {
  const out = new Uint8Array(2)
  out[0] = n & 0xff
  out[1] = (n >> 8) & 0xff
  return out
}

// ---------------------------------------------------------------------------
// drand quicknet (client-side time-lock)  🔵
// ---------------------------------------------------------------------------

export const DRAND = {
  api: 'https://api.drand.sh',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', // quicknet
} as const

export function roundAt(genesisTime: number, period: number, unixTime: number): number {
  if (period === 0 || unixTime <= genesisTime) return 1
  return Math.floor((unixTime - genesisTime + period - 1) / period) + 1
}
