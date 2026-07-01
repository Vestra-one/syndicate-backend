import type { LiveGame, UpcomingGame } from './protocol'

// In local dev with VITE_DEVNET_USER set, route through the Vite proxy
// (/api-proxy/...) so auth is injected server-side and CORS preflight is avoided.
// In production VITE_DEVNET_USER is unset so we hit the real API directly.
const API_URL = (import.meta.env.VITE_DEVNET_USER as string | undefined)
  ? '/api-proxy'
  : (import.meta.env.VITE_API_URL as string | undefined)

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
// The action-feed service reports the price feed as `feedId` (e.g. "BTC/USD"),
// matching the convention used by the gateway's RoomListing/RoomsUpdate — not `feed`.
function normalizeLiveGame(raw: Record<string, unknown>): LiveGame {
  return {
    matchId: String(raw.matchId ?? ''),
    feed: String(raw.feedId ?? raw.feed ?? ''),
    buyIn: Number(raw.buyIn ?? 0),
    potSize: Number(raw.potSize ?? 0),
    spectators: Number(raw.spectators ?? 0),
    actionsPerMin: Number(raw.actionsPerMin ?? 0),
    startedAt: Number(raw.startedAt ?? 0),
  }
}

function normalizeUpcomingGame(raw: Record<string, unknown>): UpcomingGame {
  return {
    matchId: String(raw.matchId ?? ''),
    onchainMatchId: raw.onchainMatchId as string | undefined,
    feed: String(raw.feedId ?? raw.feed ?? ''),
    buyIn: Number(raw.buyIn ?? 0),
    entryFee: raw.entryFee as number | undefined,
    seated: Number(raw.seated ?? 0),
    maxPlayers: Number(raw.maxPlayers ?? 0),
    minPlayers: raw.minPlayers as number | undefined,
    fillDeadline: raw.fillDeadline as number | undefined,
  }
}

export async function fetchActiveGames(): Promise<LiveGame[]> {
  if (!API_URL) throw new Error('VITE_API_URL is not set — configure the API URL in .env')

  const res = await fetch(`${API_URL}/active-games`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`/active-games ${res.status}`)
  const data = (await res.json()) as { games?: Record<string, unknown>[] } | Record<string, unknown>[]
  const games = Array.isArray(data) ? data : (data.games ?? [])
  return games.map(normalizeLiveGame)
}

export async function fetchUpcomingGames(): Promise<UpcomingGame[]> {
  if (!API_URL) throw new Error('VITE_API_URL is not set — configure the API URL in .env')

  const res = await fetch(`${API_URL}/upcoming-games`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`/upcoming-games ${res.status}`)
  const data = (await res.json()) as { games?: Record<string, unknown>[] } | Record<string, unknown>[]
  const games = Array.isArray(data) ? data : (data.games ?? [])
  return games.map(normalizeUpcomingGame)
}
