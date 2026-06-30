import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  anchorDiscriminator,
} from '../src/actionLog.ts';
import {
  buildCreateMatchInstruction,
  buildLockInstruction,
  buildBeginLiveInstruction,
  buildDepositInstruction,
  buildCreateAndDepositInstruction,
  buildRegisterPredictionCommitmentInstruction,
  buildVoidBeforeStartInstruction,
  buildVoidLiveAfterDeadlineInstruction,
  deriveMatchPdas,
  deriveSeatPda,
  deriveSeatIndexPda,
  encodeCreateParams,
  buildCreateMatchPreview,
  hashMatchId,
} from '../src/custody.ts';
import { syntheticOnchainId } from '../../matchmaking/src/orchestrator-client.ts';

const PROGRAM = new PublicKey('FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS');

function cfgFor(programId: PublicKey) {
  return {
    primaryRpcUrl: 'http://127.0.0.1:8899',
    programId: programId.toBase58(),
    chipsTokenMint: PublicKey.default.toBase58(),
    signerKeypairPath: '/dev/null',
    confirmationTimeoutMs: 30_000,
  };
}

test('create match params encode expected byte length', () => {
  const programId = new PublicKey('FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS');
  const onchainMatchId = 42n;
  const params = encodeCreateParams(
    {
      matchId: 'm1',
      onchainMatchId,
      maxPlayers: 5,
      minPlayers: 2,
      tierId: 'tier-low',
      feedId: 'BTC/USD',
      buyIn: 10_000_000,
      rakeBps: 300,
      nonsealPenaltyBps: 2500,
      totalBettingDurationSec: 600,
      sealWindowSec: 20,
      beginLiveWindowSec: 5,
      fillWindowSec: 300,
    },
    onchainMatchId,
    {
      primaryRpcUrl: 'http://127.0.0.1:8899',
      programId: programId.toBase58(),
      chipsTokenMint: PublicKey.default.toBase58(),
      signerKeypairPath: '/dev/null',
      confirmationTimeoutMs: 30_000,
    },
  );
  // CreateParams (plan_v2 §A): match_id,buy_in,entry_fee,rake_bps(u32),rake_cap,
  // nonseal_penalty_bps(u32),min(u8),max(u8),config_hash[32],price_token[20],
  // total_betting_duration,seal_window,begin_live_window,fill_window_sec,
  // max_conf,exponent(i32).
  assert.equal(
    params.length,
    8 + 8 + 8 + 4 + 8 + 4 + 1 + 1 + 32 + 20 + 8 + 8 + 8 + 8 + 8 + 4,
  );
});

test('create match instruction includes anchor discriminator', () => {
  const programId = new PublicKey('FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS');
  const onchainMatchId = 7n;
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const params = encodeCreateParams(
    { matchId: 'm7', onchainMatchId, maxPlayers: 2, feedId: 'BTC/USD', buyIn: 1_000_000 },
    onchainMatchId,
    {
      primaryRpcUrl: 'http://127.0.0.1:8899',
      programId: programId.toBase58(),
      chipsTokenMint: PublicKey.default.toBase58(),
      signerKeypairPath: '/dev/null',
      confirmationTimeoutMs: 30_000,
    },
  );
  const ix = buildCreateMatchInstruction(programId, PublicKey.default, PublicKey.default, pdas, params);
  assert.deepEqual(ix.data.subarray(0, 8), anchorDiscriminator('global:create_match'));
});

test('lock instruction uses lock discriminator', () => {
  const programId = new PublicKey('FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS');
  const pdas = deriveMatchPdas(programId, 99n);
  const ix = buildLockInstruction(programId, PublicKey.default, pdas.protocol, pdas.match);
  assert.deepEqual(ix.data, anchorDiscriminator('global:lock'));
});

test('create match preview helper returns pdas', () => {
  const out = buildCreateMatchPreview({
    matchId: 'm1',
    onchainMatchId: 42,
    maxPlayers: 5,
    tierId: 'tier-low',
    feedId: 'BTC/USD',
  });
  assert.equal(out.ok, true);
  assert.ok(out.preview.accounts.matchPda);
});

test('hashMatchId matches orchestrator stub helper', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(hashMatchId(id).toString(), syntheticOnchainId(id));
});

test('deposit instruction: discriminator, u16 seat_index arg, account order', () => {
  const pdas = deriveMatchPdas(PROGRAM, 5n);
  const player = PublicKey.unique();
  const seat = deriveSeatPda(PROGRAM, pdas.match, player);
  const seatIndexAccount = deriveSeatIndexPda(PROGRAM, pdas.match, 3);
  const playerToken = PublicKey.unique();
  const ix = buildDepositInstruction(
    PROGRAM, player, pdas.protocol, pdas.match, seat, seatIndexAccount, playerToken, pdas.vault, 3,
  );
  assert.deepEqual(ix.data.subarray(0, 8), anchorDiscriminator('global:deposit'));
  assert.equal(ix.data.length, 8 + 2);
  assert.equal(ix.data.readUInt16LE(8), 3);
  // Deposit context order: player, protocol, match, seat, seat_index, player_token, vault, token_program, system_program.
  assert.equal(ix.keys.length, 9);
  assert.equal(ix.keys[0].pubkey.toBase58(), player.toBase58());
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[3].pubkey.toBase58(), seat.toBase58());
});

test('create_and_deposit instruction: params then u16 seat_index; rent account present', () => {
  const onchainMatchId = 9n;
  const pdas = deriveMatchPdas(PROGRAM, onchainMatchId);
  const params = encodeCreateParams(
    { matchId: 'm9', onchainMatchId, maxPlayers: 5, feedId: 'BTC/USD', buyIn: 1_000_000 },
    onchainMatchId,
    cfgFor(PROGRAM),
  );
  const authority = PublicKey.unique();
  const seat = deriveSeatPda(PROGRAM, pdas.match, authority);
  const seatIndexAccount = deriveSeatIndexPda(PROGRAM, pdas.match, 0);
  const ix = buildCreateAndDepositInstruction(
    PROGRAM, authority, PublicKey.default, pdas, seat, seatIndexAccount, PublicKey.unique(), params, 0,
  );
  assert.deepEqual(ix.data.subarray(0, 8), anchorDiscriminator('global:create_and_deposit'));
  assert.equal(ix.data.length, 8 + params.length + 2);
  assert.equal(ix.data.readUInt16LE(8 + params.length), 0);
  assert.equal(ix.keys.length, 11); // incl. rent
});

test('register_prediction_commitment instruction: commitment[32] + u64 timelock', () => {
  const pdas = deriveMatchPdas(PROGRAM, 11n);
  const player = PublicKey.unique();
  const seat = deriveSeatPda(PROGRAM, pdas.match, player);
  const commitment = Buffer.alloc(32, 7);
  const ix = buildRegisterPredictionCommitmentInstruction(PROGRAM, player, pdas.match, seat, commitment, 123_456n);
  assert.deepEqual(ix.data.subarray(0, 8), anchorDiscriminator('global:register_prediction_commitment'));
  assert.equal(ix.data.length, 8 + 32 + 8);
  assert.deepEqual(ix.data.subarray(8, 40), commitment);
  assert.equal(ix.data.readBigUInt64LE(40), 123_456n);
  assert.equal(ix.keys[0].isSigner, true); // player signs
});

test('begin_live instruction carries randomness[32] and seats as writable remaining_accounts', () => {
  const pdas = deriveMatchPdas(PROGRAM, 13n);
  const seats = [PublicKey.unique(), PublicKey.unique(), PublicKey.unique()];
  const randomness = Buffer.alloc(32, 9);
  const ix = buildBeginLiveInstruction(PROGRAM, PublicKey.default, pdas.protocol, pdas.match, seats, randomness);
  assert.deepEqual(ix.data.subarray(0, 8), anchorDiscriminator('global:begin_live'));
  assert.equal(ix.data.length, 8 + 32);
  assert.deepEqual(ix.data.subarray(8), randomness);
  // authority, protocol, match, then 3 seats — all seats writable.
  assert.equal(ix.keys.length, 3 + seats.length);
  for (const k of ix.keys.slice(3)) assert.equal(k.isWritable, true);
});

test('begin_live rejects non-32-byte randomness', () => {
  const pdas = deriveMatchPdas(PROGRAM, 14n);
  assert.throws(
    () => buildBeginLiveInstruction(PROGRAM, PublicKey.default, pdas.protocol, pdas.match, [], Buffer.alloc(16)),
    /button_randomness must be 32 bytes/,
  );
});

test('permissionless void builders are match-PDA-only with correct discriminators', () => {
  const pdas = deriveMatchPdas(PROGRAM, 15n);
  const before = buildVoidBeforeStartInstruction(PROGRAM, pdas.match);
  assert.deepEqual(before.data, anchorDiscriminator('global:void_before_start'));
  assert.equal(before.keys.length, 1);
  assert.equal(before.keys[0].isWritable, true);
  assert.equal(before.keys[0].isSigner, false);
  const live = buildVoidLiveAfterDeadlineInstruction(PROGRAM, pdas.match);
  assert.deepEqual(live.data, anchorDiscriminator('global:void_live_after_deadline'));
  assert.equal(live.keys.length, 1);
});
