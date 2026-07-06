/**
 * Self-serve "cancel room & reclaim funds" for a match stuck in FILLING past its fill
 * deadline (or already VOID). Fully permissionless — never depends on the operator/backend:
 *   1. void_before_start  — anyone can send once `now >= fillDeadlineTs` (just pays the fee)
 *   2. refund             — player-signed pull refund of deposit + entry fee (idempotent)
 *
 * Both steps are safe to re-send: `cancelAndReclaim` re-checks on-chain status each attempt,
 * so BadStatus / AlreadyClaimed collapse into "already done" rather than a hard failure.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createAdapters } from '@/lib/adapters'
import type { OnchainMatchStatus, OnchainSeatInfo } from '@/lib/adapters'
import type { Chips } from '@/lib/protocol'
import { useGameStore } from '@/store/gameStore'

export type ReclaimPhase = 'idle' | 'checking' | 'voiding' | 'refunding' | 'done' | 'error'

const FRIENDLY_ERRORS: Record<string, string> = {
  FillDeadlineNotReached: "This room can't be cancelled yet — waiting for the fill deadline.",
  NoSeat: "You don't have a seat in this match.",
}

const POLL_MS = 15_000
const MAX_ATTEMPTS = 3 // void -> recheck -> refund -> recheck, with one retry margin

export interface UseReclaimMatch {
  phase: ReclaimPhase
  status: OnchainMatchStatus | null
  seat: OnchainSeatInfo | null
  /** True once the connected wallet can send void_before_start / refund right now. */
  reclaimable: boolean
  /** Seconds until `status.fillDeadlineTs`, while still FILLING; null otherwise. */
  secondsToFillDeadline: number | null
  error: string | null
  /** Total (buy-in + entry fee) returned on success, in token base units. */
  refundedAmount: Chips | null
  /** Signature of the refund tx once it lands — drives the explorer link on the done card. */
  txSig: string | null
  refresh: () => Promise<void>
  cancelAndReclaim: () => Promise<void>
}

export function useReclaimMatch(onchainMatchId: string | null | undefined): UseReclaimMatch {
  const chain = useMemo(() => createAdapters().chain, [])

  const [phase, setPhase] = useState<ReclaimPhase>('idle')
  const [status, setStatus] = useState<OnchainMatchStatus | null>(null)
  const [seat, setSeat] = useState<OnchainSeatInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refundedAmount, setRefundedAmount] = useState<Chips | null>(null)
  const [txSig, setTxSig] = useState<string | null>(null)
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000)
  const busyRef = useRef(false)

  // On a successful reclaim: surface the tx in the global banner and re-read the
  // on-chain balance (force past the throttle) so the wallet chip reflects the refund.
  const onReclaimed = useCallback((sig: string) => {
    setTxSig(sig)
    useGameStore.setState({ lastTx: { sig, label: 'Refund confirmed on-chain' } })
    void useGameStore.getState().fetchBalance()
  }, [])

  const refresh = useCallback(async () => {
    if (!onchainMatchId) {
      setStatus(null)
      setSeat(null)
      return
    }
    const [s, seatInfo] = await Promise.all([
      chain.getMatchStatus(onchainMatchId),
      chain.getMySeat(onchainMatchId),
    ])
    setStatus(s)
    setSeat(seatInfo)
  }, [chain, onchainMatchId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Local 1s tick drives the countdown; a slower poll catches on-chain state changes
  // (someone else voiding it, etc.) without the user having to act first.
  useEffect(() => {
    const tick = setInterval(() => setNowSec(Date.now() / 1000), 1_000)
    const poll = setInterval(() => { void refresh() }, POLL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [refresh])

  const fillDeadlinePassed = !!status && status.status === 'FILLING' && nowSec >= status.fillDeadlineTs
  const secondsToFillDeadline = status && status.status === 'FILLING'
    ? Math.max(0, Math.round(status.fillDeadlineTs - nowSec))
    : null
  const reclaimable =
    !!seat && !seat.claimed && !!status &&
    (status.status === 'VOID' || (status.status === 'FILLING' && fillDeadlinePassed))

  const cancelAndReclaim = useCallback(async () => {
    if (!onchainMatchId || busyRef.current) return
    busyRef.current = true
    setError(null)
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        setPhase('checking')
        const s = await chain.getMatchStatus(onchainMatchId)
        if (!s) throw new Error('Match not found on-chain.')
        setStatus(s)

        if (s.status === 'FILLING') {
          if (Date.now() / 1000 < s.fillDeadlineTs) {
            setPhase('error')
            setError(FRIENDLY_ERRORS.FillDeadlineNotReached)
            return
          }
          setPhase('voiding')
          // Try the single-signature combined path first: simulation runs before any
          // wallet prompt, so a lost race (someone else's void beat us to it) fails here
          // with no wasted signature — just fall back to the sequential pair below.
          try {
            const sig = await chain.cancelAndRefundSelf(onchainMatchId)
            setSeat(await chain.getMySeat(onchainMatchId))
            setRefundedAmount(s.buyIn + s.entryFee)
            onReclaimed(sig)
            setPhase('done')
            return
          } catch {
            // fall through to sequential void + refund
          }
          try {
            await chain.voidBeforeStart(onchainMatchId)
          } catch (err) {
            const code = (err as Error).message
            // BadStatus here almost always means someone else's void beat us to it — proceed.
            if (code !== 'BadStatus') {
              setPhase('error')
              setError(FRIENDLY_ERRORS[code] ?? `Couldn't cancel the room (${code}).`)
              return
            }
          }
          continue // re-check status (expected VOID) before refunding
        }

        if (s.status !== 'VOID') {
          setPhase('error')
          setError(`This room is ${s.status.toLowerCase()} — nothing to reclaim.`)
          return
        }

        setPhase('refunding')
        let refundSig: string | null = null
        try {
          refundSig = await chain.refundSelf(onchainMatchId)
        } catch (err) {
          const code = (err as Error).message
          if (code === 'AlreadyClaimed') {
            // idempotent success — already refunded in an earlier attempt
          } else if (code === 'BadStatus' && attempt < MAX_ATTEMPTS - 1) {
            continue // status flipped under us — loop back and re-check before retrying void
          } else {
            setPhase('error')
            setError(FRIENDLY_ERRORS[code] ?? `Couldn't send the refund (${code}).`)
            return
          }
        }

        setSeat(await chain.getMySeat(onchainMatchId))
        setRefundedAmount(s.buyIn + s.entryFee)
        if (refundSig) onReclaimed(refundSig)
        setPhase('done')
        return
      }
      setPhase('error')
      setError('Timed out reconciling match state — try again.')
    } catch (err) {
      setPhase('error')
      setError((err as Error).message)
    } finally {
      busyRef.current = false
    }
  }, [chain, onchainMatchId, onReclaimed])

  return {
    phase,
    status,
    seat,
    reclaimable,
    secondsToFillDeadline,
    error,
    refundedAmount,
    txSig,
    refresh,
    cancelAndReclaim,
  }
}
