/**
 * RPC verification of client-reported create/deposit txhashes, and authoritative seat-PDA
 * enumeration — the core of the no-indexer model (plan_v2 / V1_COMPLETION_CHECKLIST §2).
 *
 * The backend never trusts the client's claim: it reads `finalized` on-chain state and checks
 * the resulting `MatchAccount`/`SeatAccount`. This is the authoritative account-state check;
 * matchmaking's tx-status gate (`deposit-verify.ts`) is complementary and delegates here.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  decodeMatchAccount,
  decodeSeatAccount,
  SEAT_ACCOUNT_SIZE,
  type DecodedMatch,
  type DecodedSeat,
} from './matchAccount.ts';
import { deriveMatchPdas, deriveSeatPda } from './custody.ts';

/** Normalized transaction view (commitment-checked + parsed by the RPC impl). */
export interface TxView {
  err: unknown;
  signers: string[];
  slot: number;
}

export interface VerifyRpc {
  /** Fetch a tx at `finalized`; returns null if not found / not finalized. */
  getTx(sig: string): Promise<TxView | null>;
  /** Raw account data at `finalized`, or null if the account does not exist. */
  getAccountData(pubkey: PublicKey): Promise<Buffer | null>;
  /** All `SeatAccount`s for a match (getProgramAccounts by size + match_key memcmp). */
  getMatchSeatAccounts(matchPda: PublicKey): Promise<{ pubkey: PublicKey; data: Buffer }[]>;
}

export type VerifyResult =
  | { ok: true; matchPda: string; player: string; seatIndex: number; buyIn: bigint; match: DecodedMatch; seat: DecodedSeat }
  | { ok: false; reason: string };

export interface VerifyDepositInput {
  sig: string;
  onchainMatchId: bigint;
  expectedPlayer: string;
  /** If provided, the seat must occupy exactly this index. */
  expectedSeatIndex?: number;
  /** Allowlisted config hashes (config `templateAllowlist()`); when set, enforced. */
  allowlist?: Set<string>;
}

/**
 * Verify a deposit (or create_and_deposit) txhash: the tx finalized without error and the
 * reporter signed it; the match is `Filling` with an allowlisted config; the seat exists for
 * the player with the expected index and `deposit == buy_in`.
 */
export async function verifyDepositTx(
  rpc: VerifyRpc,
  programId: PublicKey,
  input: VerifyDepositInput,
): Promise<VerifyResult> {
  const tx = await rpc.getTx(input.sig);
  if (!tx) return reject('transaction not found or not finalized');
  if (tx.err) return reject('transaction failed on-chain');
  if (!tx.signers.includes(input.expectedPlayer)) return reject('reporter is not a transaction signer');

  const pdas = deriveMatchPdas(programId, input.onchainMatchId);
  const matchData = await rpc.getAccountData(pdas.match);
  if (!matchData) return reject('match account not found');
  const match = decodeMatchAccount(matchData);
  if (match.status !== 'Filling') return reject(`match status is ${match.status}, expected Filling`);
  if (input.allowlist && !input.allowlist.has(match.configHash)) {
    return reject('config_hash is not allowlisted');
  }

  const seatPda = deriveSeatPda(programId, pdas.match, new PublicKey(input.expectedPlayer));
  const seatData = await rpc.getAccountData(seatPda);
  if (!seatData) return reject('seat account not found');
  const seat = decodeSeatAccount(seatData);
  if (seat.player !== input.expectedPlayer) return reject('seat player mismatch');
  if (input.expectedSeatIndex !== undefined && seat.seatIndex !== input.expectedSeatIndex) {
    return reject(`seat_index mismatch: on-chain ${seat.seatIndex} != expected ${input.expectedSeatIndex}`);
  }
  if (seat.deposit !== match.buyIn) return reject('seat deposit != match buy_in');

  return {
    ok: true,
    matchPda: pdas.match.toBase58(),
    player: input.expectedPlayer,
    seatIndex: seat.seatIndex,
    buyIn: match.buyIn,
    match,
    seat,
  };
}

export interface VerifyCreateInput {
  sig: string;
  onchainMatchId: bigint;
  /** The host wallet (creator/authority), seated by create_and_deposit. */
  expectedAuthority: string;
  expectedSeatIndex?: number;
  allowlist?: Set<string>;
}

/**
 * Verify a host-reported create txhash. For the player-created `create_and_deposit` path the
 * creator is seated, so this reuses the deposit verification against the creator's seat.
 */
export async function verifyCreateTx(
  rpc: VerifyRpc,
  programId: PublicKey,
  input: VerifyCreateInput,
): Promise<VerifyResult> {
  return verifyDepositTx(rpc, programId, {
    sig: input.sig,
    onchainMatchId: input.onchainMatchId,
    expectedPlayer: input.expectedAuthority,
    expectedSeatIndex: input.expectedSeatIndex,
    allowlist: input.allowlist,
  });
}

export interface EnumeratedSeat {
  pubkey: string;
  player: string;
  seatIndex: number;
  commitmentSet: boolean;
}

/**
 * Authoritative seat set for a match, read from chain (NOT the registry). This is what
 * `begin_live` must pass as remaining_accounts — `remaining_accounts.len() == player_count`
 * always holds even for a deposit the backend never heard about. Sorted by seat_index.
 */
export async function enumerateSeatPdas(
  rpc: VerifyRpc,
  matchPda: PublicKey,
): Promise<EnumeratedSeat[]> {
  const accounts = await rpc.getMatchSeatAccounts(matchPda);
  return accounts
    .map(({ pubkey, data }) => {
      const seat = decodeSeatAccount(data);
      return {
        pubkey: pubkey.toBase58(),
        player: seat.player,
        seatIndex: seat.seatIndex,
        commitmentSet: seat.commitmentSet,
      };
    })
    .sort((a, b) => a.seatIndex - b.seatIndex);
}

/** Connection-backed `VerifyRpc` reading everything at `finalized`. */
export function connectionVerifyRpc(connection: Connection, programId: PublicKey): VerifyRpc {
  return {
    async getTx(sig: string): Promise<TxView | null> {
      const res = await connection.getParsedTransaction(sig, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      if (!res) return null;
      const keys = res.transaction.message.accountKeys ?? [];
      const signers = keys
        .filter((k: { signer?: boolean }) => k.signer)
        .map((k: { pubkey: PublicKey }) => k.pubkey.toBase58());
      return { err: res.meta?.err ?? null, signers, slot: res.slot };
    },
    async getAccountData(pubkey: PublicKey): Promise<Buffer | null> {
      const info = await connection.getAccountInfo(pubkey, 'finalized');
      return info?.data ?? null;
    },
    async getMatchSeatAccounts(matchPda: PublicKey) {
      const accounts = await connection.getProgramAccounts(programId, {
        commitment: 'finalized',
        filters: [
          { dataSize: SEAT_ACCOUNT_SIZE },
          { memcmp: { offset: 8, bytes: matchPda.toBase58() } },
        ],
      });
      return accounts.map((a) => ({ pubkey: a.pubkey, data: a.account.data as Buffer }));
    },
  };
}

function reject(reason: string): VerifyResult {
  return { ok: false, reason };
}
