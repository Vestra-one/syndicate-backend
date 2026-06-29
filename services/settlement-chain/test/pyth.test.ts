import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedIdHex, redactSecrets } from '../src/pyth.ts';

const feed = `0x${'07'.repeat(32)}`;

test('normalizeFeedIdHex lowercases and 0x-prefixes 32-byte hex', () => {
  assert.equal(normalizeFeedIdHex(`0X${'AB'.repeat(32)}`), `0x${'ab'.repeat(32)}`);
  assert.equal(normalizeFeedIdHex('07'.repeat(32)), feed);
});

test('normalizeFeedIdHex rejects non-32-byte or non-hex input', () => {
  assert.throws(() => normalizeFeedIdHex('ab'), /32-byte hex/);
  assert.throws(() => normalizeFeedIdHex(123 as unknown), /must be a string/);
});

test('redaction removes secrets and keypair byte arrays', () => {
  const raw = 'token=secret-token api=pyth-secret key=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64]';
  const redacted = redactSecrets(raw, ['secret-token', 'pyth-secret']);
  assert.doesNotMatch(redacted, /secret-token|pyth-secret/);
  assert.match(redacted, /\[REDACTED_KEYPAIR\]/);
});
