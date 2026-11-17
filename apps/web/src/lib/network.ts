/**
 * Which Solana cluster this build talks to — derived from the RPC endpoint so
 * the UI (network pill, faucet link, "not real money" copy) always matches
 * whatever VITE_SOLANA_RPC_URL is actually pointed at.
 */
export type Cluster = 'mainnet' | 'devnet' | 'testnet' | 'localnet'

const RPC_URL =
  (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined) ?? 'https://api.devnet.solana.com'

const LABELS: Record<Cluster, string> = {
  mainnet: 'Solana · Mainnet',
  devnet: 'Solana · Devnet',
  testnet: 'Solana · Testnet',
  localnet: 'Solana · Localnet',
}

export interface NetworkInfo {
  cluster: Cluster
  /** Display label, e.g. "Solana · Devnet". */
  label: string
  /** True on any non-mainnet cluster — funds are play money. */
  isTest: boolean
  /** Test-USDC faucet, or null on mainnet where there's nothing to mint. */
  faucetUrl: string | null
  /** Test-SOL (gas) faucet, or null on mainnet — covers the "no SOL for fees" case. */
  solFaucetUrl: string | null
}

export function detectCluster(url = RPC_URL): Cluster {
  const u = url.toLowerCase()
  if (u.includes('devnet')) return 'devnet'
  if (u.includes('testnet')) return 'testnet'
  if (u.includes('localhost') || u.includes('127.0.0.1')) return 'localnet'
  return 'mainnet'
}

export function networkInfo(url = RPC_URL): NetworkInfo {
  const cluster = detectCluster(url)
  return {
    cluster,
    label: LABELS[cluster],
    isTest: cluster !== 'mainnet',
    // Circle's faucet mints devnet USDC straight to a Solana address.
    faucetUrl: cluster === 'devnet' || cluster === 'testnet' ? 'https://faucet.circle.com/' : null,
    // Solana's own faucet airdrops devnet/testnet SOL for transaction fees.
    solFaucetUrl: cluster === 'devnet' || cluster === 'testnet' ? 'https://faucet.solana.com/' : null,
  }
}

/** Solana Explorer link for a transaction on the cluster this build talks to. */
export function explorerTxUrl(sig: string, url = RPC_URL): string {
  const cluster = detectCluster(url)
  const q =
    cluster === 'mainnet' ? ''
    : cluster === 'localnet' ? `?cluster=custom&customUrl=${encodeURIComponent(url)}`
    : `?cluster=${cluster}`
  return `https://explorer.solana.com/tx/${sig}${q}`
}
