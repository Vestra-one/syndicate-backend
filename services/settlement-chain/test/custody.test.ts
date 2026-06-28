import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  anchorDiscriminator,
} from '../src/actionLog.ts';
import {
  buildCreateMatchInstruction,
  buildLockInstruction,
  deriveMatchPdas,
  encodeCreateParams,
  buildCreateMatchPreview,
  hashMatchId,
} from '../src/custody.ts';
import { syntheticOnchainId } from '../../matchmaking/src/orchestrator-client.ts';

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
  assert.equal(params.length, 8 + 8 + 8 + 4 + 8 + 1 + 1 + 32 + 32 + 8 + 8 + 8 + 4);
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
  assert.equal(hashMatchId(id), syntheticOnchainId(id));
});
