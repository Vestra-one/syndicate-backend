/**
 * Chain verification client (Phase 06). Matchmaking never trusts a client's claim that it
 * created/deposited; it asks settlement-chain (Phase 02, the home of `verifyCreateTx`/
 * `verifyDepositTx`) to read `finalized` on-chain state and check the resulting
 * `MatchAccount`/`SeatAccount`. Matchmaking stays zero-dependency by delegating over HTTP
 * rather than importing `@solana/web3.js`; the verification predicate lives in exactly one
 * place (settlement-chain) so it can never drift between services.
 */

/** Mirror of settlement-chain `verify.ts` `VerifyResult`. */
export type ChainVerifyResult =
  | {
      ok: true;
      matchPda: string;
      player: string;
      seatIndex: number;
      buyIn: string; // bigint serialized as string over JSON
      match?: unknown;
      seat?: unknown;
    }
  | { ok: false; reason: string };

export interface VerifyCreateInput {
  txSig: string;
  onchainMatchId: string;
  wallet: string;
  seatIndex?: number;
}

export interface VerifyDepositInput {
  txSig: string;
  onchainMatchId: string;
  wallet: string;
  seatIndex?: number;
}

export interface ChainVerifier {
  verifyCreate(input: VerifyCreateInput): Promise<ChainVerifyResult>;
  verifyDeposit(input: VerifyDepositInput): Promise<ChainVerifyResult>;
}

/**
 * HTTP-backed verifier hitting settlement-chain's `/internal/solana/verify-{create,deposit}`.
 * The allowlist (`config_hash` set) is enforced inside settlement-chain, so a non-allowlisted
 * match comes back `{ ok: false, reason: 'config_hash is not allowlisted' }`.
 */
export function createChainVerifier(baseUrl: string, authToken?: string): ChainVerifier {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  async function call(path: string, input: VerifyCreateInput | VerifyDepositInput): Promise<ChainVerifyResult> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, reason: `chain verify failed (${res.status}): ${detail}` };
    }
    return (await res.json()) as ChainVerifyResult;
  }

  return {
    verifyCreate: (input) => call('/internal/solana/verify-create', input),
    verifyDeposit: (input) => call('/internal/solana/verify-deposit', input),
  };
}
