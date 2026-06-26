import { useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { formatPrice } from '@/lib/format'
import type { MatchPhase } from '@/lib/protocol'

const PHASE_COPY: Record<MatchPhase, string> = {
  FILLING: 'Filling table',
  SEALING: 'Sealing predictions',
  LIVE: 'Live',
  SETTLEMENT_WINDOW: 'Settlement window',
  DECRYPT: 'Opening time-lock',
  SETTLED: 'Settled',
  VOID: 'Voided',
}

/** Match lifecycle + resolution. Surfaces every exit path (§10.4). */
export function RoundStatus() {
  const match = useGameStore((s) => s.match)
  const terms = useGameStore((s) => s.terms)
  const settlement = useGameStore((s) => s.settlement)
  const voided = useGameStore((s) => s.voided)

  if (voided) return <VoidPanel reason={voided.reason} />
  if (settlement) return <SettledPanel />

  if (!match) {
    return (
      <div className="round panel">
        <span className="eyebrow">match</span>
        <div className="round-label">Waiting for the table…</div>
      </div>
    )
  }

  const label =
    match.phase === 'LIVE'
      ? `Round ${match.round} of ${terms?.roundCount ?? match.round}`
      : PHASE_COPY[match.phase]

  return (
    <div className={`round panel round--${match.phase.toLowerCase()}`}>
      <div className="round-head">
        <span className="eyebrow">{PHASE_COPY[match.phase]}</span>
        <span className="round-clock mono">{match.pot}</span>
      </div>
      <div className="round-label">{label}</div>
      <div className="round-prices mono">
        <span>pot {match.pot}</span>
        <span>current bet {match.currentBet}</span>
      </div>
    </div>
  )
}

function SettledPanel() {
  const settlement = useGameStore((s) => s.settlement)!
  const match = useGameStore((s) => s.match)
  const terms = useGameStore((s) => s.terms)
  const claim = useGameStore((s) => s.claim)
  const [tx, setTx] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)

  const decimals = terms?.decimals ?? 2
  const yourSeat = match?.yourSeat
  const yourAward = settlement.awards.find((a) => a.seat === yourSeat)?.amount ?? 0
  const won = yourAward > 0

  const onClaim = async () => {
    setClaiming(true)
    const sig = await claim()
    setTx(sig)
    setClaiming(false)
  }

  return (
    <div className="round panel round--settled">
      <span className="eyebrow">settled</span>
      <div className="round-label">{won ? 'You won the pot' : 'Match settled'}</div>
      <div className="round-prices mono">
        <span>settle {formatPrice(settlement.settlementPrice / 10 ** decimals)}</span>
        <span>{won ? `+${yourAward}` : 'no award'}</span>
      </div>
      {won && (
        <button className="seal-btn" onClick={onClaim} disabled={claiming || !!tx}>
          {tx ? 'Claimed ✓' : claiming ? 'Claiming…' : `Claim ${yourAward}`}
        </button>
      )}
    </div>
  )
}

function VoidPanel({ reason }: { reason: string }) {
  const refund = useGameStore((s) => s.refund)
  const [tx, setTx] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onRefund = async () => {
    setBusy(true)
    setTx(await refund())
    setBusy(false)
  }

  return (
    <div className="round panel round--void">
      <span className="eyebrow">match voided</span>
      <div className="round-label">Funds returned in full</div>
      <div className="round-prices mono">
        <span>{reason}</span>
      </div>
      <button className="seal-btn" onClick={onRefund} disabled={busy || !!tx}>
        {tx ? 'Refunded ✓' : busy ? 'Refunding…' : 'Refund deposit'}
      </button>
    </div>
  )
}
