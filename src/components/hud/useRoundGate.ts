import { useGameStore } from '@/store/gameStore'
import { useNow } from '@/lib/useNow'

/**
 * The current engine round's wall-clock betting window. The engine advances the round the
 * moment a street's betting completes, but the schedule gates when the NEXT round's betting
 * opens — in that gap the server rejects acts ("betting_closed") even though the turn is
 * already assigned and its deadline is clamped to the window opening. The UI must present
 * that gap as "queued until the round opens", not as an actionable turn.
 */
export function useRoundGate(): { open: boolean; opensAt: number | null; round: number } {
  const round = useGameStore((s) => s.match?.round ?? 1)
  const schedule = useGameStore((s) => s.streetSchedule)
  const now = useNow(500)
  const win = schedule?.[Math.max(0, round - 1)]
  if (!win) return { open: true, opensAt: null, round }
  return { open: now >= win.open, opensAt: win.open, round }
}
