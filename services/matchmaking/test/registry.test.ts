import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMatchmakingStore } from '../src/index.ts';
import { MatchmakingRuntime } from '../src/formation.ts';
import type { ChainVerifier, ChainVerifyResult } from '../src/chain-verify.ts';
import type { MatchPersistence } from '../src/persistence.ts';
import { buildTemplates } from '../../config/src/index.ts';

const TEMPLATE = buildTemplates()[0];
const CONFIG_HASH = TEMPLATE.configHash;

function recordingPersistence() {
  const matches: unknown[] = [];
  const seats: unknown[] = [];
  const port: MatchPersistence = {
    async insertMatch(row) {
      matches.push(row);
    },
    async insertMatchSeat(row) {
      seats.push(row);
    },
  };
  return { port, matches, seats };
}

/** Verifier that approves a fixed set of sigs and assigns the requested/sequential seat index. */
function fakeVerifier(approve: Set<string>): ChainVerifier {
  const ok = (matchPda: string, player: string, seatIndex: number): ChainVerifyResult => ({
    ok: true,
    matchPda,
    player,
    seatIndex,
    buyIn: '10000000', // $10 USDC — within the operator-governed buy-in range
    match: { fillDeadlineTs: '2000000000' },
  });
  return {
    async verifyCreate(input) {
      if (!approve.has(input.txSig)) return { ok: false, reason: 'not finalized' };
      return ok('PDA_' + input.onchainMatchId, input.wallet, input.seatIndex ?? 0);
    },
    async verifyDeposit(input) {
      if (!approve.has(input.txSig)) return { ok: false, reason: 'not finalized' };
      return ok('PDA_' + input.onchainMatchId, input.wallet, input.seatIndex ?? 1);
    },
  };
}

const noopOrch = { triggerStartPolicy: async () => {} };

function runtime(opts: { approve: Set<string>; persistence?: MatchPersistence; cap?: number }) {
  return new MatchmakingRuntime({
    store: new MemoryMatchmakingStore(),
    orchestrator: noopOrch,
    chainVerifier: fakeVerifier(opts.approve),
    persistence: opts.persistence,
    walletRoomCap: opts.cap ?? 3,
  });
}

test('verified create registers a room and persists match + creator seat', async () => {
  const { port, matches, seats } = recordingPersistence();
  const rt = runtime({ approve: new Set(['sig-create']), persistence: port });
  const out = await rt.createRoom({
    createTxSig: 'sig-create',
    matchPda: 'PDA1',
    onchainMatchId: '111',
    configHash: CONFIG_HASH,
    wallet: 'HOST',
    seatIndex: 0,
  });
  assert.equal(out.ok, true);
  assert.equal(matches.length, 1);
  assert.equal(seats.length, 1);
  assert.deepEqual((matches[0] as { onchainMatchId: string }).onchainMatchId, '111');
  assert.equal((matches[0] as { matchKey: string }).matchKey, '111');
  assert.equal((matches[0] as { priceFeedSymbol: string }).priceFeedSymbol, TEMPLATE.feed);
  assert.ok((matches[0] as { oracleTokenHex: string }).oracleTokenHex.startsWith('0x'));
  assert.equal((out as { matchId: string }).matchId, '111');
  assert.equal((out as { matchPda: string }).matchPda, 'PDA1');
  const rooms = await rt.listRooms({});
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].matchId, '111');
  assert.equal(rooms[0].onchainMatchId, '111');
  assert.equal(rooms[0].seated, 1);
  assert.equal(rooms[0].configHash, CONFIG_HASH);
  // Gap 3: seat identity exposed for the lobby feed.
  assert.deepEqual(rooms[0].seats, [{ seatIndex: 0, wallet: 'HOST', joinedTs: rooms[0].seats[0].joinedTs }]);
  assert.equal(typeof rooms[0].seats[0].joinedTs, 'number');
});

test('non-allowlisted config_hash is rejected before any verify/persist', async () => {
  const { port, matches } = recordingPersistence();
  const rt = runtime({ approve: new Set(['sig-create']), persistence: port });
  const out = await rt.createRoom({
    createTxSig: 'sig-create',
    matchPda: 'PDA1',
    onchainMatchId: '111',
    configHash: 'deadbeef-not-allowlisted',
    wallet: 'HOST',
  });
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /allowlist/);
  assert.equal(matches.length, 0);
});

test('unverified create txhash is rejected', async () => {
  const rt = runtime({ approve: new Set() });
  const out = await rt.createRoom({
    createTxSig: 'sig-bad',
    matchPda: 'PDA1',
    onchainMatchId: '111',
    configHash: CONFIG_HASH,
    wallet: 'HOST',
  });
  assert.equal(out.ok, false);
});

test('re-reported create txhash is idempotent (no double room/persist)', async () => {
  const { port, matches } = recordingPersistence();
  const rt = runtime({ approve: new Set(['sig-create']), persistence: port });
  const base = {
    createTxSig: 'sig-create',
    matchPda: 'PDA1',
    onchainMatchId: '111',
    configHash: CONFIG_HASH,
    wallet: 'HOST',
    seatIndex: 0,
  };
  const a = await rt.createRoom(base);
  const b = await rt.createRoom(base);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a, b);
  assert.equal(matches.length, 1); // not persisted twice
  const rooms = await rt.listRooms({});
  assert.equal(rooms.length, 1);
});

test('per-wallet active-room cap is enforced', async () => {
  const rt = runtime({ approve: new Set(['s1', 's2', 's3']), cap: 2 });
  const mk = (sig: string, pda: string, id: string) =>
    rt.createRoom({ createTxSig: sig, matchPda: pda, onchainMatchId: id, configHash: CONFIG_HASH, wallet: 'HOST', seatIndex: 0 });
  assert.equal((await mk('s1', 'PDA1', '1')).ok, true);
  assert.equal((await mk('s2', 'PDA2', '2')).ok, true);
  const third = await mk('s3', 'PDA3', '3');
  assert.equal(third.ok, false);
  assert.match((third as { reason: string }).reason, /cap/);
});

test('cap releases after void retire', async () => {
  const rt = runtime({ approve: new Set(['s1', 's2', 's3']), cap: 2 });
  const mk = (sig: string, pda: string, id: string) =>
    rt.createRoom({ createTxSig: sig, matchPda: pda, onchainMatchId: id, configHash: CONFIG_HASH, wallet: 'HOST', seatIndex: 0 });
  assert.equal((await mk('s1', 'PDA1', '1')).ok, true);
  assert.equal((await mk('s2', 'PDA2', '2')).ok, true);
  const rec = await rt.loadRoom('1');
  assert.ok(rec);
  await rt.retireLobbyRoom(rec, 'void');
  const third = await mk('s3', 'PDA3', '3');
  assert.equal(third.ok, true);
});

test('cap releases after start retire', async () => {
  const rt = runtime({ approve: new Set(['s1', 's2']), cap: 1 });
  const mk = (sig: string, pda: string, id: string) =>
    rt.createRoom({ createTxSig: sig, matchPda: pda, onchainMatchId: id, configHash: CONFIG_HASH, wallet: 'HOST', seatIndex: 0 });
  assert.equal((await mk('s1', 'PDA1', '1')).ok, true);
  const rec = await rt.loadRoom('1');
  assert.ok(rec);
  await rt.retireLobbyRoom(rec, 'started');
  const second = await mk('s2', 'PDA2', '2');
  assert.equal(second.ok, true);
});

test('failed start without retire keeps cap blocked', async () => {
  const rt = runtime({ approve: new Set(['s1', 's2', 's3']), cap: 2 });
  const mk = (sig: string, pda: string, id: string) =>
    rt.createRoom({ createTxSig: sig, matchPda: pda, onchainMatchId: id, configHash: CONFIG_HASH, wallet: 'HOST', seatIndex: 0 });
  assert.equal((await mk('s1', 'PDA1', '1')).ok, true);
  assert.equal((await mk('s2', 'PDA2', '2')).ok, true);
  const third = await mk('s3', 'PDA3', '3');
  assert.equal(third.ok, false);
  assert.match((third as { reason: string }).reason, /cap/);
});

test('expired fill deadline does not count toward cap', async () => {
  const rt = runtime({ approve: new Set(['s1', 's2']), cap: 1 });
  assert.equal(
    (await rt.createRoom({
      createTxSig: 's1',
      matchPda: 'PDA1',
      onchainMatchId: '1',
      configHash: CONFIG_HASH,
      wallet: 'HOST',
      seatIndex: 0,
    })).ok,
    true,
  );
  const rec = await rt.loadRoom('1');
  assert.ok(rec);
  rec.fillDeadlineMs = Date.now() - 1000;
  const second = await rt.createRoom({
    createTxSig: 's2',
    matchPda: 'PDA2',
    onchainMatchId: '2',
    configHash: CONFIG_HASH,
    wallet: 'HOST',
    seatIndex: 0,
  });
  assert.equal(second.ok, true);
});

test('verified deposit seats a joiner and bumps the registry count', async () => {
  const { port, seats } = recordingPersistence();
  const rt = runtime({ approve: new Set(['sig-create', 'sig-deposit']), persistence: port });
  const created = await rt.createRoom({
    createTxSig: 'sig-create',
    matchPda: 'PDA1',
    onchainMatchId: '111',
    configHash: CONFIG_HASH,
    wallet: 'HOST',
    seatIndex: 0,
  });
  assert.equal(created.ok, true);
  const dep = await rt.verifyDeposit({
    matchId: '111',
    wallet: 'JOINER',
    txSignature: 'sig-deposit',
    seatIndex: 1,
  });
  assert.equal(dep.ok, true);
  assert.equal((dep as { seat: number }).seat, 1);
  // creator seat + joiner seat persisted
  assert.equal(seats.length, 2);
  const rooms = await rt.listRooms({});
  assert.equal(rooms[0].seated, 2);
  // Gap 3: both seat occupants surface with wallet identity, ordered by seat index.
  assert.equal(rooms[0].seats.length, 2);
  assert.deepEqual(rooms[0].seats.map((s) => s.wallet).sort(), ['HOST', 'JOINER']);
  assert.deepEqual(rooms[0].seats.map((s) => s.seatIndex), [0, 1]);

  // The same identity is exposed on the single-room lobby pull (roomLobby).
  const code = (created as { roomCode: string }).roomCode;
  const lobby = (await rt.roomLobby(code, 'HOST')) as { seats: { wallet: string }[] };
  assert.equal(lobby.seats.length, 2);
});

test('deposit against a match with no reported create is rejected', async () => {
  const rt = runtime({ approve: new Set(['sig-deposit']) });
  // seed a bare table without a registry record/onchain id
  await rt['store'].saveTable({ tableId: 'PDAX', minPlayers: 2, maxPlayers: 5, seats: [] });
  const dep = await rt.verifyDeposit({ matchId: 'PDAX', wallet: 'J', txSignature: 'sig-deposit' });
  assert.equal(dep.ok, false);
});
