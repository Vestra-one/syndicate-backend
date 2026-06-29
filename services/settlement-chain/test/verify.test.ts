import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  decodeMatchAccount,
  decodeSeatAccount,
  MATCH_ACCOUNT_SIZE,
  SEAT_ACCOUNT_SIZE,
} from '../src/matchAccount.ts';
import {
  verifyDepositTx,
  enumerateSeatPdas,
  type VerifyRpc,
  type TxView,
} from '../src/verify.ts';
import { deriveMatchPdas, deriveSeatPda } from '../src/custody.ts';

const PROGRAM = new PublicKey('FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS');
const CONFIG_HASH = 'ab'.repeat(32); // 64-char hex, no 0x (config templateAllowlist() format)

interface MatchFixture {
  buyIn?: bigint;
  status?: number; // 0=Filling
  configHash?: string;
  playerCount?: number;
  sealedCount?: number;
}

function matchBuf(opts: MatchFixture = {}): Buffer {
  const b = Buffer.alloc(MATCH_ACCOUNT_SIZE);
  PublicKey.unique().toBuffer().copy(b, 8); // authority
  PublicKey.unique().toBuffer().copy(b, 40); // mint
  PublicKey.unique().toBuffer().copy(b, 72); // vault
  b.writeBigUInt64LE(42n, 104); // match_id
  b.writeBigUInt64LE(opts.buyIn ?? 10_000_000n, 112); // buy_in
  b.writeUInt8(opts.status ?? 0, 120); // status (Filling)
  Buffer.from(opts.configHash ?? CONFIG_HASH, 'hex').copy(b, 121); // config_hash
  Buffer.alloc(20, 0xaa).copy(b, 153); // price_token
  b.writeUInt8(opts.playerCount ?? 1, 315);
  b.writeUInt8(opts.sealedCount ?? 0, 316);
  return b;
}

interface SeatFixture {
  match?: PublicKey;
  player?: PublicKey;
  seatIndex?: number;
  deposit?: bigint;
  commitmentSet?: boolean;
}

function seatBuf(opts: SeatFixture = {}): Buffer {
  const b = Buffer.alloc(SEAT_ACCOUNT_SIZE);
  (opts.match ?? PublicKey.unique()).toBuffer().copy(b, 8);
  (opts.player ?? PublicKey.unique()).toBuffer().copy(b, 40);
  b.writeUInt16LE(opts.seatIndex ?? 0, 72);
  b.writeBigUInt64LE(opts.deposit ?? 10_000_000n, 74); // deposit
  b.writeBigUInt64LE(0n, 82); // entry_fee_paid
  b.writeUInt8(opts.commitmentSet ? 1 : 0, 148);
  return b;
}

test('decodeMatchAccount reads core fields at state.rs offsets', () => {
  const m = decodeMatchAccount(matchBuf({ buyIn: 7_000_000n, playerCount: 3, sealedCount: 2 }));
  assert.equal(m.matchId, 42n);
  assert.equal(m.buyIn, 7_000_000n);
  assert.equal(m.status, 'Filling');
  assert.equal(m.configHash, CONFIG_HASH);
  assert.equal(m.priceToken, 'aa'.repeat(20));
  assert.equal(m.playerCount, 3);
  assert.equal(m.sealedCount, 2);
});

test('decodeMatchAccount maps status + void_kind enums', () => {
  assert.equal(decodeMatchAccount(matchBuf({ status: 2 })).status, 'Live');
  assert.equal(decodeMatchAccount(matchBuf({ status: 4 })).status, 'Void');
});

test('decodeSeatAccount reads core fields', () => {
  const player = PublicKey.unique();
  const match = PublicKey.unique();
  const s = decodeSeatAccount(seatBuf({ match, player, seatIndex: 4, deposit: 5_000_000n, commitmentSet: true }));
  assert.equal(s.player, player.toBase58());
  assert.equal(s.matchKey, match.toBase58());
  assert.equal(s.seatIndex, 4);
  assert.equal(s.deposit, 5_000_000n);
  assert.equal(s.commitmentSet, true);
});

// --- verifyDepositTx with a mock RPC ---

const ONCHAIN_ID = 42n;
const PLAYER = PublicKey.unique();
const SIG = 'sig-finalized';
const ALLOW = new Set([CONFIG_HASH]);

function mockRpc(over: Partial<{
  tx: TxView | null;
  matchData: Buffer | null;
  seatData: Buffer | null;
  seats: { pubkey: PublicKey; data: Buffer }[];
}> = {}): VerifyRpc {
  const pdas = deriveMatchPdas(PROGRAM, ONCHAIN_ID);
  const seatPda = deriveSeatPda(PROGRAM, pdas.match, PLAYER);
  const tx: TxView | null = over.tx !== undefined ? over.tx : { err: null, signers: [PLAYER.toBase58()], slot: 100 };
  const matchData = over.matchData !== undefined ? over.matchData : matchBuf();
  const seatData = over.seatData !== undefined ? over.seatData : seatBuf({ match: pdas.match, player: PLAYER, seatIndex: 0 });
  return {
    async getTx() { return tx; },
    async getAccountData(pubkey: PublicKey) {
      if (pubkey.equals(pdas.match)) return matchData;
      if (pubkey.equals(seatPda)) return seatData;
      return null;
    },
    async getMatchSeatAccounts() { return over.seats ?? []; },
  };
}

function input(over: Record<string, unknown> = {}) {
  return { sig: SIG, onchainMatchId: ONCHAIN_ID, expectedPlayer: PLAYER.toBase58(), allowlist: ALLOW, ...over };
}

test('verifyDepositTx accepts a finalized, signed, allowlisted, seated deposit', async () => {
  const r = await verifyDepositTx(mockRpc(), PROGRAM, input({ expectedSeatIndex: 0 }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.player, PLAYER.toBase58());
    assert.equal(r.seatIndex, 0);
    assert.equal(r.buyIn, 10_000_000n);
  }
});

test('verifyDepositTx rejects: tx not found / not finalized', async () => {
  const r = await verifyDepositTx(mockRpc({ tx: null }), PROGRAM, input());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not finalized|not found/);
});

test('verifyDepositTx rejects: tx failed on-chain', async () => {
  const r = await verifyDepositTx(mockRpc({ tx: { err: { InstructionError: [0, 'Custom'] }, signers: [PLAYER.toBase58()], slot: 1 } }), PROGRAM, input());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /failed on-chain/);
});

test('verifyDepositTx rejects: reporter not a signer', async () => {
  const r = await verifyDepositTx(mockRpc({ tx: { err: null, signers: [PublicKey.unique().toBase58()], slot: 1 } }), PROGRAM, input());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not a transaction signer/);
});

test('verifyDepositTx rejects: match not Filling', async () => {
  const r = await verifyDepositTx(mockRpc({ matchData: matchBuf({ status: 2 }) }), PROGRAM, input());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /expected Filling/);
});

test('verifyDepositTx rejects: config_hash not allowlisted', async () => {
  const r = await verifyDepositTx(mockRpc({ matchData: matchBuf({ configHash: 'cd'.repeat(32) }) }), PROGRAM, input());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not allowlisted/);
});

test('verifyDepositTx rejects: seat missing', async () => {
  const r = await verifyDepositTx(mockRpc({ seatData: null }), PROGRAM, input());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /seat account not found/);
});

test('verifyDepositTx rejects: seat_index mismatch', async () => {
  const pdas = deriveMatchPdas(PROGRAM, ONCHAIN_ID);
  const r = await verifyDepositTx(
    mockRpc({ seatData: seatBuf({ match: pdas.match, player: PLAYER, seatIndex: 2 }) }),
    PROGRAM,
    input({ expectedSeatIndex: 0 }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /seat_index mismatch/);
});

test('verifyDepositTx rejects: deposit != buy_in', async () => {
  const pdas = deriveMatchPdas(PROGRAM, ONCHAIN_ID);
  const r = await verifyDepositTx(
    mockRpc({ seatData: seatBuf({ match: pdas.match, player: PLAYER, deposit: 1n }) }),
    PROGRAM,
    input(),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /deposit != match buy_in/);
});

test('enumerateSeatPdas returns seats sorted by seat_index', async () => {
  const match = PublicKey.unique();
  const seats = [
    { pubkey: PublicKey.unique(), data: seatBuf({ match, seatIndex: 2 }) },
    { pubkey: PublicKey.unique(), data: seatBuf({ match, seatIndex: 0 }) },
    { pubkey: PublicKey.unique(), data: seatBuf({ match, seatIndex: 1, commitmentSet: true }) },
  ];
  const rpc: VerifyRpc = {
    async getTx() { return null; },
    async getAccountData() { return null; },
    async getMatchSeatAccounts() { return seats; },
  };
  const out = await enumerateSeatPdas(rpc, match);
  assert.deepEqual(out.map((s) => s.seatIndex), [0, 1, 2]);
  assert.equal(out[1].commitmentSet, true);
});
