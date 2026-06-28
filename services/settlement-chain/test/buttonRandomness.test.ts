import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  deriveButton,
  generateButtonSeed,
  isZeroSeed,
  parseOptionalProofHex,
  parseOptionalSeedHex,
} from '../src/buttonRandomness.ts';

test('generateButtonSeed produces non-zero 32-byte seed and audit hash', () => {
  const { vrfSeed, vrfProofHash } = generateButtonSeed(42n, 'MatchPda111');
  assert.equal(vrfSeed.length, 32);
  assert.equal(vrfProofHash.length, 32);
  assert.ok(!isZeroSeed(vrfSeed));
  const expected = createHash('sha256')
    .update(vrfSeed)
    .update('MatchPda111')
    .update('42')
    .digest();
  assert.equal(vrfProofHash.toString('hex'), expected.toString('hex'));
});

test('generateButtonSeed is not derived from match id alone', () => {
  const a = generateButtonSeed(99n, 'samePda');
  const b = generateButtonSeed(99n, 'samePda');
  assert.notEqual(a.vrfSeed.toString('hex'), b.vrfSeed.toString('hex'));
});

test('deriveButton matches on-chain formula seed_u64 mod player_count', () => {
  const seed = Buffer.alloc(32);
  seed.writeBigUInt64LE(10n);
  assert.equal(deriveButton(seed, 3), 1);
  assert.equal(deriveButton(seed, 5), 0);
});

test('parseOptionalSeedHex rejects zero seed path when omitted vs provided', () => {
  assert.equal(parseOptionalSeedHex(undefined), undefined);
  assert.throws(() => parseOptionalSeedHex('ab'), /32 bytes/);
  const seed = parseOptionalSeedHex('01'.repeat(32));
  assert.ok(seed);
  assert.equal(parseOptionalProofHex('02'.repeat(32))?.length, 32);
});

test('isZeroSeed detects all-zero buffer', () => {
  assert.ok(isZeroSeed(Buffer.alloc(32, 0)));
  assert.ok(!isZeroSeed(Buffer.from('01'.repeat(32), 'hex')));
});
