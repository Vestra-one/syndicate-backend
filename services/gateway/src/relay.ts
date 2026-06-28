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
}

export type RelayPush = (wallet: string, msg: unknown) => void;

export function createRelayHandler(deps: RelayDeps, push: RelayPush) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (deps.authToken) headers.authorization = `Bearer ${deps.authToken}`;

  /** matchId → wallets spectating/playing */
  const matchWatchers = new Map<string, Set<string>>();

  if (deps.subscriber) {
    deps.subscriber.onMessage((matchId, payload) => {
      const watchers = matchWatchers.get(matchId);
      if (!watchers) return;
      const msg = normalizeEnginePayload(matchId, payload);
      if (!msg) return;
      for (const wallet of watchers) push(wallet, msg);
    });
  }

  return async function handleMessage(wallet: string, msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? '');

    if (type === 'ping') {
      push(wallet, { type: 'pong' });
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
      if (terms) push(wallet, { type: 'tableTerms', terms });
      const stateRes = await fetch(`${deps.matchEngineUrl}/internal/matches/${encodeURIComponent(matchId)}/state`, { headers });
      if (stateRes.ok) {
        const state = await stateRes.json() as Record<string, unknown>;
        push(wallet, { type: 'matchState', state: buildMatchStateView(matchId, state) });
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
      push(wallet, { type: 'lobbyState', lobby: json.lobby });
      return;
    }

    if (type === 'fetchQueueStatus') {
      const tier = String(msg.tierId ?? 'tier-low');
      const feed = String(msg.feedId ?? 'BTC/USD');
      const token = String(msg.token ?? 'USDC');
      const res = await fetch(`${deps.matchmakingUrl}/queue/status?tier=${tier}&feed=${feed}&token=${token}`);
      const json = await res.json() as { status?: unknown };
      push(wallet, { type: 'queueStatus', status: json.status });
    }
  };
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

function normalizeEnginePayload(matchId: string, payload: unknown): unknown | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const kind = String(p.type ?? '');
  if (kind === 'matchState' && p.state && typeof p.state === 'object') {
    return { type: 'matchState', state: buildMatchStateView(matchId, p.state as Record<string, unknown>) };
  }
  if (kind === 'yourTurn') {
    return {
      type: 'yourTurn',
      matchId,
      toCall: Number(p.toCall ?? 0),
      minRaiseTo: Number(p.minRaiseTo ?? 0),
      deadline: Number(p.deadline ?? Date.now() + 25_000),
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
