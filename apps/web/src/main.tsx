import './polyfills.ts' // must run before any Solana/Anchor import — sets global Buffer
import React, { StrictMode, useMemo } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base'
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  CoinbaseWalletAdapter,
} from '@solana/wallet-adapter-wallets'
import type { WalletError, Adapter } from '@solana/wallet-adapter-base'
import App from './App.tsx'
import { registerGuestWallet } from '@/lib/guestWallet'
import { GuestBoot, LobbyToast } from '@/components/GuestBoot'
import { WalletBridgeSync } from '@/components/WalletBridgeSync.tsx'
import { useGameStore } from '@/store/gameStore'
import './styles/global.css'
import '@solana/wallet-adapter-react-ui/styles.css'

// A returning guest's table wallet must exist before the wallet layer looks for wallets.
registerGuestWallet()

const RPC_URL =
  (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined) ?? 'https://api.devnet.solana.com'

/**
 * Connect-phase wallet failures otherwise die silently (the adapter default just
 * console.errors and the modal closes), leaving "Connect Wallet" looking broken.
 * Surface them in the Room's notices strip via the store. Only connect-phase
 * errors are mapped — transaction-phase errors already narrate through the
 * deposit ceremony (txProgress/playError) and would double-report here.
 */
function onWalletError(error: WalletError, adapter?: Adapter) {
  const who = adapter?.name ?? 'The wallet'
  let msg: string | null = null
  switch (error.name) {
    case 'WalletAccountError':
      // The extension approved the connection but exposed zero Solana accounts —
      // classically MetaMask, whose Solana support is mainnet-only.
      msg = `${who} connected but exposed no Solana account. If you're using MetaMask, it can't reach Solana Devnet — connect with Phantom or Solflare instead.`
      // Forget the remembered selection or autoConnect re-hits the same dead
      // wallet on every page load (wallet-adapter persists it under this key).
      try { localStorage.removeItem('walletName') } catch { /* private mode */ }
      break
    case 'WalletNotReadyError':
      msg = `${who} isn't installed (or isn't enabled in this browser profile).`
      break
    case 'WalletConnectionError':
    case 'WalletWindowClosedError':
      msg = `${who} closed or rejected the connection request. Unlock the wallet and try again.`
      break
    default:
      break // gameplay/tx errors surface through the deposit ceremony instead
  }
  if (msg) useGameStore.setState({ walletError: msg })
  console.error('[wallet]', error.name, error.message, error)
}

function SolanaProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet }),
      new CoinbaseWalletAdapter(),
    ],
    [],
  )
  // The wallet-adapter types lag behind React 18's broadened ReactNode (now includes bigint),
  // causing JSX element type errors.  Create elements imperatively to sidestep the mismatch.
  const inner = (
    <>
      <WalletBridgeSync />
      <GuestBoot />
      <LobbyToast />
      {children}
    </>
  )
  return React.createElement(
    ConnectionProvider as React.ComponentType<{ endpoint: string; children?: ReactNode }>,
    { endpoint: RPC_URL },
    React.createElement(
      WalletProvider as React.ComponentType<{
        wallets: unknown[]
        autoConnect: boolean
        onError?: (error: WalletError, adapter?: Adapter) => void
        children?: ReactNode
      }>,
      { wallets, autoConnect: true, onError: onWalletError },
      React.createElement(
        WalletModalProvider as React.ComponentType<{ children?: ReactNode }>,
        {},
        inner,
      ),
    ),
  )
}

// Dev-only: expose the store for headless inspection / debugging.
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>
  w.__store = useGameStore.getState
  w.__setStore = useGameStore.setState
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SolanaProviders>
      <App />
    </SolanaProviders>
  </StrictMode>,
)
