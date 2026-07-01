/**
 * Client-duty integration surfaces (the 🔵 items from the integration guide).
 *
 * The store and UI depend ONLY on these interfaces.  There is a single live
 * implementation (./live) wired to real wallets, drand, and Solana.
 */
import type { Chips, FixedPrice, SeatIndex } from '@/lib/protocol'
import { createLiveAdapters } from './live'

/** ed25519 signer — the player's identity and intent authority. */
export interface Wallet {
  /** base58 Solana pubkey; null until connected. */
  address(): string | null
  /** Prompt connection (wallet adapter modal, etc.). Resolves with the address. */
  connect(): Promise<string>
  /** ed25519 sign of utf8(message), returned base64. */
  signMessageBase64(message: string): Promise<string>
}

/** drand time-lock sealer. The plaintext prediction NEVER leaves the client. */
export interface Tlock {
  /** Encrypt a fixed-point price toward a drand round -> base64 ciphertext. */
  seal(price: FixedPrice, targetRound: number, chainHash: string, api: string): Promise<string>
}

/** Numeric on-chain CreateParams + the price token a host commits at create time. */
export interface CreateAndDepositInput {
  onchainMatchId: string
  configHash: string // 64-char hex (32 bytes)
  priceTokenHex: string // 0x… (20 bytes)
  seatIndex: SeatIndex
  buyIn: Chips
  entryFee: Chips
  rakeBps: number
  rakeCap: Chips
  nonsealPenaltyBps: number
  minPlayers: number
  maxPlayers: number
  totalBettingDurationSec: number
  sealWindowSec: number
  beginLiveWindowSec: number
  fillWindowSec: number
  decimals: number
}

/** On-chain match status, read directly from the `MatchAccount` (no backend needed). */
export interface OnchainMatchStatus {
  status: 'FILLING' | 'SEALING' | 'LIVE' | 'SETTLED' | 'VOID'
  fillDeadlineTs: number // unix seconds
  buyIn: Chips
  entryFee: Chips
}

/** The connected wallet's own seat for a match, read directly from the `SeatAccount`. */
export interface OnchainSeatInfo {
  seatIndex: SeatIndex
  deposit: Chips
  entryFeePaid: Chips
  claimed: boolean
}

/** A match found (by scanning seat accounts) that the connected wallet can cancel/reclaim now. */
export interface ReclaimableMatch extends OnchainMatchStatus {
  onchainMatchId: string
  matchPda: string
  seatIndex: SeatIndex
  deposit: Chips
  entryFeePaid: Chips
}

/**
 * The lifecycle of an on-chain commit tx, surfaced so the UI can narrate the wait
 * honestly (build → wallet prompt → network finality) instead of a blind spinner.
 *  - 'signing'    → the wallet approval prompt is up; we're waiting on the user.
 *  - 'confirming' → broadcast; waiting for the network to finalize.
 */
export type TxStage = 'signing' | 'confirming'
export type TxProgressFn = (stage: TxStage) => void

/** On-chain custody. The client builds; the wallet signs. Returns tx signatures. */
export interface ChainClient {
  /** Spendable chip balance in token base units (for the wallet badge). */
  chipBalance(): Promise<Chips>
  /** Host: open a match AND seat the creator in one tx. Resolves on finality → { txSig, matchPda }. */
  createAndDeposit(input: CreateAndDepositInput, onProgress?: TxProgressFn): Promise<{ txSig: string; matchPda: string }>
  /** buy-in + entry fee; resolves on finality (seat is then granted). */
  deposit(matchId: string, seatIndex: SeatIndex, amount: Chips, onProgress?: TxProgressFn): Promise<string>
  /** pull payout after SETTLED (idempotent). */
  claim(matchId: string): Promise<string>
  /** reclaim deposit + entry fee after VOID. */
  refund(matchId: string): Promise<string>

  /** Read a match's on-chain status + timing directly. Works with no active gateway/match state. */
  getMatchStatus(onchainMatchId: string): Promise<OnchainMatchStatus | null>
  /** Read the connected wallet's own seat for a match, if any. */
  getMySeat(onchainMatchId: string): Promise<OnchainSeatInfo | null>
  /** Permissionless `void_before_start` — anyone can call once past the fill deadline; just pays the fee. */
  voidBeforeStart(onchainMatchId: string): Promise<string>
  /**
   * Player-signed pull refund after VOID. Derives the seat index from the on-chain seat account
   * (not from client match state), so it works standalone — e.g. from a "my matches" list.
   * Idempotent: an already-claimed seat throws an error whose message is `AlreadyClaimed`.
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
