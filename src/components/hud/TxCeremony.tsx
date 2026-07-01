import { useEffect } from 'react'
import { useGameStore } from '@/store/gameStore'
import type { TxStageName } from '@/store/gameStore'

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
  const createTable = useGameStore((s) => s.createTable)
  const joinTable = useGameStore((s) => s.joinTable)

  // On success, linger just long enough to land the "you're in" beat, then hand
  // off to the seated table (the lobby is already gone — `seated` is true).
  useEffect(() => {
    if (tx?.stage !== 'confirmed') return
    const t = setTimeout(() => useGameStore.getState().dismissTxProgress(), 2000)
    return () => clearTimeout(t)
  }, [tx?.stage])

  if (!tx) return null

  const isCreate = tx.kind === 'create'
  const order = STAGE_ORDER[tx.stage]
  const isError = tx.stage === 'error'
  const isDone = tx.stage === 'confirmed'

  const fmt = (base: number) =>
    (base / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })

  const railState = (i: number): RailState => {
    if (isError) return i === 0 ? 'done' : 'pending'
    if (order > i) return 'done'
    if (order === i) return 'active'
    return 'pending'
  }

  const emblemMode = isError ? 'error' : isDone ? 'done' : 'work'

  const { title, sub } = copyFor(tx.stage, isCreate)
  const explorerUrl = tx.sig
    ? `https://explorer.solana.com/tx/${tx.sig}?cluster=devnet`
    : null

  const retry = () => {
    dismiss()
    // Re-enter the same commit; module-level ctx (createCtx / joinRoom) persists.
    setTimeout(() => (isCreate ? createTable() : joinTable()), 60)
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
        </div>

        <div className="txc-title">{title}</div>
        <div className="txc-sub">{isError ? tx.error : sub}</div>

        {/* The stake — always in view so the player knows exactly what's committing */}
        {!isError && (
          <div className="txc-stake">
            <span className="txc-stake-amount mono">
              {fmt(tx.amount)} {tx.chipsToken}
            </span>
            <span className="eyebrow">
              {isDone
                ? isCreate
                  ? 'table is live'
                  : 'seat secured'
                : isCreate
                  ? 'buy-in + entry fee'
                  : 'buy-in + entry fee'}
              {tx.seats ? ` · ${tx.seats} seated` : ''}
            </span>
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
          <div className="txc-actions">
            <button className="ghost-btn" onClick={dismiss}>
              Back
            </button>
            <button className="ghost-btn ghost-btn--primary" onClick={retry}>
              Try again
            </button>
          </div>
        ) : isDone ? (
          <div className="txc-foot">
            {explorerUrl && (
              <a className="txc-link" href={explorerUrl} target="_blank" rel="noopener noreferrer">
                View transaction ↗
              </a>
            )}
            <span className="txc-continue eyebrow">taking you to the table…</span>
          </div>
        ) : (
          <div className="txc-foot">
            <span className="txc-hint eyebrow">
              {tx.stage === 'signing'
                ? 'Confirm the transaction in your wallet'
                : 'Finality on Solana takes a few seconds — keep this open'}
            </span>
            {tx.stage === 'confirming' && (
              <span className="txc-dots" aria-hidden="true">
                <i /><i /><i />
              </span>
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
