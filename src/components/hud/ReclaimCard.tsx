import { useReclaimMatch } from '@/hooks/useReclaimMatch'

// USDC has 6 decimals — mirrors the fmt() convention used across Lobby/Dashboard.
const fmt = (base: number) => (base / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })

function fmtCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
}

/**
 * "Cancel room & reclaim funds" — for a match this wallet deposited into that never filled.
 * Self-contained: reads status on-chain, so it works on the room's own card AND in a
 * standalone "my matches" list, with no active gateway/match state required.
 */
export function ReclaimCard({ onchainMatchId }: { onchainMatchId: string | null | undefined }) {
  const { phase, status, seat, reclaimable, secondsToFillDeadline, error, refundedAmount, txSig, cancelAndReclaim } =
    useReclaimMatch(onchainMatchId)

  if (!onchainMatchId) return null

  // `refund` closes the seat account on success, so `seat` goes null right after — check
  // `done` BEFORE the "nothing to show" guard below, or the success card would vanish instantly.
  if (phase === 'done') {
    return (
      <div className="reclaim-card reclaim-card--done panel">
        <span className="reclaim-icon" aria-hidden="true">✓</span>
        <div className="reclaim-done-body">
          <div className="reclaim-title">Refunded {fmt(refundedAmount ?? 0)} USDC</div>
          <div className="reclaim-sub eyebrow">+ reclaimed seat rent · room cancelled</div>
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

  if (!status || !seat || seat.claimed) return null
  if (status.status !== 'FILLING' && status.status !== 'VOID') return null

  const total = status.buyIn + status.entryFee

  if (!reclaimable) {
    // Not yet actionable — a quiet hint rather than a button, so we don't invite a failed tx.
    return (
      <div className="reclaim-card reclaim-card--waiting panel">
        <span className="eyebrow">
          Room hasn't filled — cancellable in{' '}
          {secondsToFillDeadline != null ? fmtCountdown(secondsToFillDeadline) : '…'}
        </span>
      </div>
    )
  }

  const busy = phase === 'checking' || phase === 'voiding' || phase === 'refunding'
  const busyLabel =
    phase === 'voiding' ? 'Cancelling match…' : phase === 'refunding' ? 'Returning your USDC…' : 'Checking…'

  return (
    <div className="reclaim-card panel">
      <div className="reclaim-head">
        <div className="reclaim-title">Room never filled</div>
        <div className="reclaim-sub eyebrow">
          You'll get back {fmt(total)} USDC (buy-in + entry fee) + your seat rent
        </div>
      </div>
      {error && <div className="reclaim-error eyebrow">{error}</div>}
      <button className="seal-btn reclaim-btn" onClick={() => void cancelAndReclaim()} disabled={busy}>
        {busy ? (
          <span className="reclaim-busy">
            <span className="lobby-spinner reclaim-spinner" />
            {busyLabel}
          </span>
        ) : (
          'Cancel & reclaim funds'
        )}
      </button>
      {busy && (
        <div className="reclaim-sub eyebrow">
          Approve the transaction in your wallet — this can take a few seconds to finalize.
        </div>
      )}
    </div>
  )
}
