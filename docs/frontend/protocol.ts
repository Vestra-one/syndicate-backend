/**
 * Syndicate — frontend ⇄ backend protocol & shared types.
 *
 * Copy this into the frontend repo as the single source of wire types. It mirrors the
 * backend's gateway messages, the action-feed public events, the match-engine action
 * set, and the on-chain DTOs. Status tags: 🟢 live · 🟡 contract (backend wiring) · 🔵 client duty.
 *
 * Money convention: ALL amounts are integers in the betting token's smallest unit
 * (e.g. micro-USDC). ALL prices are fixed-point integers at the feed's `decimals`
 * (e.g. 63000.42 @ 2dp -> 6300042). Never use floats for money or prices.
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
  | 'VOID';             // aborted; full refund

export type Chips = number; // integer, token base units
export type FixedPrice = number; // integer fixed-point at feed `decimals`
export type Wallet = string; // base58 Solana pubkey
export type SeatIndex = number; // 0..maxPlayers-1 (pseudonymous id in public feed)

// ---------------------------------------------------------------------------
// Betting actions (match-engine)  🟡
// ---------------------------------------------------------------------------

export type BettingAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'betTo'; amount: Chips }   // total street commitment after the bet
  | { type: 'raiseTo'; amount: Chips } // total street commitment after the raise (>= minRaiseTo)
  | { type: 'allIn' };

export type DefaultAction = 'check_fold' | 'check_call_any'; // pre-signed timeout fallback

// ---------------------------------------------------------------------------
// Gateway auth handshake  🟢 (implemented today)
// ---------------------------------------------------------------------------

export interface ChallengeMsg { type: 'challenge'; nonce: string; }
/** signature = base64( ed25519_sign(wallet_privkey, utf8(nonce)) ) */
export interface AuthMsg { type: 'auth'; wallet: Wallet; signature: string; }
export interface AuthenticatedMsg { type: 'authenticated'; wallet: Wallet; }
export interface ErrorMsg { type: 'error'; reason: GatewayErrorReason; }

export type GatewayErrorReason =
  | 'geo-blocked'
  | 'bad signature'
  | 'nonce expired'
  | 'wallet mismatch'
  | string;

// ---------------------------------------------------------------------------
// Table / lobby / match views  🟡
// ---------------------------------------------------------------------------

export interface TableTerms {
  tableId: string;
  priceFeedId: string;     // e.g. "BTC/USD" — the instrument predicted
  supportedFeeds: string[]; // launch defaults: BTC/USD, ETH/USD, SOL/USD
  chipsToken: string;      // e.g. "USDC" — what you stake/win (decoupled from feed)
  decimals: number;        // fixed-point precision for prices on this feed
  oracleAdapter: 'pyth';
  settlementMode: 'bounded-exact-after';
  oracleDelayWindowSec: number; // default 5; first valid Pyth update after match end
  oracleUnavailableMessage: string;
  buyIn: Chips;
  entryFee: Chips;         // taken at deposit; refunded on VOID/leave-before-LIVE
  rakeBps: number;         // pot rake at settlement
  rakeCap: Chips;
  smallBlind: Chips;
  bigBlind: Chips;
  minPlayers: number;
  maxPlayers: number;
  roundCount: number;
  roundDurationsSec: number[];
  actionTimerSec: number;
  timeBankSec: number;
  settlementWindowSec: number;
  geofenceBlocklist: string[]; // server-driven; launch default includes "IN"
  allowDuplicateWalletPerMatch: false;
  fillWindowSec?: number;
  practiceMode?: boolean;
  /** drand round the prediction must be sealed toward (match end). */
  timelockTargetRound: number;
  onchainMatchId?: string;
  matchPda?: string;
}

/** Public matchmaking queue snapshot (matchmaking REST + gateway WS). */
export interface QueueStatus {
  active: boolean;
  playersWaiting: number;
  seated: number;
  minPlayers: number;
  maxPlayers: number;
  fillDeadline: number | null;
  matchId?: string;
  onchainMatchId?: string;
  matchPda?: string;
}

/** Private room lobby snapshot. */
export interface RoomLobby {
  roomCode: string;
  matchId: string;
  onchainMatchId?: string;
  matchPda?: string;
  seated: number;
  minPlayers: number;
  maxPlayers: number;
  canHostStart: boolean;
  fillDeadline: number;
  isHost: boolean;
  phase: MatchPhase;
}

export interface SeatView {
  seat: SeatIndex;
  wallet?: Wallet;     // present only for self; pseudonymous (omitted) for others
  stack: Chips;        // remaining
  committedThisStreet: Chips;
  totalContribution: Chips;
  folded: boolean;
  allIn: boolean;
}

export interface MatchStateView {
  matchId: string;
  phase: MatchPhase;
  round: number;           // 1..roundCount
  pot: Chips;
  currentBet: Chips;       // highest street commitment
  buttonSeat: SeatIndex;
  toActSeat: SeatIndex | null;
  seats: SeatView[];
  feedPrice: FixedPrice;   // latest market price (drives the chart)
  // self-centric helpers (only for the authenticated player):
  yourSeat?: SeatIndex;
  yourStack?: Chips;
  yourExposure?: Chips;    // total committed this match
}

// ---------------------------------------------------------------------------
// Public action-feed events (mirrors services/action-feed)  🟡
// Spectators & players receive these. NEVER contains sealed predictions
// (before time-lock open), queued intents, or wallets — seat-indexed only.
// ---------------------------------------------------------------------------

export type PublicEvent =
  | { kind: 'action'; matchId: string; seat: SeatIndex; action: string; amount: Chips; feedPrice: FixedPrice; pot: Chips; ts: number }
  | { kind: 'fold'; matchId: string; seat: SeatIndex; ts: number }
  | { kind: 'round'; matchId: string; round: number; ts: number }
  | { kind: 'settlement'; matchId: string; settlementPrice: FixedPrice; awards: { seat: SeatIndex; amount: Chips }[]; ts: number }
  | { kind: 'reveal'; matchId: string; seat: SeatIndex; prediction: FixedPrice; ts: number }; // only after time-lock open

// ---------------------------------------------------------------------------
// Resolution  🟡
// ---------------------------------------------------------------------------

export interface SettlementView {
  matchId: string;
  settlementPrice: FixedPrice;
  awards: { seat: SeatIndex; amount: Chips }[];
  uncalledReturns: { seat: SeatIndex; amount: Chips }[];
  rakeCollected: Chips;
  oracleProof?: PythOracleProofView;
  /** opened post-match for everyone (incl. folders) — the emotional/audit reveal. */
  revealedPredictions: { seat: SeatIndex; prediction: FixedPrice }[];
}

export interface PythOracleProofView {
  adapter: 'pyth';
  mode: 'pull-receiver-full-verification';
  feedIdHex: string;
  price: FixedPrice;
  publishTime: number;
  confidence: string; // u64 as a decimal string
  exponent: number;
  priceUpdateAccount: string;
  atomicSettlementTxSignature: string;
  receiverProgramId: string;
  wormholeProgramId: string;
  pushOracleProgramId: string;
  hermesResponseHash: string; // sha256 hex
  binaryUpdateHash: string;   // sha256 hex over selected binary update data
}

export type VoidReason =
  | 'EngineIncomplete' | 'OracleDegraded' | 'TimelockUnavailable'
  | 'MissingPrediction' | 'ConservationFailure' | 'NotEnoughPlayers' | string;

// ---------------------------------------------------------------------------
// Dashboard / discovery  🟡
// ---------------------------------------------------------------------------

export interface LiveGame {
  matchId: string;
  feed: string;
  buyIn: Chips;
  potSize: Chips;
  spectators: number;
  actionsPerMin: number;
  startedAt: number;
}
export type DashboardSortKey = 'gameTime' | 'potSize' | 'buyIn' | 'feed';

export interface MatchHistorySummary {
  matchId: string;
  status: 'live' | 'settled' | 'voided';
  feed: string;
  buyIn: Chips;
  startedAt: number;
  lastEventTs: number;
  settlementPrice?: FixedPrice;
  oracleProof?: PythOracleProofView;
  replayBundleUri?: string;
  summary: { finalPot: Chips; awardTotal: Chips; actionCount: number; revealCount: number };
}

export interface HistoricalGamesResponse {
  /** Default REST response excludes `live`; pass status=all to include it. */
  matches: MatchHistorySummary[];
  /** Opaque cursor from the last returned item; omit when there is no next page. */
  nextCursor?: string;
}

export interface MatchHistoryResponse {
  match: MatchHistorySummary;
}

export interface MatchActionsResponse {
  matchId: string;
  /** Chronological, public, redacted events for rendering a historical-game timeline. */
  events: PublicEvent[];
}

export interface MatchReplayBundle {
  matchId: string;
  fromSeq: number;
  toSeq: number;
  events: PublicEvent[];
  oracleProof?: PythOracleProofView;
  contentHash: string;
  objectUri: string;
}

export interface MatchReplayResponse {
  bundle: MatchReplayBundle;
}

export interface PublicProfile {
  userId: string;
  handle: string;
  avatarUri?: string;
  house?: string;
  chamber?: string;
  rank?: string;
  stats: {
    matchesPlayed: number;
    matchesWon: number;
    totalBuyIn: Chips;
    totalPayout: Chips;
    showdownCount: number;
    foldCount: number;
    achievementCount: number;
  };
}

export interface LeaderboardEntry {
  userId: string;
  handle: string;
  matchesPlayed: number;
  roi: number;
  totalPayout: Chips;
  achievements: number;
}

// ---------------------------------------------------------------------------
// Client → server  (after auth)  🟡
// ---------------------------------------------------------------------------

export type ClientMessage =
  | AuthMsg
  | { type: 'subscribe'; matchId: string }                 // spectate
  | { type: 'sealPrediction'; matchId: string; ciphertext: string } // tlock ciphertext, base64 🔵
  | { type: 'act'; matchId: string; action: BettingAction; signature: string } // signed intent 🔵
  | { type: 'setDefault'; matchId: string; default: DefaultAction }
  | { type: 'ping' };

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | ChallengeMsg | AuthenticatedMsg | ErrorMsg            // 🟢
  | { type: 'tableTerms'; terms: TableTerms }            // 🟡
  | { type: 'matchState'; state: MatchStateView }        // 🟡
  | { type: 'yourTurn'; matchId: string; toCall: Chips; minRaiseTo: Chips; deadline: number } // 🟡
  | { type: 'event'; event: PublicEvent }                // 🟡 (broadcast path 🟢)
  | { type: 'activeGames'; games: LiveGame[] }           // 🟡
  | { type: 'matchHistory'; matches: MatchHistorySummary[] } // 🟡
  | { type: 'profile'; profile: PublicProfile }          // 🟡
  | { type: 'leaderboard'; entries: LeaderboardEntry[] } // 🟡
  | { type: 'settled'; result: SettlementView }          // 🟡
  | { type: 'void'; matchId: string; reason: VoidReason } // 🟡
  | { type: 'lobbyState'; lobby: RoomLobby }             // 🟡
  | { type: 'queueStatus'; status: QueueStatus }         // 🟡
  | { type: 'pong' };

// ---------------------------------------------------------------------------
// On-chain DTOs (Anchor program)  🟡🔵
// The client builds these via @solana/web3.js + the Anchor IDL; the wallet signs.
// ---------------------------------------------------------------------------

export interface DepositArgs { matchId: string; seatIndex: SeatIndex; } // transfers buyIn + entryFee
export interface ClaimArgs { matchId: string; }   // pull payout after SETTLED (idempotent)
export interface RefundArgs { matchId: string; }  // reclaim deposit + entry fee after VOID

/** PDA seeds (for deriving accounts client-side; the IDL also encodes these). */
export const PDA_SEEDS = {
  /** `match` seed = u64 LE bytes of on-chain match id (string u64, not UUID). */
  match: (onchainMatchId: string) => ['match', u64LeBytes(onchainMatchId)] as const,
  vault: (matchPda: string) => ['vault', matchPda] as const,
  seat: (matchPda: string, player: Wallet) => ['seat', matchPda, player] as const,
  seatIndex: (matchPda: string, seatIndex: number) => ['seat-index', matchPda, u16LeBytes(seatIndex)] as const,
} as const;

function u64LeBytes(id: string): Uint8Array {
  let v = BigInt(id);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u16LeBytes(n: number): Uint8Array {
  const out = new Uint8Array(2);
  out[0] = n & 0xff;
  out[1] = (n >> 8) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Signed action intents (wallet ed25519)  🟢
// Message bytes MUST match `services/shared/src/intent.rs` and
// `services/settlement-chain/src/intent.ts`.
// ---------------------------------------------------------------------------

/** Sign with the wallet key: `signMessage(bytes)` → base64 signature. */
export interface SignedActionIntentWire {
  matchId: string;
  onchainMatchId: string;
  seatIndex: SeatIndex;
  wallet: Wallet;
  nonce: number;
  /** 32-byte hex hash-chain head the player signed over (from gateway `head`). */
  prevHeadHex: string;
  action: BettingAction;
  /** base64 ed25519 signature over the canonical action-intent message. */
  signature: string;
}

export interface SignedDefaultPolicyWire {
  matchId: string;
  onchainMatchId: string;
  seatIndex: SeatIndex;
  wallet: Wallet;
  defaultAction: DefaultAction;
  signature: string;
}

export interface SignedPredictionCommitmentWire {
  matchId: string;
  onchainMatchId: string;
  seatIndex: SeatIndex;
  wallet: Wallet;
  sealSeq: number;
  /** H(prediction || blinding) — 32-byte hex. */
  commitmentHex: string;
  /** 32-byte hex blinding factor (stored server-side; revealed at settlement). */
  blindingHex: string;
  signature: string;
}

/** Revealed at settlement (after drand open); blinding is 32-byte hex. */
export interface RevealedPredictionWire {
  seatIndex: SeatIndex;
  prediction: FixedPrice;
  blindingHex: string;
}

// ---------------------------------------------------------------------------
// drand quicknet (client-side time-lock)  🔵
// ---------------------------------------------------------------------------

export const DRAND = {
  api: 'https://api.drand.sh',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', // quicknet
} as const;

/** Round at/after a unix time, given chain genesis + period (matches backend round_at). */
export function roundAt(genesisTime: number, period: number, unixTime: number): number {
  if (period === 0 || unixTime <= genesisTime) return 1;
  return Math.floor((unixTime - genesisTime + period - 1) / period) + 1;
}
