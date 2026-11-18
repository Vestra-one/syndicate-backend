import { TestChips } from '@/components/hud/TestChips'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import type { Connection, PublicKey } from '@solana/web3.js'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The waiting-table screen mounts several chain reads at once (this SOL fetch,
 * the USDC balance, `useReclaimMatch`'s status polls) that all hit the same
 * public devnet RPC in the same tick — it rate-limits under that burst. A bare
 * `getBalance` would then fail once and sit silently stuck; retry with backoff
 * so a transient 429 self-heals instead of requiring a manual refresh click.
 */
async function getBalanceWithRetry(connection: Connection, publicKey: PublicKey): Promise<number> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(400 * attempt)
    try {
      return await connection.getBalance(publicKey)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

/**
 * The wallet chip + dropdown, shared by the Dashboard header and the in-table HUD.
 *
 * Self-contained: reads the USDC (chip) balance from the store and fetches the SOL
 * balance itself, so it can live anywhere without prop-threading. The dropdown gives
 * the user a manual balance refresh, copy-address, faucets, and disconnect — the same
 * affordances everywhere, so a claim/refund that just moved funds can always be
 * reflected with one click even before the app's own refresh lands.
 */
export function WalletMenu() {
  const usdcBalance = useGameStore((s) => s.chipBalance)
  const fetchBalance = useGameStore((s) => s.fetchBalance)
  const { connected, connecting, disconnect, publicKey } = useWallet()
  const { connection } = useConnection()
  const { setVisible } = useWalletModal()

  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [balRefreshing, setBalRefreshing] = useState(false)
  const [solBalance, setSolBalance] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const refreshAll = useCallback(async () => {
    await fetchBalance()
    if (publicKey) {
      try {
        const lamports = await getBalanceWithRetry(connection, publicKey)
        setSolBalance(lamports / 1e9)
      } catch { /* still down after retries — leave the previous value, if any */ }
    }
  }, [fetchBalance, publicKey, connection])

  // Refresh once whenever a wallet connects.
  useEffect(() => {
    if (connected) void refreshAll()
  }, [connected, refreshAll])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const addr = publicKey?.toBase58() ?? ''
  const short = addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : ''

  const copyAddr = () => {
    void navigator.clipboard.writeText(addr)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const handleRefreshBalance = async () => {
    setBalRefreshing(true)
    try { await refreshAll() } finally { setBalRefreshing(false) }
  }

  if (!connected) {
    return (
      <button className="wc-btn" onClick={() => setVisible(true)} disabled={connecting}>
        {connecting ? <><span className="wc-spinner" /> Connecting…</> : <>◎ Connect Wallet</>}
      </button>
    )
  }

  const usdcFmt = usdcBalance != null ? (Number(usdcBalance) / 1e6).toFixed(2) : '—'
  const solFmt  = solBalance  != null ? solBalance.toFixed(4) : '—'

  return (
    <div className="wc-wrap" ref={ref}>
      {/* chip */}
      <button className="wc-chip" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="wc-dot" />
        <span className="wc-chip-bal">{usdcFmt} USDC</span>
        <span className="wc-chip-rule" />
        <span className="wc-chip-addr">{short}</span>
        <span className="wc-chevron">▾</span>
      </button>

      {/* dropdown */}
      {open && (
        <div className="wc-dropdown">

          {/* address + copy */}
          <div className="wc-addr-row">
            <div className="wc-addr-info">
              <span className="wc-addr-network">Solana · Devnet</span>
              <span className="wc-addr-text">{short}</span>
            </div>
            <button
              className={`wc-copy-btn ${copied ? 'wc-copy-btn--done' : ''}`}
              onClick={copyAddr}
              title="Copy address"
            >
              {copied ? '✓' : '⧉'}
            </button>
          </div>

          {/* balances */}
          <div className="wc-balances">
            <div className="wc-balances-head">
              <span className="wc-addr-network">Balance</span>
              <button
                className={`wc-bal-refresh ${balRefreshing ? 'wc-bal-refresh--spinning' : ''}`}
                onClick={() => { void handleRefreshBalance() }}
                title="Refresh balance"
                disabled={balRefreshing}
              >↻</button>
            </div>
            <div className="wc-token-row">
              <span className="wc-token-stripe wc-token-stripe--usdc" />
              <div className="wc-token-info">
                <span className="wc-token-symbol">USDC</span>
                <span className="wc-token-amount wc-token-amount--usdc">{usdcFmt}</span>
              </div>
            </div>
            <div className="wc-token-row">
              <span className="wc-token-stripe wc-token-stripe--sol" />
              <div className="wc-token-info">
                <span className="wc-token-symbol">SOL</span>
                <span className="wc-token-amount wc-token-amount--sol">{solFmt}</span>
              </div>
            </div>
          </div>

          {/* faucets — devnet only */}
          <div className="wc-faucets">
            <div className="wc-faucet-label">Get testnet tokens</div>
            <TestChips compact />
            <div className="wc-faucet-links">
              <a
                className="wc-faucet-link"
                href="https://faucet.solana.com/"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
              >
                <span className="wc-faucet-stripe wc-faucet-stripe--sol" />
                SOL
                <span className="wc-faucet-arrow">↗</span>
              </a>
            </div>
          </div>

          {/* disconnect */}
          <div className="wc-disconnect">
            <button
              className="wc-disconnect-btn"
              onClick={() => { setOpen(false); void disconnect() }}
            >
              Disconnect
            </button>
          </div>

        </div>
      )}
    </div>
  )
}
