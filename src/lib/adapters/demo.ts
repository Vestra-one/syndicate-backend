/**
 * Demo (play-money) adapters. No real crypto, no chain, no network — everything
 * succeeds locally so the whole UI can be exercised before the live integrations
 * land. Selected automatically when no gateway URL is configured (see ./index).
 */
import type { Adapters, ChainClient, Tlock, Wallet } from './index'
import type { Chips } from '@/lib/protocol'

/** A deterministic-looking fake base58 pubkey, so the badge has something to show. */
const DEMO_ADDRESS = 'Demo1111111111111111111111111111111111111111'

/** Starting play-money balance, in the same base units as table terms (demo: whole chips). */
const DEMO_START_BALANCE = 25_000

function b64(s: string): string {
  // btoa over utf8 — adequate for a demo signature/ciphertext placeholder.
  return btoa(unescape(encodeURIComponent(s)))
}

function createDemoWallet(): Wallet {
  let address: string | null = null
  return {
    address: () => address,
    async connect() {
      address = DEMO_ADDRESS
      return address
    },
    async signMessageBase64(message: string) {
      return b64(`demo-sig:${message}`)
    },
  }
}

function createDemoTlock(): Tlock {
  return {
    async seal(price, targetRound) {
      // No real time-lock in demo — the mock gateway "decrypts" by trusting this.
      return b64(`demo-tlock:${price}@${targetRound}`)
    },
  }
}

function createDemoChain(): ChainClient {
  let balance: Chips = DEMO_START_BALANCE
  let sig = 0
  const tx = (p: string) => `demo-${p}-${sig++}`
  return {
    async chipBalance() {
      return balance
    },
    async deposit(_matchId, _seatIndex, amount) {
      balance = Math.max(0, balance - amount)
      return tx('deposit')
    },
    async claim(_matchId) {
      // Demo: the gateway credits winnings via the settled award; nothing to debit here.
      return tx('claim')
    },
    async refund(_matchId) {
      return tx('refund')
    },
  }
}

export function createDemoAdapters(): Adapters {
  return {
    wallet: createDemoWallet(),
    tlock: createDemoTlock(),
    chain: createDemoChain(),
  }
}
