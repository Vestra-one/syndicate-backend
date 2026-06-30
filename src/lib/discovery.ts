import type { LiveGame } from './protocol'

const API_URL = import.meta.env.VITE_API_URL as string | undefined

/** "Hot" popularity score — the default dashboard sort (§8). */
export function ratedScore(g: LiveGame): number {
  return g.spectators * 2 + g.actionsPerMin + g.potSize / 1000
}

/**
 * Fetch active games from the action-feed service (GET /active-games).
 *
 * Returns the REAL result, including an empty list when no matches are live.
 * Throws on network/HTTP failure so the store surfaces a truthful error state —
 * no synthetic fallback tables (fake tables that route nowhere are worse than an
 * honest empty/error state).
 */
export async function fetchActiveGames(): Promise<LiveGame[]> {
  if (!API_URL) throw new Error('VITE_API_URL is not set — configure the API URL in .env')

  const res = await fetch(`${API_URL}/active-games`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`/active-games ${res.status}`)
  const data = (await res.json()) as { games?: LiveGame[] } | LiveGame[]
  // Accept both { games: [...] } and a raw array
  return Array.isArray(data) ? data : (data.games ?? [])
}
