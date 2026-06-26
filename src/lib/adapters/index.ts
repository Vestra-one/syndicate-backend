/**
 * Client-duty integration surfaces (the [client] items from the integration guide).
 *
 * The store and UI depend ONLY on these interfaces. Each has a demo
 * implementation (./demo) for play-money / no-backend development and a live
 * implementation (./live) wired to real wallets, drand, and Solana. The active
 * set is chosen by env flag in `createAdapters`.
 */
import type { Chips, FixedPrice, SeatIndex } from '@/lib/protocol'
import { createDemoAdapters } from './demo'
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

/** On-chain custody. The client builds; the wallet signs. Returns tx signatures. */
export interface ChainClient {
  /** Spendable chip balance in token base units (for the wallet badge). */
  chipBalance(): Promise<Chips>
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

/** True when no live gateway is configured — we run fully in play-money demo mode. */
export const IS_DEMO = !import.meta.env.VITE_GATEWAY_WS_URL

/** Pick demo vs live adapters from env. Demo when no gateway URL is set. */
export function createAdapters(): Adapters {
  return IS_DEMO ? createDemoAdapters() : createLiveAdapters()
}
