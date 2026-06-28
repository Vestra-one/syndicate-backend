import { bindConfig, getTierForFeed } from '../../config/src/index.ts';
import type { FormationRecord } from './formation.ts';
import type { StartPolicyResult } from './start-policy.ts';

export interface OrchestratorClientOptions {
  /** When true, bootstrap returns synthetic ids if orchestrator is down (local dev only). */
  stub?: boolean;
}

export interface StartContext {
  onchainMatchId: string;
  matchPda?: string;
  tierId: string;
  feedId: string;
  players: Array<{ seatIndex: number; stack: number; sealSeq: number; wallet: string }>;
  smallBlind: number;
  bigBlind: number;
  roundCount: number;
  actionTimeoutMs: number;
}

function stubEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.SYNDICATE_ORCHESTRATOR_STUB === '1';
}

function formationPayload(input: FormationRecord): Record<string, unknown> {
  const tier = getTierForFeed(input.tierId, input.feedId);
  const bound = tier ? bindConfig(tier.config) : null;
  return {
    matchId: input.matchId,
    tierId: input.tierId,
    feedId: input.feedId,
    token: input.token,
    maxPlayers: input.maxPlayers,
    minPlayers: input.minPlayers,
    mode: input.mode,
    practiceMode: tier?.practiceMode ?? false,
    buyIn: tier?.config.buyIn,
    entryFee: tier?.config.entryFee,
    rakeBps: tier?.config.rakeBps,
    rakeCap: tier?.config.rakeCap,
    configHashHex: bound?.hash,
  };
}

export function createOrchestratorClient(
  baseUrl: string,
  authToken?: string,
  opts?: OrchestratorClientOptions,
): import('./formation.ts').OrchestratorClient {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const stub = stubEnabled(opts?.stub);

  return {
    async bootstrapFormation(input: FormationRecord) {
      const res = await fetch(`${baseUrl}/internal/formations/bootstrap`, {
        method: 'POST',
        headers,
        body: JSON.stringify(formationPayload(input)),
      });
      if (!res.ok) {
        if (stub) {
          const id = hashMatchId(input.matchId);
          return { matchId: input.matchId, onchainMatchId: id.toString() };
        }
        const detail = await res.text();
        throw new Error(`orchestrator bootstrap failed (${res.status}): ${detail}`);
      }
      const out = await res.json() as {
        matchId?: string;
        match_id?: string;
        onchainMatchId?: string | number;
        onchain_match_id?: string | number;
        matchPda?: string;
        match_pda?: string;
      };
      const onchainRaw = out.onchainMatchId ?? out.onchain_match_id ?? hashMatchId(input.matchId).toString();
      return {
        matchId: out.matchId ?? out.match_id ?? input.matchId,
        onchainMatchId: String(onchainRaw),
        matchPda: out.matchPda ?? out.match_pda,
      };
    },
    async triggerStartPolicy(matchId: string, result: StartPolicyResult, ctx: StartContext) {
      const res = await fetch(`${baseUrl}/internal/start-policy`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          matchId,
          result,
          onchainMatchId: ctx.onchainMatchId,
          players: ctx.players,
          smallBlind: ctx.smallBlind,
          bigBlind: ctx.bigBlind,
          roundCount: ctx.roundCount,
          actionTimeoutMs: ctx.actionTimeoutMs,
        }),
      });
      if (!res.ok) {
        if (stub) return;
        const detail = await res.text();
        throw new Error(`orchestrator start-policy failed (${res.status}): ${detail}`);
      }
    },
  };
}

/** Mirrors orchestrator / settlement-chain `hashMatchId` (wrapping u64). */
export function hashMatchId(matchId: string): bigint {
  let hash = 0n;
  for (let i = 0; i < matchId.length; i += 1) {
    hash = (hash * 31n + BigInt(matchId.charCodeAt(i))) & ((1n << 64n) - 1n);
  }
  return hash;
}

export function syntheticOnchainId(matchId: string): string {
  return hashMatchId(matchId).toString();
}
