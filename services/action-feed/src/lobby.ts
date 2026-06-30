/**
 * Lobby / FILLING-phase projection for the public observer surface.
 *
 * Matchmaking publishes lobby mutations on the Redis `rooms` channel (create/deposit →
 * `upsert`, host/auto start → `started`). The action-feed bridge (main.ts) feeds those
 * payloads here to keep an in-memory "forming games" model that powers `GET /upcoming-games`
 * and the `{ type: 'lobby' }` WebSocket broadcast.
 *
 * NOTE ON IDENTITY: unlike gameplay events (which are pseudonymous — `projectEvent` strips
 * wallets), the lobby feed INTENTIONALLY exposes wallet + resolved profile handle so observers
 * can see who is filling a room. This is a deliberate product decision and is why lobby
 * messages travel as `{ type: 'lobby' }` and never pass through `projectEvent`/`containsSecret`
 * (that guard exists to redact in-game action events, not the lobby roster).
 */

/** Pub/sub channel matchmaking publishes lobby mutations on (mirrors matchmaking redis-keys). */
export const ROOMS_CHANNEL = 'rooms';

/** Raw seat as published by matchmaking's `publishRoomsUpdate`. */
export interface RoomsChannelSeat {
  seatIndex: number;
  wallet: string;
  joinedTs: number;
}

/** Raw payload shape on ROOMS_CHANNEL (matchmaking/src/formation.ts publishRoomsUpdate). */
export interface RoomsChannelPayload {
  kind: 'upsert' | 'started';
  roomCode?: string;
  matchId: string;
  feedId?: string;
  tierId?: string;
  configHash?: string;
  buyIn?: number;
  seated?: number;
  seats?: RoomsChannelSeat[];
  maxPlayers?: number;
  fillDeadline?: number;
  version?: number;
}

/** A seat enriched with the resolved public handle for display. */
export interface LobbySeatView {
  seatIndex: number;
  wallet: string;
  handle: string;
  joinedTs: number;
}

/** A forming (pre-LIVE) game as exposed to observers. */
export interface FormingGame {
  matchId: string;
  roomCode?: string;
  feedId: string;
  tierId: string;
  buyIn?: number;
  seated: number;
  maxPlayers: number;
  fillDeadline: number;
  seats: LobbySeatView[];
  version: number;
  phase: 'FILLING';
}

export type FormingGamesState = Map<string, FormingGame>;

/** Resolve a wallet to its public handle. MUST be a cheap in-memory lookup (no DB/HTTP). */
export type HandleResolver = (wallet: string) => string;

export interface LobbyUpdateResult {
  game: FormingGame;
  /** True when the match left the lobby (kind: 'started') — broadcast as a transition, then drop. */
  evicted: boolean;
}

function buildGame(payload: RoomsChannelPayload, resolveHandle: HandleResolver, version: number): FormingGame {
  const seats: LobbySeatView[] = (payload.seats ?? []).map((s) => ({
    seatIndex: s.seatIndex,
    wallet: s.wallet,
    handle: resolveHandle(s.wallet),
    joinedTs: s.joinedTs,
  }));
  return {
    matchId: payload.matchId,
    roomCode: payload.roomCode,
    feedId: payload.feedId ?? 'unknown',
    tierId: payload.tierId ?? 'unknown',
    buyIn: payload.buyIn,
    seated: payload.seated ?? seats.length,
    maxPlayers: payload.maxPlayers ?? 0,
    fillDeadline: payload.fillDeadline ?? 0,
    seats,
    version,
    phase: 'FILLING',
  };
}

/**
 * Apply a ROOMS_CHANNEL mutation to the forming-games model. Last-writer-wins on `version`
 * (mirrors the gateway's lobby fan-out): a stale/older update is dropped. A `started` payload
 * evicts the match from the lobby (it is now LIVE) and is returned so the bridge can broadcast a
 * one-shot transition. Returns null for a missing matchId or a stale update.
 */
export function applyLobbyUpdate(
  games: FormingGamesState,
  payload: RoomsChannelPayload,
  resolveHandle: HandleResolver,
): LobbyUpdateResult | null {
  if (!payload || !payload.matchId) return null;
  const version = payload.version ?? 0;
  const existing = games.get(payload.matchId);
  if (existing && version < existing.version) return null; // stale; ignore

  if (payload.kind === 'started') {
    const game = existing ?? buildGame(payload, resolveHandle, version);
    games.delete(payload.matchId);
    return { game, evicted: true };
  }

  const game = buildGame(payload, resolveHandle, version);
  games.set(payload.matchId, game);
  return { game, evicted: false };
}

/**
 * List forming games for `GET /upcoming-games`. Drops entries whose fill deadline has passed
 * (defensive eviction — a missed `started` publish can't leak a stale room forever) and ranks
 * fuller, sooner-to-start rooms first, matching matchmaking's `listRooms` ordering.
 */
export function listForming(games: FormingGamesState, now: number): FormingGame[] {
  const out: FormingGame[] = [];
  for (const game of games.values()) {
    if (game.fillDeadline && game.fillDeadline <= now) {
      games.delete(game.matchId);
      continue;
    }
    out.push(game);
  }
  out.sort((a, b) => b.seated - a.seated || a.fillDeadline - b.fillDeadline || a.matchId.localeCompare(b.matchId));
  return out;
}
