/**
 * Gateway protocol relay — forwards authenticated gameplay messages to match-engine
 * and fans out Redis pub/sub match events to subscribed wallets.
 */

import type { MatchSubscriber } from './matchSubscriber.ts';

export interface RelayDeps {
  matchEngineUrl: string;
  matchmakingUrl: string;
  actionFeedUrl: string;
  configUrl: string;
  authToken?: string;
  subscriber?: MatchSubscriber;
  /** Server-authoritative clock; clients compute countdowns relative to this. */
  now?: () => number;
}

export type RelayPush = (wallet: string, msg: unknown) => void;

/** Redis pub/sub channel matchmaking publishes lobby mutations on (create/deposit/start). */
export const ROOMS_CHANNEL = 'rooms';

export function createRelayHandler(deps: RelayDeps, push: RelayPush) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (deps.authToken) headers.authorization = `Bearer ${deps.authToken}`;
  const now = deps.now ?? (() => Date.now());

  /** matchId → wallets spectating/playing */
  const matchWatchers = new Map<string, Set<string>>();
  /** wallets subscribed to the global lobby feed (pushed on registry mutation). */
  const lobbySubscribers = new Set<string>();
  /**
   * matchId → wallets watching that specific FILLING room. Used for the FILLING→LIVE handoff:
   * when the room's `started` mutation arrives, these wallets are upgraded to the live match feed
   * with no client round-trip. Distinct from `lobbySubscribers` (the global browse feed) so only
   * observers who opened *this* room get its live events — not every lobby browser.
   */
  const roomWatchers = new Map<string, Set<string>>();

  /** Stamp every outbound envelope with server time so clients can sync their clock. */
  const send = (wallet: string, msg: Record<string, unknown>) => push(wallet, { ...msg, serverTime: now() });

  if (deps.subscriber) {
    deps.subscriber.onMessage((channel, payload) => {
      if (channel === ROOMS_CHANNEL) {
        // Last-writer-wins on the client via the included version; pull is the fallback.
        for (const wallet of lobbySubscribers) send(wallet, { type: 'roomsUpdated', update: payload });
        // FILLING→LIVE handoff: when a watched room starts, move its watchers onto the live match
        // feed and tell them to switch views. Idempotent — clearing the entry makes a replayed
        // `started` (last-writer-wins) a no-op; `ensureSubscribed` is itself idempotent.
        const p = (payload ?? {}) as { kind?: string; matchId?: string };
        if (p.kind === 'started' && p.matchId) {
          const watchers = roomWatchers.get(p.matchId);
          if (watchers && watchers.size > 0) {
            void deps.subscriber!.ensureSubscribed(p.matchId);
            let live = matchWatchers.get(p.matchId);
            if (!live) {
              live = new Set();
              matchWatchers.set(p.matchId, live);
            }
            for (const wallet of watchers) {
              live.add(wallet);
              send(wallet, { type: 'matchStarted', matchId: p.matchId });
            }
            roomWatchers.delete(p.matchId);
          }
        }
        return;
      }
      const watchers = matchWatchers.get(channel);
      if (!watchers) return;
      const msg = normalizeEnginePayload(channel, payload);
      if (!msg) return;
      for (const wallet of watchers) send(wallet, msg);
    });
  }

  return async function handleMessage(wallet: string, msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? '');

    if (type === 'ping') {
      send(wallet, { type: 'pong' });
      return;
    }

    if (type === 'subscribe') {
      const matchId = String(msg.matchId ?? '');
      if (!matchId) return;
      let watchers = matchWatchers.get(matchId);
      if (!watchers) {
        watchers = new Set();
        matchWatchers.set(matchId, watchers);
      }
      watchers.add(wallet);
      if (deps.subscriber) await deps.subscriber.ensureSubscribed(matchId);
      const terms = await fetchTableTerms(deps, matchId);
      if (terms) send(wallet, { type: 'tableTerms', terms });
      const stateRes = await fetch(`${deps.matchEngineUrl}/internal/matches/${encodeURIComponent(matchId)}/state`, { headers });
      if (stateRes.ok) {
        const state = await stateRes.json() as Record<string, unknown>;
        send(wallet, { type: 'matchState', state: buildMatchStateView(matchId, state), ...forwardDeadlines(state) });
      }
      return;
    }

    // Lobby push: subscribe to the global rooms feed + send the current list. Updates arrive
    // via the ROOMS_CHANNEL fan-out above; `fetchLobby` remains the pull fallback.
    if (type === 'subscribeLobby') {
      lobbySubscribers.add(wallet);
      if (deps.subscriber) await deps.subscriber.ensureChannelSubscribed(ROOMS_CHANNEL);
      const rooms = await fetchRoomsList(deps, msg);
      send(wallet, { type: 'lobbyList', rooms });
      return;
    }

    if (type === 'unsubscribeLobby') {
      lobbySubscribers.delete(wallet);
      return;
    }

    // Watch a specific FILLING room so the observer is auto-upgraded to the live feed when it
    // starts (see the ROOMS_CHANNEL `started` handoff above). Lobby mutations for the room still
    // arrive via the global `roomsUpdated` fan-out; this only registers the start-time upgrade.
    if (type === 'subscribeRoom') {
      const matchId = String(msg.matchId ?? '');
      if (!matchId) return;
      let watchers = roomWatchers.get(matchId);
      if (!watchers) {
        watchers = new Set();
        roomWatchers.set(matchId, watchers);
      }
      watchers.add(wallet);
      if (deps.subscriber) await deps.subscriber.ensureChannelSubscribed(ROOMS_CHANNEL);
      return;
    }

    if (type === 'unsubscribeRoom') {
      const matchId = String(msg.matchId ?? '');
      const watchers = roomWatchers.get(matchId);
      if (watchers) {
        watchers.delete(wallet);
        if (watchers.size === 0) roomWatchers.delete(matchId);
      }
      return;
    }

    if (type === 'sealPrediction') {
      const matchId = String(msg.matchId ?? '');
      await fetch(`${deps.matchEngineUrl}/internal/matches/${encodeURIComponent(matchId)}/seal`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          wallet,
          ciphertext: msg.ciphertext,
          playerId: msg.seatIndex,
          targetRound: msg.targetRound,
          commitmentHex: msg.commitmentHex,
          blindingHex: msg.blindingHex,
          signature: msg.signature,
        }),
      });
      return;
    }

    if (type === 'act') {
      const matchId = String(msg.matchId ?? '');
      await fetch(`${deps.matchEngineUrl}/internal/matches/${encodeURIComponent(matchId)}/actions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          wallet,
          action: msg.action,
          signature: msg.signature,
          seatIndex: msg.seatIndex,
          nonce: msg.nonce,
          prevHeadHex: msg.prevHeadHex,
        }),
      });
      return;
    }

    if (type === 'setDefault') {
      const matchId = String(msg.matchId ?? '');
      await fetch(`${deps.matchEngineUrl}/internal/matches/${encodeURIComponent(matchId)}/actions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          wallet,
          default: msg.default,
          signature: msg.signature,
          seatIndex: msg.seatIndex,
        }),
      });
      return;
    }

    if (type === 'fetchLobby') {
      const roomCode = String(msg.roomCode ?? '');
      const res = await fetch(`${deps.matchmakingUrl}/rooms/${encodeURIComponent(roomCode)}?wallet=${encodeURIComponent(wallet)}`);
      const json = await res.json() as { lobby?: unknown };
      send(wallet, { type: 'lobbyState', lobby: json.lobby });
      return;
    }

    if (type === 'fetchQueueStatus') {
      const tier = String(msg.tierId ?? 'tier-low');
      const feed = String(msg.feedId ?? 'BTC/USD');
      const token = String(msg.token ?? 'USDC');
      const res = await fetch(`${deps.matchmakingUrl}/queue/status?tier=${tier}&feed=${feed}&token=${token}`);
      const json = await res.json() as { status?: unknown };
      send(wallet, { type: 'queueStatus', status: json.status });
    }
  };
}

/** Query the matchmaking registry lobby feed (`GET /rooms`), passing through any filters. */
async function fetchRoomsList(deps: RelayDeps, msg: Record<string, unknown>): Promise<unknown[]> {
  try {
    const params = new URLSearchParams();
    if (msg.feed) params.set('feed', String(msg.feed));
    if (msg.template) params.set('template', String(msg.template));
    if (msg.buyIn !== undefined) params.set('buyIn', String(msg.buyIn));
    const qs = params.toString();
    const res = await fetch(`${deps.matchmakingUrl}/rooms${qs ? `?${qs}` : ''}`);
    if (!res.ok) return [];
    const json = await res.json() as { rooms?: unknown[] };
    return json.rooms ?? [];
  } catch {
    return [];
  }
}

async function fetchTableTerms(deps: RelayDeps, matchId: string): Promise<unknown | undefined> {
  try {
    const res = await fetch(`${deps.configUrl}/config/table?matchId=${encodeURIComponent(matchId)}`);
    if (res.ok) {
      const json = await res.json() as { terms?: unknown };
      return json.terms;
    }
    const mm = await fetch(`${deps.matchmakingUrl}/matches/${encodeURIComponent(matchId)}/terms`);
    if (mm.ok) {
      const json = await mm.json() as { terms?: unknown };
      return json.terms;
    }
  } catch {
    // optional enrichment
  }
  return undefined;
}

function buildMatchStateView(matchId: string, raw: Record<string, unknown>) {
  return {
    matchId,
    phase: String(raw.phase ?? 'LIVE'),
    round: Number(raw.round ?? 1),
    pot: Number(raw.pot ?? 0),
    currentBet: 0,
    buttonSeat: 0,
    toActSeat: raw.toActSeat ?? raw.to_act_seat ?? null,
    seats: [],
    feedPrice: 0,
  };
}

/**
 * Copy only the engine-provided ABSOLUTE deadlines that are present. The gateway never
 * fabricates a deadline (a fabricated one makes a client's `deadline - serverTime` countdown
 * wrong and can time a player out unfairly) — an omitted deadline is surfaced as absent.
 */
function forwardDeadlines(p: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const seal = pick('sealEndsAt', 'seal_ends_at');
  const betting = pick('bettingEndsAt', 'betting_ends_at', 'streetEndsAt', 'street_ends_at');
  const matchEnd = pick('matchEndsAt', 'match_ends_at', 'scheduledEndTs', 'scheduled_end_ts');
  const turn = pick('yourTurnDeadline', 'your_turn_deadline', 'deadline');
  if (seal !== undefined) out.sealEndsAt = seal;
  if (betting !== undefined) out.bettingEndsAt = betting;
  if (matchEnd !== undefined) out.matchEndsAt = matchEnd;
  if (turn !== undefined) out.yourTurnDeadline = turn;
  return out;
}

function normalizeEnginePayload(matchId: string, payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const kind = String(p.type ?? '');
  if (kind === 'matchState' && p.state && typeof p.state === 'object') {
    return { type: 'matchState', state: buildMatchStateView(matchId, p.state as Record<string, unknown>), ...forwardDeadlines(p) };
  }
  if (kind === 'yourTurn') {
    // Forward the engine's absolute deadlines verbatim; never synthesize one.
    return {
      type: 'yourTurn',
      matchId,
      toCall: Number(p.toCall ?? 0),
      minRaiseTo: Number(p.minRaiseTo ?? 0),
      ...forwardDeadlines(p),
    };
  }
  if (kind === 'settled') return { type: 'settled', result: p.result ?? p };
  if (kind === 'void') return { type: 'void', matchId, reason: p.reason ?? 'unknown' };
  if (kind === 'event') return { type: 'event', event: p.event ?? p };
  return p;
}

export async function fetchActiveMatchesForWallet(deps: RelayDeps, wallet: string): Promise<string[]> {
  try {
    const res = await fetch(`${deps.actionFeedUrl}/profiles/${encodeURIComponent(wallet)}`);
    if (!res.ok) return [];
    return [];
  } catch {
    return [];
  }
}
