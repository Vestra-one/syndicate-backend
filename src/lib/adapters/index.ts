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

/** On-chain custody. The client builds; the wallet signs. Returns tx signatures. */
export interface ChainClient {
  /** Spendable chip balance in token base units (for the wallet badge). */
  chipBalance(): Promise<Chips>
  /** Host: open a match AND seat the creator in one tx. Resolves on finality → { txSig, matchPda }. */
  createAndDeposit(input: CreateAndDepositInput): Promise<{ txSig: string; matchPda: string }>
  /** buy-in + entry fee; resolves on finality (seat is then granted). */
  deposit(matchId: string, seatIndex: SeatIndex, amount: Chips): Promise<string>
  /** pull payout after SETTLED (idempotent). */
  claim(matchId: string): Promise<string>
  /** reclaim deposit + entry fee after VOID. */
  refund(matchId: string): Promise<string>
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
