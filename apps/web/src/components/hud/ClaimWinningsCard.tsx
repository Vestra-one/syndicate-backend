import { useCallback, useMemo, useState } from 'react'
import { createAdapters } from '@/lib/adapters'
import { useGameStore } from '@/store/gameStore'
import { isGuestWallet } from '@/lib/guestWallet'

// USDC has 6 decimals — mirrors the fmt() convention used across Lobby/Dashboard/Reclaim.
const fmt = (base: bigint | number) => (Number(base) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })

type Phase = 'idle' | 'claiming' | 'done' | 'error'

const FRIENDLY_ERRORS: Record<string, string> = {
  NoSeat: "You don't have a seat in this match.",
  BadStatus: "This match isn't settled yet — check back once the hand resolves.",
}

/**
 * "Collect winnings" — a SETTLED match this wallet has an unclaimed payout in. Self-contained:
 * the payout amount comes from the on-chain scan (`listClaimableWinnings`), and `claimSettled`
 * pulls it. Idempotent: an already-claimed seat (AlreadyClaimed) resolves as done, not an error.
 */
export function ClaimWinningsCard({
  onchainMatchId,
  payout,
  staked,
  onDone,
}: {
  onchainMatchId: string
  payout: bigint
  /** Buy-in + entry fee this seat put in, for honest net P&L. Optional: absent → collect-only copy. */
  staked?: bigint
  onDone?: (onchainMatchId: string) => void
}) {
  const silent = isGuestWallet(useGameStore((st) => st.walletAddress))
  const chain = useMemo(() => createAdapters().chain, [])
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [txSig, setTxSig] = useState<string | null>(null)

  const collect = useCallback(async () => {
    if (phase === 'claiming') return
    setError(null)
    setPhase('claiming')
    try {
      const sig = await chain.claimSettled(onchainMatchId)
      setTxSig(sig)
      useGameStore.setState({ lastTx: { sig, label: 'Winnings collected on-chain' } })
      void useGameStore.getState().fetchBalance()
      setPhase('done')
      onDone?.(onchainMatchId)
    } catch (err) {
      const code = (err as Error).message
      if (code === 'AlreadyClaimed') {
        // Idempotent success — the payout was already pulled (e.g. a second tab, or a retry).
        setPhase('done')
        onDone?.(onchainMatchId)
        return
      }
      setPhase('error')
      setError(FRIENDLY_ERRORS[code] ?? `Couldn't collect your winnings (${code}).`)
    }
  }, [chain, onchainMatchId, phase, onDone])

  if (phase === 'done') {
    return (
      <div className="reclaim-card claim-card--done panel">
        <span className="reclaim-icon" aria-hidden="true">✓</span>
        <div className="reclaim-done-body">
          <div className="reclaim-title">Collected {fmt(payout)} USDC</div>
          <div className="reclaim-sub eyebrow">paid to your wallet</div>
          {txSig && (
            <a
              className="reclaim-tx-link"
              href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View transaction ↗
            </a>
          )}
        </div>
      </div>
    )
  }

  const busy = phase === 'claiming'

  // A conviction match returns a partial payout to non-winning seats, so `payout` alone doesn't
  // mean "won". Compute net P&L (payout − stake) to label honestly: only a profit is a win.
  const net = staked != null ? payout - staked : null
  const won = net != null && net > 0n

  return (
    <div className="reclaim-card claim-card panel">
      <div className="reclaim-head">
        <div className="reclaim-title">
          <span className="claim-won">
            {won || net == null ? 'You won' : 'Your payout'} {fmt(payout)} USDC
          </span>
        </div>
        <div className="reclaim-sub eyebrow">Match #{onchainMatchId} · settled &amp; ready to collect</div>
        {net != null && net !== 0n && (
          <div className="reclaim-sub eyebrow">
            {net > 0n ? `Net +${fmt(net)} USDC` : `Net −${fmt(-net)} USDC`}
          </div>
        )}
      </div>
      {error && <div className="reclaim-error eyebrow">{error}</div>}
      <button className="seal-btn reclaim-btn claim-btn" onClick={() => void collect()} disabled={busy}>
        {busy ? (
          <span className="reclaim-busy">
            <span className="lobby-spinner reclaim-spinner" />
            Collecting your winnings…
          </span>
        ) : (
          'Collect winnings'
        )}
      </button>
      {busy && (
        <div className="reclaim-sub eyebrow">
          {silent ? 'Sending it back to your table wallet — a few seconds.' : 'Approve the transaction in your wallet — this can take a few seconds to finalize.'}
        </div>
      )}
    </div>
  )
}
