import type { StartPolicyResult } from './start-policy.ts';

export interface OrchestratorClientOptions {
  /** When true, swallow start-policy errors if the orchestrator is down (local dev only). */
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
  roundDurationsSec?: number[];
  observationWindowsSec?: number[];
  timeBankSec?: number;
}

function stubEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.SYNDICATE_ORCHESTRATOR_STUB === '1';
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
          roundDurationsSec: ctx.roundDurationsSec,
          observationWindowsSec: ctx.observationWindowsSec,
          timeBankSec: ctx.timeBankSec,
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
