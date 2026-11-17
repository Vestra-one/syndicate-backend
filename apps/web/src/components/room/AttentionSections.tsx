import { useEffect, useMemo, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { createAdapters } from '@/lib/adapters'
import type { ClaimableWinning } from '@/lib/adapters'
import { ReclaimCard } from '@/components/hud/ReclaimCard'
import { ClaimWinningsCard } from '@/components/hud/ClaimWinningsCard'
import '@/components/hud/hud.css'

/**
 * Stuck rooms this wallet can cancel & reclaim funds from — scanned directly on-chain
 * (seat accounts owned by the connected wallet); no backend needed. Moved verbatim
 * from the old Dashboard.
 */
export function MyReclaimableMatches() {
  const chain = useMemo(() => createAdapters().chain, [])
  const { connected } = useWallet()
  const [ids, setIds] = useState<string[]>([])

  useEffect(() => {
    if (!connected) { setIds([]); return }
    let alive = true
    chain.listReclaimableMatches()
      .then((matches) => { if (alive) setIds(matches.map((m) => m.onchainMatchId)) })
      .catch(() => { /* best-effort — an RPC hiccup shouldn't break the room */ })
    return () => { alive = false }
  }, [connected, chain])

  if (ids.length === 0) return null

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <span className="dash-section-dot dash-section-dot--live" />
        <span className="dash-section-label">Needs your attention</span>
        <span className="dash-section-sub">stuck rooms — cancel &amp; reclaim your funds</span>
      </div>
      <div className="dash-reclaim-list">
        {ids.map((id) => <ReclaimCard key={id} onchainMatchId={id} />)}
      </div>
    </section>
  )
}

/**
 * SETTLED matches this wallet has an unclaimed payout in — scanned directly on-chain.
 * Moved verbatim from the old Dashboard.
 */
export function MyClaimableWinnings() {
  const chain = useMemo(() => createAdapters().chain, [])
  const { connected } = useWallet()
  const [winnings, setWinnings] = useState<ClaimableWinning[]>([])
  const [collected, setCollected] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!connected) { setWinnings([]); setCollected(new Set()); return }
    let alive = true
    chain.listClaimableWinnings()
      .then((rows) => { if (alive) setWinnings(rows) })
      .catch(() => { /* best-effort — an RPC hiccup shouldn't break the room */ })
    return () => { alive = false }
  }, [connected, chain])

  const onDone = (id: string) => setCollected((prev) => new Set(prev).add(id))

  if (winnings.length === 0) return null

  const pendingTotal = winnings
    .filter((w) => !collected.has(w.onchainMatchId))
    .reduce((sum, w) => sum + w.payout, 0n)

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <span className="dash-section-dot dash-section-dot--win" />
        <span className="dash-section-label">Payouts to collect</span>
        <span className="dash-section-sub">
          {pendingTotal > 0n
            ? `${(Number(pendingTotal) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC waiting for you`
            : 'all collected'}
        </span>
      </div>
      <div className="dash-reclaim-list">
        {winnings.map((w) => (
          <ClaimWinningsCard
            key={w.onchainMatchId}
            onchainMatchId={w.onchainMatchId}
            payout={w.payout}
            staked={w.staked}
            onDone={onDone}
          />
        ))}
      </div>
    </section>
  )
}
