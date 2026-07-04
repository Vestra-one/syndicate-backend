/**
 * Client-duty integration surfaces (the 🔵 items from the integration guide).
 *
 * The store and UI depend ONLY on these interfaces.  There is a single live
 * implementation (./live) wired to real wallets, drand, and Solana.
 */
import type { Chips } from '@/lib/protocol'
import { createLiveAdapters } from './live'

/** ed25519 signer — the player's identity and intent authority. */
export interface Wallet {
  /** base58 Solana pubkey; null until connected. */
  address(): string | null
  /** Prompt connection (wallet adapter modal, etc.). Resolves with the address. */
  connect(): Promise<string>
  /** ed25519 sign of utf8(message), returned base64 (auth nonces, plain messages). */
  signMessageBase64(message: string): Promise<string>
  /** ed25519 sign of RAW bytes, returned base64 — for byte-exact intent messages (§8). */
  signBytesBase64(bytes: Uint8Array): Promise<string>
}

/** drand time-lock sealer. The plaintext prediction NEVER leaves the client. */
export interface Tlock {
  /**
   * Time-lock encrypt an i128 WAD price (exponent −18, so pass a bigint — WAD values
   * overflow JS safe ints) toward a drand round → the raw ciphertext bytes. The caller
   * derives `ciphertext_b64` + `commitment = sha256(bytes)`; the plaintext never leaves
   * the client (§7).
   */
  seal(priceWad: bigint, targetRound: number, chainHash: string, api: string): Promise<Uint8Array>
}

/**
 * v2 `CreateParams` (167-byte Borsh, field order per the IDL) + the price token a host
 * commits at create time. In the full v2 flow the backend computes these fields (match_id,
 * config_hash, room_commitment) via `POST /v1/rooms/intents` and hands them back byte-exact;
 * this shape lets the chain adapter reproduce/pass them through to `create_and_deposit`.
 */
export interface CreateAndDepositInput {
  onchainMatchId: string
  configHash: string // 64-char hex (32 bytes)
  priceTokenHex: string // 0x… (20 bytes)
  buyIn: Chips
  entryFee: Chips
  rakeBps: number
  rakeCap: Chips
  minPlayers: number
  maxPlayers: number
  /** Private room? Public rooms use `isPrivate:false` + a zeroed room commitment. */
  isPrivate: boolean
  /** `sha256(roomcode_uppercased ‖ creator_pubkey)` hex (32 bytes); 64 zeros for public. */
  roomCommitmentHex: string
  totalBettingDurationSec: number
  sealWindowSec: number
  beginLiveWindowSec: number
  fillWindowSec: number
  /** Signed-price confidence gate (u64 — may be a decimal string when ≥ 2^53, e.g. u64::MAX). */
  maxOracleConfidence?: number | string
  /** Fixed exponent the settlement price is quoted at (−18 = WAD). */
  oracleExponent?: number
}

/** On-chain match status, read directly from the `MatchAccount` (no backend needed). */
export interface OnchainMatchStatus {
  status: 'FILLING' | 'SEALING' | 'LIVE' | 'SETTLED' | 'VOID'
  fillDeadlineTs: number // unix seconds (on-chain Clock, NOT the REST ms convention)
  buyIn: Chips
  entryFee: Chips
}

/**
 * The connected wallet's own seat for a match, read directly from the v2 `SeatAccount`.
 * v2 has no seat-index PDA: a deposit makes you a *candidate*; the backend assigns
 * `engineSeat` (and flips `confirmed`) FCFS at lock. `engineSeat` is 0 until confirmed.
 */
export interface OnchainSeatInfo {
  deposit: Chips
  entryFeePaid: Chips
  payout: Chips
  claimed: boolean
  /** Backend-confirmed at lock (candidate → seat). Unconfirmed candidates are refundable. */
  confirmed: boolean
  /** Engine seat index assigned at lock (0 until confirmed). */
  engineSeat: number
}

/** A match found (by scanning seat accounts) that the connected wallet can cancel/reclaim now. */
export interface ReclaimableMatch extends OnchainMatchStatus {
  onchainMatchId: string
  matchPda: string
  deposit: Chips
  entryFeePaid: Chips
}

/**
 * A SETTLED match this wallet has an unclaimed payout in (found by scanning seat accounts).
 * `payout` is the exact on-chain amount waiting to be pulled via `claimSettled`.
 */
export interface ClaimableWinning {
  onchainMatchId: string
  matchPda: string
  payout: Chips
}

/**
 * The lifecycle of an on-chain commit tx, surfaced so the UI can narrate the wait
 * honestly (build → wallet prompt → network finality) instead of a blind spinner.
 *  - 'signing'    → the wallet approval prompt is up; we're waiting on the user.
 *  - 'confirming' → broadcast; waiting for the network to finalize. The tx signature
 *                   exists by now, so it's passed along for the "verify on Solscan" link.
 */
export type TxStage = 'signing' | 'confirming'
export type TxProgressFn = (stage: TxStage, sig?: string) => void

/** On-chain custody. The client builds; the wallet signs. Returns tx signatures. */
export interface ChainClient {
  /** Spendable chip balance in token base units (for the wallet badge). */
  chipBalance(): Promise<Chips>
  /** Host: open a match AND seat the creator in one tx. Resolves on finality → { txSig, matchPda }. */
  createAndDeposit(input: CreateAndDepositInput, onProgress?: TxProgressFn): Promise<{ txSig: string; matchPda: string }>
  /**
   * buy-in + entry fee → become a seat *candidate* (§5). `joinCommitmentHex` is
   * `sha256(roomcode ‖ joiner)` for private rooms, or 64 zeros for public (default).
   * Resolves on finality; confirmation to a seat happens backend-side at lock.
   */
  deposit(matchId: string, joinCommitmentHex?: string, amount?: Chips, onProgress?: TxProgressFn): Promise<string>
  /** pull payout after SETTLED (idempotent). */
  claim(matchId: string): Promise<string>
  /**
   * Player-signed pull payout for a SETTLED match, by on-chain id. Like `refundSelf`, the
   * v2 seat PDA is derived from `(match, player)` alone, so this works standalone from a
   * "my winnings" list with no active gateway/match state. Idempotent: an already-claimed
   * seat throws an error whose message is `AlreadyClaimed`.
   */
  claimSettled(onchainMatchId: string): Promise<string>
  /** reclaim deposit + entry fee after VOID. */
  refund(matchId: string): Promise<string>
  /**
   * Register the on-chain prediction commitment during SEALING (§7): `commitment =
   * sha256(tlock_ciphertext)`. Player-signed; the seat must be confirmed. Resolves on finality.
   */
  registerPredictionCommitment(onchainMatchId: string, commitmentHex: string, timelockTarget: number): Promise<string>

  /** Read a match's on-chain status + timing directly. Works with no active gateway/match state. */
  getMatchStatus(onchainMatchId: string): Promise<OnchainMatchStatus | null>
  /** Read the connected wallet's own seat for a match, if any. */
  getMySeat(onchainMatchId: string): Promise<OnchainSeatInfo | null>
  /** Permissionless `void_before_start` — anyone can call once past the fill deadline; just pays the fee. */
  voidBeforeStart(onchainMatchId: string): Promise<string>
  /**
   * Player-signed pull refund after VOID (or for an unconfirmed candidate once the match
   * leaves Filling). The v2 seat PDA is derived from `(match, player)` alone, so this works
   * standalone — e.g. from a "my matches" list. Idempotent: an already-claimed/closed seat
   * throws an error whose message is `AlreadyClaimed` / account-closed.
   */
  refundSelf(onchainMatchId: string): Promise<string>
  /**
   * Single-signature optimistic path: bundles `void_before_start` + `refund` into one
   * atomic transaction for a match still FILLING past its deadline. If someone else's
   * void beat us to it, the whole transaction fails at simulation (before any wallet
   * prompt) — callers should fall back to the sequential `voidBeforeStart`/`refundSelf` pair.
   */
  cancelAndRefundSelf(onchainMatchId: string): Promise<string>
  /** Scan the connected wallet's seats for matches stuck FILLING past deadline, or already VOID. */
  listReclaimableMatches(): Promise<ReclaimableMatch[]>
  /** Scan the connected wallet's seats for SETTLED matches with an unclaimed payout. */
  listClaimableWinnings(): Promise<ClaimableWinning[]>
}

export interface Adapters {
  wallet: Wallet
  tlock: Tlock
  chain: ChainClient
}

/** Build the live adapter set (real wallet, drand, Solana custody). */
export function createAdapters(): Adapters {
  return createLiveAdapters()
}
