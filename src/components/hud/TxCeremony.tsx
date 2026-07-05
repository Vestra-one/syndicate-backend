import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useGameStore } from '@/store/gameStore'
import type { TxErrorCode, TxStageName } from '@/store/gameStore'
import { networkInfo } from '@/lib/network'
import { formatChips } from '@/lib/format'

/**
 * The commit ceremony — the full-screen moment between "take your seat" and a
 * seated player. It replaces the old blind "Confirming on-chain…" button state
 * (which vanished the instant `seated` flipped optimistically) with an honest,
 * narrated view of the real transaction lifecycle:
 *
 *   prepare → approve in wallet → finalize on-chain → seated
 *
 * Each node lights up from the adapter's own progress callbacks, so the copy
 * always matches what the chain is actually doing. On confirm it blooms into a
 * "you're in" flourish and hands off to the table; on failure it stays put with
 * a clear reason and a one-tap retry.
 */

type RailState = 'done' | 'active' | 'pending'

// Where "this is taking a while" sends people. Discord is our live support channel.
const SUPPORT_URL = 'https://discord.gg/cQthYMAY5'
// Past this, silent spinning reads as "stuck" — swap to an explicit reassurance state.
const SLOW_FINALITY_MS = 30_000

const STAGE_ORDER: Record<TxStageName, number> = {
  preparing: 0,
  signing: 1,
  confirming: 2,
  confirmed: 3,
  error: -1,
}

const RAIL: { key: string; label: string }[] = [
  { key: 'prepare', label: 'Prepare' },
  { key: 'approve', label: 'Approve' },
  { key: 'finalize', label: 'Finalize' },
]

export function TxCeremony() {
  const tx = useGameStore((s) => s.txProgress)
  const dismiss = useGameStore((s) => s.dismissTxProgress)
  const abort = useGameStore((s) => s.abortTxCommit)
  const createTable = useGameStore((s) => s.createTable)
  const joinTable = useGameStore((s) => s.joinTable)
  const storeWallet = useGameStore((s) => s.walletAddress)
  const chipBalance = useGameStore((s) => s.chipBalance)
  const { wallet, publicKey } = useWallet()

  // A 60s stall on the wallet prompt is the classic "the popup opened behind my
  // window / never opened" case — surface a manual escape hatch once it drags.
  const [stalled, setStalled] = useState(false)

  // Ticks once a second while finality is pending so the elapsed-time readout stays
  // live. Anchored to `confirmingAt` (set when the tx broadcast) rather than mount, so
  // it survives re-renders and reflects the real wait.
  const [now, setNow] = useState(() => Date.now())

  // "Technical details" copy affordance — flips to a confirmation for a beat after a copy.
  const [copiedRaw, setCopiedRaw] = useState(false)

  // Which cluster this build talks to — gates the "Get test USDC / SOL" faucet buttons.
  const net = useMemo(() => networkInfo(), [])

  // On success, linger long enough to land the "you're in" beat AND let the coin
  // stack materialize at the seat, then hand off to the seated table (the lobby is
  // already gone — `seated` is true).
  useEffect(() => {
    if (tx?.stage !== 'confirmed') return
    const t = setTimeout(() => useGameStore.getState().dismissTxProgress(), 2600)
    return () => clearTimeout(t)
  }, [tx?.stage])

  useEffect(() => {
    if (tx?.stage !== 'confirming') return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [tx?.stage])

  // Arm the no-response nudge only while the wallet prompt is actually up.
  useEffect(() => {
    setStalled(false)
    if (tx?.stage !== 'signing') return
    const t = setTimeout(() => setStalled(true), 60_000)
    return () => clearTimeout(t)
  }, [tx?.stage])

  if (!tx) return null

  const isCreate = tx.kind === 'create'
  const order = STAGE_ORDER[tx.stage]
  const isError = tx.stage === 'error'
  const isDone = tx.stage === 'confirmed'

  const fmt = (base: bigint | number) =>
    (Number(base) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })

  const railState = (i: number): RailState => {
    if (isError) return i === 0 ? 'done' : 'pending'
    if (order > i) return 'done'
    if (order === i) return 'active'
    return 'pending'
  }

  const isSigning = tx.stage === 'signing'
  // Cancelling is only safe before the signature exists — i.e. while we're still
  // preparing the tx or waiting on the wallet prompt. Once broadcast, there's
  // nothing to abort.
  const canCancel = tx.stage === 'preparing' || isSigning

  const emblemMode = isError ? 'error' : isDone ? 'done' : 'work'

  const walletName = wallet?.adapter.name ?? 'your wallet'
  const walletIcon = wallet?.adapter.icon ?? null
  const address = publicKey?.toBase58() ?? storeWallet
  const shortAddr = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : null

  const { title, sub } = copyFor(tx.stage, isCreate)

  // Solscan (devnet) lets power users verify the exact tx. The signature exists from
  // the confirming beat onward, so the link shows through the wait — not just on success.
  const solscanUrl = tx.sig ? `https://solscan.io/tx/${tx.sig}?cluster=devnet` : null
  const shortSig = tx.sig ? `${tx.sig.slice(0, 4)}…${tx.sig.slice(-4)}` : null

  const isConfirming = tx.stage === 'confirming'
  const elapsedMs = tx.confirmingAt ? Math.max(0, now - tx.confirmingAt) : 0
  const elapsedSec = Math.round(elapsedMs / 1000)
  const slowFinality = isConfirming && elapsedMs >= SLOW_FINALITY_MS

  // Re-enter the same commit; module-level ctx (createCtx / joinRoom) persists.
  // `reset` must clear the optimistic `seated` flag too, or the re-entry hits the
  // `if (seated) return` guard and silently no-ops. From the error screen `seated`
  // is already false, but from the mid-signing nudge it's still true — so abort().
  const recommit = (reset: () => void) => {
    reset()
    setTimeout(() => (isCreate ? createTable() : joinTable()), 60)
  }
  // Try again re-runs the whole commit, which simulates on-chain BEFORE the wallet prompt
  // (`simulateSignAndSend` / createAndDeposit both simulate first). A still-doomed tx —
  // e.g. balance unchanged — fails at simulation and lands back here without the user ever
  // signing, so nobody signs a hopeless transaction twice.
  const retry = () => recommit(dismiss)
  const retryFromStall = () => recommit(abort)

  // ---- Error view derivation (only meaningful when isError) ----------------
  const code: TxErrorCode = tx.errorCode ?? 'unknown'
  const required = tx.amount
  const actual = tx.walletBalance ?? chipBalance ?? 0n
  const token = tx.chipsToken
  // An `insufficient` failure splits two ways: short on the chips token (top up USDC), or
  // the token covers it but there's no SOL left for network fees (top up SOL). We only claim
  // a USDC shortfall when the numbers actually prove it.
  const usdcShort = code === 'insufficient' && actual < required
  const solShort = code === 'insufficient' && actual >= required
  const shortfall = required > actual ? required - actual : 0n
  const errorTitle = errorHeadline(code, isCreate)
  const errorSub = usdcShort
    ? `You need ${formatChips(required, token)} ${token} to sit down — your wallet has ${formatChips(actual, token)}.`
    : solShort
      ? "Your USDC covers the buy-in, but there's not enough SOL to pay the network fee."
      : tx.error
  // On a test cluster, a shortfall gets a primary faucet button (USDC or SOL as appropriate);
  // when it's shown, Try again steps down to a secondary so there's one clear primary action.
  const faucetUrl = usdcShort ? net.faucetUrl : solShort ? net.solFaucetUrl : null
  const faucetLabel = usdcShort ? 'Get test USDC' : 'Get test SOL'

  const copyRaw = () => {
    void navigator.clipboard?.writeText(tx.errorRaw ?? tx.error ?? '')
    setCopiedRaw(true)
    setTimeout(() => setCopiedRaw(false), 1800)
  }

  return (
    <div className={`txc ${isDone ? 'txc--done' : ''} ${isError ? 'txc--error' : ''}`}>
      <div className="txc-card panel">
        <div className="txc-eyebrow eyebrow">
          {isCreate ? 'opening your table' : 'taking your seat'}
          {tx.feed ? <span className="txc-feed"> · {tx.feed}</span> : null}
        </div>

        {/* Emblem — a candlelit coin that works, then blooms on confirm */}
        <div className={`txc-emblem txc-emblem--${emblemMode}`} aria-hidden="true">
          <span className="txc-ring txc-ring--outer" />
          <span className="txc-ring txc-ring--inner" />
          <span className="txc-emblem-core">
            {isDone ? '✓' : isError ? '!' : '◎'}
          </span>
          {/* Seat-taken payoff — a coin stack builds up at the seat before we route
              to the table, so the win registers instead of a hard cut. */}
          {isDone && !isCreate && (
            <span className="txc-coinstack" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="txc-coin" style={{ '--i': i } as CSSProperties} />
              ))}
            </span>
          )}
        </div>

        <div className="txc-title">{isError ? errorTitle : title}</div>
        <div className="txc-sub">{isError ? errorSub : sub}</div>

        {/* Wallet identity — at the approve beat, tell the player exactly where to
            look and which account is signing. */}
        {isSigning && (
          <div className="txc-wallet">
            {walletIcon && <img className="txc-wallet-icon" src={walletIcon} alt="" aria-hidden="true" />}
            <span className="txc-wallet-name">Confirm in {walletName}</span>
            {shortAddr && <span className="txc-wallet-addr mono"> · {shortAddr}</span>}
          </div>
        )}

        {/* The stake — always in view so the player knows exactly what's committing */}
        {!isError && (
          <div className="txc-stake">
            <span className="txc-stake-amount mono">
              {fmt(tx.amount)} {tx.chipsToken}
            </span>
            <span className="eyebrow">
              {isDone ? (isCreate ? 'table is live' : 'seat secured') : 'buy-in + entry fee'}
            </span>
          </div>
        )}

        {/* Error detail — balance math when short, a refund note when the seat vanished,
            and the raw error tucked into a copyable "Technical details" row. */}
        {isError && (
          <div className="txc-err">
            {usdcShort && (
              <div className="txc-balance">
                <div className="txc-balance-row">
                  <span className="txc-balance-label">Needed</span>
                  <span className="txc-balance-val mono">{formatChips(required, token)} {token}</span>
                </div>
                <div className="txc-balance-row">
                  <span className="txc-balance-label">In your wallet</span>
                  <span className="txc-balance-val mono">{formatChips(actual, token)} {token}</span>
                </div>
                <div className="txc-balance-row txc-balance-row--short">
                  <span className="txc-balance-label">Short by</span>
                  <span className="txc-balance-val mono">{formatChips(shortfall, token)} {token}</span>
                </div>
              </div>
            )}

            {code === 'seat_taken' && (
              <div className="txc-refund-note">
                Your buy-in wasn’t committed, so there’s nothing to refund. If any deposit did
                land, it’s automatically refundable — your funds are safe.
              </div>
            )}

            {tx.errorRaw && (
              <details className="txc-tech">
                <summary className="txc-tech-summary">Technical details</summary>
                <div className="txc-tech-body">
                  <code className="txc-tech-raw mono">{tx.errorRaw}</code>
                  <button className="txc-tech-copy" onClick={copyRaw}>
                    {copiedRaw ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
              </details>
            )}
          </div>
        )}

        {/* Progress rail — real lifecycle, lit from adapter callbacks */}
        {!isError && (
          <div className="txc-rail" role="list">
            {RAIL.map((step, i) => {
              const st = railState(i)
              return (
                <div key={step.key} className={`txc-node txc-node--${st}`} role="listitem">
                  <span className="txc-node-dot">
                    {st === 'done' ? '✓' : st === 'active' ? <span className="txc-node-spin" /> : i + 1}
                  </span>
                  <span className="txc-node-label">{step.label}</span>
                </div>
              )
            })}
          </div>
        )}

        {/* Footer — reassurance while waiting, exits when done or failed */}
        {isError ? (
          <div className="txc-err-actions">
            {faucetUrl && (
              <a
                className="ghost-btn ghost-btn--primary txc-faucet"
                href={faucetUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {faucetLabel} ↗
              </a>
            )}
            <div className="txc-actions">
              <button className="ghost-btn" onClick={dismiss}>
                Back to table
              </button>
              <button
                className={`ghost-btn ${faucetUrl ? '' : 'ghost-btn--primary'}`}
                onClick={retry}
              >
                Try again
              </button>
            </div>
          </div>
        ) : isDone ? (
          <div className="txc-foot">
            {solscanUrl && (
              <a className="txc-link" href={solscanUrl} target="_blank" rel="noopener noreferrer">
                View transaction ↗
              </a>
            )}
            <span className="txc-continue eyebrow">taking you to the table…</span>
          </div>
        ) : (
          <div className="txc-foot">
            <span className="txc-hint eyebrow">
              {isSigning
                ? 'Confirm the transaction in your wallet'
                : slowFinality
                  ? 'Still working — nothing is lost'
                  : 'Finality on Solana takes a few seconds — keep this open'}
            </span>

            {/* Finalize step: honest elapsed clock, then a reassurance state if the
                network drags, then the signature so power users can verify on Solscan. */}
            {isConfirming && !slowFinality && (
              <span className="txc-elapsed mono">
                ~{elapsedSec}s <span className="txc-elapsed-hint">· usually under 10s</span>
              </span>
            )}
            {slowFinality && (
              <span className="txc-reassure">
                The network is unusually busy. Your funds are safe and the seat will finalize —
                if it doesn’t clear soon,{' '}
                <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">reach us on Discord</a>.
              </span>
            )}
            {isConfirming && solscanUrl && (
              <a
                className="txc-verify mono"
                href={solscanUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {shortSig} ↗
              </a>
            )}

            {isSigning && stalled && (
              <span className="txc-nudge">
                Nothing happening? Open your wallet manually or{' '}
                <button className="txc-nudge-link" onClick={retryFromStall}>retry</button>.
              </span>
            )}
            {canCancel && (
              <button className="txc-cancel" onClick={abort}>
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function copyFor(stage: TxStageName, isCreate: boolean): { title: string; sub: string } {
  switch (stage) {
    case 'preparing':
      return {
        title: isCreate ? 'Setting the table' : 'Preparing your seat',
        sub: isCreate
          ? 'Building your table and checking the terms on-chain.'
          : 'Building your deposit and checking the table is still open.',
      }
    case 'signing':
      return {
        title: 'Approve in your wallet',
        sub: isCreate
          ? 'Confirm the transaction to open your table and commit your buy-in.'
          : 'Confirm the transaction to commit your buy-in and claim your seat.',
      }
    case 'confirming':
      return {
        title: isCreate ? 'Opening your table' : 'Securing your seat',
        sub: 'Signed and broadcast. Waiting for the Solana network to finalize.',
      }
    case 'confirmed':
      return {
        title: isCreate ? 'Your table is live' : "You're in",
        sub: isCreate
          ? 'The table is open — players can join before it begins.'
          : 'Your seat is secured. The hand begins once the table fills.',
      }
    case 'error':
      return {
        title: isCreate ? "Couldn't open the table" : "Couldn't take your seat",
        sub: '',
      }
  }
}

/** A distinct, state-specific headline per failure so the card never reads generically. */
function errorHeadline(code: TxErrorCode, isCreate: boolean): string {
  switch (code) {
    case 'rejected':
      return 'Approval dismissed'
    case 'insufficient':
      return 'Not enough to sit down'
    case 'seat_taken':
      return 'That seat was just taken'
    case 'already_seated':
      return "You're already seated"
    case 'closed':
      return 'Deposits are closed'
    case 'network':
      return 'The network dropped it'
    default:
      return isCreate ? "Couldn't open the table" : "Couldn't take your seat"
  }
}
