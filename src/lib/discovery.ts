import type { LiveGame, UpcomingGame } from './protocol'
import { api, type LiveMatch, type LobbyRoom } from './api'

/** "Hot" popularity score — the default dashboard sort (§8). */
export function ratedScore(g: LiveGame): number {
  return g.spectators * 2 + g.actionsPerMin + Number(g.potSize) / 1000
}

/** REST timestamps are ms epoch (§1), but on-chain-derived values can leak seconds; normalize. */
export function toEpochMs(ts: number | null | undefined): number | undefined {
  if (ts == null) return undefined
  return ts > 1e12 ? ts : ts * 1000
}

/**
 * `GET /v1/matches/live` → the dashboard's "Live games" row. v2's spectate list is lean
 * (no spectator/actions-per-min/pot telemetry), so those fields default to 0 — the full
 * numbers arrive over the WS match channel once a table is opened.
 */
function liveMatchToGame(m: LiveMatch): LiveGame {
  return {
    matchId: m.match_id,
    feed: m.feed,
    buyIn: BigInt(m.buy_in),
    potSize: 0n,
    spectators: 0,
    actionsPerMin: 0,
    startedAt: toEpochMs(m.live_start) ?? 0,
  }
}

/** `GET /v1/lobby` → the dashboard's "Upcoming/Filling" row (public rooms only). */
function lobbyRoomToGame(r: LobbyRoom): UpcomingGame {
  return {
    matchId: r.match_id,
    onchainMatchId: String(r.onchain_match_id),
    feed: r.feed,
    buyIn: BigInt(r.buy_in),
    seated: r.confirmed,
    maxPlayers: r.max_players ?? 0,
    minPlayers: r.min_players ?? undefined,
    fillDeadline: toEpochMs(r.fill_deadline),
  }
}

/** Live/spectatable matches (Sealing + Live). Returns the real result (possibly empty). */
export async function fetchActiveGames(): Promise<LiveGame[]> {
  const { matches } = await api.getLive()
  return matches.map(liveMatchToGame)
}

/** Filling public rooms open to join. Returns the real result (possibly empty). */
export async function fetchUpcomingGames(): Promise<UpcomingGame[]> {
  const { rooms } = await api.getLobby()
  return rooms.map(lobbyRoomToGame)
}
