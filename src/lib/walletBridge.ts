/**
 * Wallet bridge — a module-level singleton that lets the live adapter (plain
 * functions, no hooks) reach the Solana wallet adapter (React context/hooks).
 *
 * WalletBridgeSync (see components/WalletBridgeSync.tsx) keeps this up-to-date
 * from inside the React tree.  All code outside React reads from here.
 */
import type { WalletAdapter } from '@solana/wallet-adapter-base'

interface Bridge {
  /** Currently connected adapter (Phantom, Solflare, …); null if not connected. */
  adapter: WalletAdapter | null
  /** Open the wallet-selection modal (WalletMultiButton / useWalletModal). */
  showModal: () => void
  /** Resolved once by walletBridge after a modal-triggered connect. */
  onConnected: ((address: string) => void) | null
  onConnectError: ((err: Error) => void) | null
}

export const walletBridge: Bridge = {
  adapter: null,
  showModal: () => {
    console.warn('[walletBridge] showModal called before WalletBridgeSync mounted')
  },
  onConnected: null,
  onConnectError: null,
}
