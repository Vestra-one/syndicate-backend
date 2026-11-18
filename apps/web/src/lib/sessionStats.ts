/**
 * Your run at the tables on this device: hands played, net result and the current winning
 * streak. Kept in localStorage — it is a personal scoreboard, not an account.
 */
export interface SessionStats {
  hands: number
  /** Net result in chip base units (stringified bigint). */
  net: string
  streak: number
  bestStreak: number
  /** Matches already counted, newest last (bounded). */
  seen: string[]
}

const KEY = 'st-run-v1'
const EMPTY: SessionStats = { hands: 0, net: '0', streak: 0, bestStreak: 0, seen: [] }

export function readStats(wallet: string | null): SessionStats {
  if (!wallet) return EMPTY
  try {
    const raw = localStorage.getItem(`${KEY}:${wallet}`)
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as SessionStats) } : EMPTY
  } catch {
    return EMPTY
  }
}

/** Count a finished hand once. Returns the updated run. */
export function recordHand(wallet: string | null, matchId: string, net: bigint, won: boolean): SessionStats {
  const cur = readStats(wallet)
  if (!wallet || cur.seen.includes(matchId)) return cur
  const streak = won ? cur.streak + 1 : 0
  const next: SessionStats = {
    hands: cur.hands + 1,
    net: (BigInt(cur.net) + net).toString(),
    streak,
    bestStreak: Math.max(cur.bestStreak, streak),
    seen: [...cur.seen, matchId].slice(-50),
  }
  try {
    localStorage.setItem(`${KEY}:${wallet}`, JSON.stringify(next))
  } catch {
    /* private mode: the run just does not persist */
  }
  return next
}
