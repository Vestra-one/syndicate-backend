/**
 * Live adapters — real wallet, drand time-lock, and Solana custody.
 *
 * Stubs for now: the interfaces are fixed (so the store/UI are already written
 * against them), but the integrations land in later phases:
 *   - wallet: Solana wallet adapter (ed25519) — Phase 2 (§3, §7)
 *   - tlock:  tlock-js / quicknet sealing — Phase 3 (§6)
 *   - chain:  @solana/web3.js + Anchor IDL deposit/claim/refund — Phase 2 (§7)
 *
 * Each throws until wired, so a misconfigured live build fails loudly rather
 * than silently behaving like demo.
 */
import type { Adapters, ChainClient, Tlock, Wallet } from './index'

const TODO = (what: string) => () => {
  throw new Error(`[live adapter] ${what} not implemented yet — see INTEGRATION guide`)
}

function createLiveWallet(): Wallet {
  return {
    address: () => null,
    connect: TODO('wallet.connect (Solana wallet adapter)'),
    signMessageBase64: TODO('wallet.signMessageBase64 (ed25519)'),
  }
}

function createLiveTlock(): Tlock {
  return {
    seal: TODO('tlock.seal (drand quicknet via tlock-js)'),
  }
}

function createLiveChain(): ChainClient {
  return {
    chipBalance: TODO('chain.chipBalance (SPL token account)'),
    deposit: TODO('chain.deposit (Anchor)'),
    claim: TODO('chain.claim (Anchor)'),
    refund: TODO('chain.refund (Anchor)'),
  }
}

export function createLiveAdapters(): Adapters {
  return {
    wallet: createLiveWallet(),
    tlock: createLiveTlock(),
    chain: createLiveChain(),
  }
}
