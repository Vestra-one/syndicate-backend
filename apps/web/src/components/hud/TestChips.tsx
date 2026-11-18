import { useGameStore } from '@/store/gameStore'
import { formatChips } from '@/lib/format'

/**
 * "Get test chips" — one click to a playable balance on devnet. Renders nothing when the
 * deployment has no faucet (anywhere chips have value).
 */
export function TestChips({ compact = false }: { compact?: boolean }) {
  const faucet = useGameStore((s) => s.faucet)
  const busy = useGameStore((s) => s.faucetBusy)
  const note = useGameStore((s) => s.faucetNote)
  const getTestChips = useGameStore((s) => s.getTestChips)
  if (!faucet) return null
  return (
    <div className={`test-chips ${compact ? 'test-chips--compact' : ''}`}>
      <button className="test-chips-btn" type="button" disabled={busy} onClick={() => void getTestChips()}>
        {busy ? 'Sending chips…' : `Get ${formatChips(BigInt(faucet.chips))} test chips`}
      </button>
      {note && <span className="test-chips-note">{note}</span>}
    </div>
  )
}
