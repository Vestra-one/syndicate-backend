/**
 * Satoshi's Table — frontend ↔ backend protocol & shared types.
 *
 * The single source of wire types for the client. Mirrors the backend gateway
 * messages, the action-feed public events, the match-engine action set, and the
 * on-chain DTOs. Status tags: [live] · [contract] (backend wiring) · [client] duty.
 *
 * Money convention: ALL amounts are integers in the betting token's smallest unit
 * (e.g. micro-USDC). ALL prices are fixed-point integers at the feed's `decimals`
 * (e.g. 63000.42 @ 2dp -> 6300042). Never use floats for money or prices.
 */

// ---------------------------------------------------------------------------
// Lifecycle & primitives
// ---------------------------------------------------------------------------

export type MatchPhase =
  | 'FILLING' // accepting deposits (seats open)
  | 'SEALING' // seats frozen; predictions being time-lock sealed
  | 'LIVE' // betting in progress
  | 'SETTLEMENT_WINDOW' // final window; oracle sampled
  | 'DECRYPT' // time-lock opens; predictions decrypt
  | 'SETTLED' // final; payouts claimable
  | 'VOID' // aborted; full refund

export type Chips = number // integer, token base units
export type FixedPrice = number // integer fixed-point at feed `decimals`
export type Wallet = string // base58 Solana pubkey
export type SeatIndex = number // 0..maxPlayers-1 (pseudonymous id in public feed)

// ---------------------------------------------------------------------------
// Betting actions (match-engine)  [contract]
// ---------------------------------------------------------------------------

export type BettingAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'betTo'; amount: Chips } // total street commitment after the bet
  | { type: 'raiseTo'; amount: Chips } // total street commitment after the raise (>= minRaiseTo)
  | { type: 'allIn' }

export type DefaultAction = 'check_fold' | 'check_call_any' // pre-signed timeout fallback

// ---------------------------------------------------------------------------
// Gateway auth handshake  [live] (implemented today)
// ---------------------------------------------------------------------------

export interface ChallengeMsg {
  type: 'challenge'
  nonce: string
}
/** signature = base64( ed25519_sign(wallet_privkey, utf8(nonce)) ) */
export interface AuthMsg {
  type: 'auth'
  wallet: Wallet
  signature: string
}
export interface AuthenticatedMsg {
  type: 'authenticated'
  wallet: Wallet
}
export interface ErrorMsg {
  type: 'error'
  reason: GatewayErrorReason
}

export type GatewayErrorReason =
  | 'geo-blocked'
  | 'bad signature'
  | 'nonce expired'
  | 'wallet mismatch'
  | string

// ---------------------------------------------------------------------------
// Table / lobby / match views  [contract]
// ---------------------------------------------------------------------------

export interface TableTerms {
  tableId: string
  priceFeedId: string // e.g. "BTC/USD" — the instrument predicted
  supportedFeeds: string[] // launch defaults: BTC/USD, ETH/USD, SOL/USD
  chipsToken: string // e.g. "USDC" — what you stake/win (decoupled from feed)
  decimals: number // fixed-point precision for prices on this feed
  oracleAdapter: 'pyth'
  settlementMode: 'bounded-exact-after'
  oracleDelayWindowSec: number // default 5; first valid Pyth update after match end
  oracleUnavailableMessage: string
  buyIn: Chips
  entryFee: Chips // taken at deposit; refunded on VOID/leave-before-LIVE
  rakeBps: number // pot rake at settlement
  rakeCap: Chips
  smallBlind: Chips
  bigBlind: Chips
  minPlayers: number
  maxPlayers: number
  roundCount: number
  roundDurationsSec: number[]
  actionTimerSec: number
  timeBankSec: number
  settlementWindowSec: number
  geofenceBlocklist: string[] // server-driven; launch default includes "IN"
  allowDuplicateWalletPerMatch: false
  /** drand round the prediction must be sealed toward (match end). */
  timelockTargetRound: number
}

export interface SeatView {
  seat: SeatIndex
  wallet?: Wallet // present only for self; pseudonymous (omitted) for others
  stack: Chips // remaining
  committedThisStreet: Chips
  totalContribution: Chips
  folded: boolean
  allIn: boolean
}

export interface MatchStateView {
  matchId: string
  phase: MatchPhase
  round: number // 1..roundCount
  pot: Chips
  currentBet: Chips // highest street commitment
  buttonSeat: SeatIndex
  toActSeat: SeatIndex | null
  seats: SeatView[]
  feedPrice: FixedPrice // latest market price (drives the chart)
  // self-centric helpers (only for the authenticated player):
  yourSeat?: SeatIndex
  yourStack?: Chips
  yourExposure?: Chips // total committed this match
}

// ---------------------------------------------------------------------------
// Public action-feed events (mirrors services/action-feed)  [contract]
// Spectators & players receive these. NEVER contains sealed predictions
// (before time-lock open), queued intents, or wallets — seat-indexed only.
// ---------------------------------------------------------------------------

export type PublicEvent =
  | {
      kind: 'action'
      matchId: string
      seat: SeatIndex
      action: string
      amount: Chips
      feedPrice: FixedPrice
      pot: Chips
      ts: number
    }
  | { kind: 'fold'; matchId: string; seat: SeatIndex; ts: number }
  | { kind: 'round'; matchId: string; round: number; ts: number }
  | {
      kind: 'settlement'
      matchId: string
      settlementPrice: FixedPrice
      awards: { seat: SeatIndex; amount: Chips }[]
      ts: number
    }
  | { kind: 'reveal'; matchId: string; seat: SeatIndex; prediction: FixedPrice; ts: number } // only after time-lock open

// ---------------------------------------------------------------------------
// Resolution  [contract]
// ---------------------------------------------------------------------------

export interface SettlementView {
  matchId: string
  settlementPrice: FixedPrice
  awards: { seat: SeatIndex; amount: Chips }[]
  uncalledReturns: { seat: SeatIndex; amount: Chips }[]
  rakeCollected: Chips
  /** opened post-match for everyone (incl. folders) — the emotional/audit reveal. */
  revealedPredictions: { seat: SeatIndex; prediction: FixedPrice }[]
}

export type VoidReason =
  | 'EngineIncomplete'
  | 'OracleDegraded'
  | 'TimelockUnavailable'
  | 'MissingPrediction'
  | 'ConservationFailure'
  | 'NotEnoughPlayers'
  | string

// ---------------------------------------------------------------------------
// Dashboard / discovery  [contract]
// ---------------------------------------------------------------------------

export interface LiveGame {
  matchId: string
  feed: string
  buyIn: Chips
  potSize: Chips
  spectators: number
  actionsPerMin: number
  startedAt: number
}
export type DashboardSortKey = 'gameTime' | 'potSize' | 'buyIn' | 'feed'

export interface MatchHistorySummary {
  matchId: string
  status: 'live' | 'settled' | 'voided'
  feed: string
  buyIn: Chips
  startedAt: number
  lastEventTs: number
  settlementPrice?: FixedPrice
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
// Client -> server  (after auth)  [contract]
// ---------------------------------------------------------------------------

export type ClientMessage =
  | AuthMsg
  | { type: 'subscribe'; matchId: string } // spectate
  | { type: 'sealPrediction'; matchId: string; ciphertext: string } // tlock ciphertext, base64 [client]
  | { type: 'act'; matchId: string; action: BettingAction; signature: string } // signed intent [client]
  | { type: 'setDefault'; matchId: string; default: DefaultAction }
  | { type: 'ping' }

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | ChallengeMsg
  | AuthenticatedMsg
  | ErrorMsg // [live]
  | { type: 'tableTerms'; terms: TableTerms } // [contract]
  | { type: 'matchState'; state: MatchStateView } // [contract]
  | { type: 'yourTurn'; matchId: string; toCall: Chips; minRaiseTo: Chips; deadline: number } // [contract]
  | { type: 'event'; event: PublicEvent } // [contract] (broadcast path [live])
  | { type: 'activeGames'; games: LiveGame[] } // [contract]
  | { type: 'matchHistory'; matches: MatchHistorySummary[] } // [contract]
  | { type: 'profile'; profile: PublicProfile } // [contract]
  | { type: 'leaderboard'; entries: LeaderboardEntry[] } // [contract]
  | { type: 'settled'; result: SettlementView } // [contract]
  | { type: 'void'; matchId: string; reason: VoidReason } // [contract]

// ---------------------------------------------------------------------------
// On-chain DTOs (Anchor program)  [contract][client]
// The client builds these via @solana/web3.js + the Anchor IDL; the wallet signs.
// ---------------------------------------------------------------------------

export interface DepositArgs {
  matchId: string
  seatIndex: SeatIndex
} // transfers buyIn + entryFee
export interface ClaimArgs {
  matchId: string
} // pull payout after SETTLED (idempotent)
export interface RefundArgs {
  matchId: string
} // reclaim deposit + entry fee after VOID

/** PDA seeds (for deriving accounts client-side; the IDL also encodes these). */
export const PDA_SEEDS = {
  match: (matchId: string) => ['match', matchId],
  vault: (matchPda: string) => ['vault', matchPda],
  seat: (matchPda: string, player: Wallet) => ['seat', matchPda, player],
} as const

// ---------------------------------------------------------------------------
// drand quicknet (client-side time-lock)  [client]
// ---------------------------------------------------------------------------

export const DRAND = {
  api: 'https://api.drand.sh',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', // quicknet
} as const

/** Round at/after a unix time, given chain genesis + period (matches backend round_at). */
export function roundAt(genesisTime: number, period: number, unixTime: number): number {
  if (period === 0 || unixTime <= genesisTime) return 1
  return Math.floor((unixTime - genesisTime + period - 1) / period) + 1
}
