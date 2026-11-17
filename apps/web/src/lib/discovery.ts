import type { LiveGame, PastHand, UpcomingGame } from './protocol'
import { api, type HistoryMatch, type LiveMatch, type LobbyRoom } from './api'

/** "Hot" popularity score — the default dashboard sort (§8). */
export function ratedScore(g: LiveGame): number {
  return g.spectators * 2 + g.actionsPerMin + Number(g.potSize) / 1000
}

/** REST timestamps are ms epoch (§1), but on-chain-derived values can leak seconds; normalize. */
export function toEpochMs(ts: number | null | undefined): number | undefined {
  if (ts == null) return undefined
  return ts > 1e12 ? ts : ts * 1000
}

/** `GET /v1/matches/live` → the dashboard's "Live games" row. */
function liveMatchToGame(m: LiveMatch): LiveGame {
  return {
    matchId: m.match_id,
    onchainMatchId: String(m.onchain_match_id),
    feed: m.feed,
    buyIn: BigInt(m.buy_in),
    potSize: m.pot != null ? BigInt(m.pot) : 0n,
    spectators: m.watchers,
    actionsPerMin: 0,
    // `/v1/matches/live` includes 'sealing' rows (pre-live) where live_start is still
    // null — falling back to epoch 0 there rendered as "20642d ago". Fall back to now
    // instead: the table just entered this list, so "just now" is accurate and
    // self-corrects to the real clock once live_start lands on the next poll.
    startedAt: toEpochMs(m.live_start) ?? Date.now(),
    seated: m.confirmed ?? undefined,
    maxPlayers: m.max_players ?? undefined,
    round: m.round ?? undefined,
    roundCount: m.round_count ?? undefined,
    creatorWallet: m.creator_wallet ?? undefined,
    creatorHandle: m.creator_handle ?? undefined,
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
    creatorWallet: r.creator_wallet ?? undefined,
    creatorHandle: r.creator_handle ?? undefined,
  }
}

/** `GET /v1/matches/history` → a "Past hands" card. */
function historyMatchToHand(m: HistoryMatch): PastHand {
  return {
    matchId: m.match_id,
    onchainMatchId: String(m.onchain_match_id),
    feed: m.feed,
    buyIn: BigInt(m.buy_in),
    maxPlayers: m.max_players ?? undefined,
    voidKind: m.void_kind,
    finalPot: m.final_pot != null ? BigInt(m.final_pot) : null,
    rake: m.rake != null ? BigInt(m.rake) : null,
    settlementPriceWad: m.settlement_price_wad,
    settlementTxSig: m.settlement_tx_sig,
    endedAt: toEpochMs(m.ended_at) ?? 0,
    winner: m.winner
      ? {
          wallet: m.winner.wallet,
          handle: m.winner.handle,
          potWon: m.winner.pot_won != null ? BigInt(m.winner.pot_won) : null,
        }
      : null,
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

/** Settled hands, newest first — one page. */
export async function fetchHistory(
  cursor?: string,
): Promise<{ hands: PastHand[]; nextCursor: string | null }> {
  const { matches, next_cursor } = await api.getHistory({ cursor, limit: 12 })
  return { hands: matches.map(historyMatchToHand), nextCursor: next_cursor }
}
