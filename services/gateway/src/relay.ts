/**
 * Gateway protocol relay — forwards authenticated gameplay messages to match-engine.
 */

export interface RelayDeps {
  matchEngineUrl: string;
  matchmakingUrl: string;
  actionFeedUrl: string;
  authToken?: string;
}

export type RelayPush = (wallet: string, msg: unknown) => void;

export function createRelayHandler(deps: RelayDeps, push: RelayPush) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (deps.authToken) headers.authorization = `Bearer ${deps.authToken}`;

  return async function handleMessage(wallet: string, msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? '');

    if (type === 'ping') {
      push(wallet, { type: 'pong' });
      return;
    }

    if (type === 'subscribe') {
      const matchId = String(msg.matchId ?? '');
      push(wallet, { type: 'event', event: { kind: 'subscribed', matchId } });
      return;
    }

    if (type === 'sealPrediction') {
      const matchId = String(msg.matchId ?? '');
      await fetch(`${deps.matchEngineUrl}/internal/matches/${encodeURIComponent(matchId)}/seal`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ wallet, ciphertext: msg.ciphertext }),
      });
      push(wallet, { type: 'matchState', state: { matchId, phase: 'SEALING' } });
      return;
    }

    if (type === 'act') {
      const matchId = String(msg.matchId ?? '');
      await fetch(`${deps.matchEngineUrl}/internal/matches/${encodeURIComponent(matchId)}/actions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ wallet, action: msg.action, signature: msg.signature }),
      });
      return;
    }

    if (type === 'setDefault') {
      const matchId = String(msg.matchId ?? '');
      await fetch(`${deps.matchEngineUrl}/internal/matches/${encodeURIComponent(matchId)}/actions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ wallet, default: msg.default, signature: 'default-policy' }),
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

export async function fetchActiveMatchesForWallet(deps: RelayDeps, wallet: string): Promise<string[]> {
  try {
    const res = await fetch(`${deps.actionFeedUrl}/profiles/${encodeURIComponent(wallet)}`);
    if (!res.ok) return [];
    return [];
  } catch {
    return [];
  }
}
