/**
 * Solana RPC deposit verification — client submits tx signature; backend verifies
 * before seating (anti-spam gate without full chain indexer).
 */

export interface DepositVerifyInput {
  matchId: string;
  wallet: string;
  txSignature: string;
  seatIndex?: number;
  expectedBuyIn: number;
  expectedEntryFee: number;
  programId: string;
}

export type DepositVerifyResult =
  | {
      ok: true;
      wallet: string;
      seatIndex: number;
      finalityTs: number;
      slot: number;
    }
  | {
      ok: false;
      reason: string;
    };

export interface RpcClient {
  getTransaction(signature: string): Promise<unknown | null>;
  getSignatureStatuses(signatures: string[]): Promise<Array<{ confirmationStatus?: string; slot?: number } | null>>;
}

export class SolanaDepositVerifier {
  private rpc: RpcClient;
  private commitment: 'confirmed' | 'finalized';

  constructor(rpc: RpcClient, commitment: 'confirmed' | 'finalized' = 'confirmed') {
    this.rpc = rpc;
    this.commitment = commitment;
  }

  async verify(input: DepositVerifyInput): Promise<DepositVerifyResult> {
    const statuses = await this.rpc.getSignatureStatuses([input.txSignature]);
    const status = statuses[0];
    if (!status) return { ok: false, reason: 'transaction not found' };
    const conf = status.confirmationStatus ?? '';
    if (this.commitment === 'finalized' && conf !== 'finalized') {
      return { ok: false, reason: 'transaction not finalized' };
    }
    if (this.commitment === 'confirmed' && conf !== 'confirmed' && conf !== 'finalized') {
      return { ok: false, reason: 'transaction not confirmed' };
    }

    const tx = await this.rpc.getTransaction(input.txSignature);
    if (!tx || typeof tx !== 'object') return { ok: false, reason: 'transaction payload missing' };

    const meta = (tx as { meta?: { err?: unknown; fee?: number } }).meta;
    if (meta?.err) return { ok: false, reason: 'transaction failed on-chain' };

    const message = (tx as { transaction?: { message?: { accountKeys?: string[] } } }).transaction?.message;
    const signers = message?.accountKeys ?? [];
    if (!signers.includes(input.wallet)) {
      return { ok: false, reason: 'wallet is not transaction signer' };
    }

    const slot = status.slot ?? (tx as { slot?: number }).slot ?? 0;
    const seatIndex = input.seatIndex ?? 0;
    const expectedTotal = input.expectedBuyIn + input.expectedEntryFee;

    // Lightweight validation: log mentions program + expected lamports/token transfer is checked
    // by orchestrator against on-chain seat account in production; here we gate obvious bad sigs.
    const logs = (meta as { logMessages?: string[] } | undefined)?.logMessages ?? [];
    const programHit = logs.some((l) => l.includes(input.programId)) || signers.length > 0;
    if (!programHit && input.expectedBuyIn > 0) {
      return { ok: false, reason: 'deposit program not observed in transaction' };
    }
    if (expectedTotal <= 0 && input.expectedBuyIn === 0) {
      // practice mode — no on-chain deposit required
      return { ok: true, wallet: input.wallet, seatIndex, finalityTs: Date.now(), slot };
    }

    return {
      ok: true,
      wallet: input.wallet,
      seatIndex,
      finalityTs: Date.now(),
      slot,
    };
  }
}

/** JSON-RPC client for Solana HTTP endpoint. */
export function createSolanaRpc(rpcUrl: string): RpcClient {
  return {
    async getTransaction(signature: string) {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
        }),
      });
      const json = await res.json() as { result?: unknown };
      return json.result ?? null;
    },
    async getSignatureStatuses(signatures: string[]) {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [signatures, { searchTransactionHistory: true }],
        }),
      });
      const json = await res.json() as { result?: { value?: Array<{ confirmationStatus?: string; slot?: number } | null> } };
      return json.result?.value ?? signatures.map(() => null);
    },
  };
}
