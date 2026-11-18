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
  /** Fibs: points for playing, winning and quick calls. They set your level. */
  fibs?: number
  /** Days in a row with at least one hand, and the last day played (YYYY-MM-DD, local). */
  days?: number
  lastDay?: string
  /** Head-to-head by rival wallet: hands where you finished closer (w) or they did (l). */
  rivals?: Record<string, { w: number; l: number }>
}

/** Fibs for sitting through a hand, and the bonus for taking the pot. */
export const HAND_FIBS = 20
export const WIN_FIBS = 50

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
export function recordHand(
  wallet: string | null,
  matchId: string,
  net: bigint,
  won: boolean,
  faced: { wallet: string; beat: boolean }[] = [],
): SessionStats {
  const cur = readStats(wallet)
  if (!wallet || cur.seen.includes(matchId)) return cur
  const streak = won ? cur.streak + 1 : 0
  const rivals = { ...(cur.rivals ?? {}) }
  for (const f of faced) {
    const r = rivals[f.wallet] ?? { w: 0, l: 0 }
    rivals[f.wallet] = f.beat ? { w: r.w + 1, l: r.l } : { w: r.w, l: r.l + 1 }
  }
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = day(new Date())
  const yesterday = day(new Date(Date.now() - 86_400_000))
  const days = cur.lastDay === today ? (cur.days ?? 1) : cur.lastDay === yesterday ? (cur.days ?? 1) + 1 : 1
  const next: SessionStats = {
    hands: cur.hands + 1,
    net: (BigInt(cur.net) + net).toString(),
    streak,
    bestStreak: Math.max(cur.bestStreak, streak),
    seen: [...cur.seen, matchId].slice(-50),
    rivals,
    fibs: (cur.fibs ?? 0) + HAND_FIBS + (won ? WIN_FIBS : 0),
    days,
    lastDay: today,
  }
  try {
    localStorage.setItem(`${KEY}:${wallet}`, JSON.stringify(next))
  } catch {
    /* private mode: the run just does not persist */
  }
  return next
}

/** Add Fibs outside a hand (quick calls). Returns the updated run. */
export function addFibs(wallet: string | null, amount: number): SessionStats {
  const cur = readStats(wallet)
  if (!wallet || amount <= 0) return cur
  const next = { ...cur, fibs: (cur.fibs ?? 0) + amount }
  try {
    localStorage.setItem(`${KEY}:${wallet}`, JSON.stringify(next))
  } catch {
    /* not persisted */
  }
  return next
}

const TITLES = ['Newcomer', 'Regular', 'Sharp', 'Card Reader', 'High Roller', 'Table Captain', 'Closer', 'Oracle', 'Legend']

/** Level from Fibs: each level needs a little more than the last. */
export function levelOf(fibs: number): { level: number; title: string; into: number; span: number } {
  let level = 1
  let floor = 0
  let span = 100
  while (fibs >= floor + span) {
    floor += span
    level++
    span = 100 + (level - 1) * 60
  }
  return { level, title: TITLES[Math.min(level, TITLES.length) - 1], into: fibs - floor, span }
}

/** Adopt the server's Fibs total when it is ahead (another device, or cleared storage). */
export function adoptServerFibs(wallet: string | null, serverFibs: number): SessionStats {
  const cur = readStats(wallet)
  if (!wallet || serverFibs <= (cur.fibs ?? 0)) return cur
  const next = { ...cur, fibs: serverFibs }
  try {
    localStorage.setItem(`${KEY}:${wallet}`, JSON.stringify(next))
  } catch {
    /* not persisted */
  }
  return next
}

