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
import App from './App.tsx'
import { WalletBridgeSync } from '@/components/WalletBridgeSync.tsx'
import { useGameStore } from '@/store/gameStore'
import './styles/global.css'
import '@solana/wallet-adapter-react-ui/styles.css'

const RPC_URL =
  (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined) ?? 'https://api.devnet.solana.com'

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
      {children}
    </>
  )
  return React.createElement(
    ConnectionProvider as React.ComponentType<{ endpoint: string; children?: ReactNode }>,
    { endpoint: RPC_URL },
    React.createElement(
      WalletProvider as React.ComponentType<{ wallets: unknown[]; autoConnect: boolean; children?: ReactNode }>,
      { wallets, autoConnect: true },
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
