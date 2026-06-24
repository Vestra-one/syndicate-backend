import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueNonce, verifyAuth, sessionValid, isGeoAllowed, type SignatureVerifier } from '../src/index.ts';

// Mock verifier: a signature is "valid" iff it equals `sig:<message>`.
const mock: SignatureVerifier = {
  verify: (_wallet, message, signature) => signature === `sig:${message}`,
};

test('happy path: issue nonce, sign, get session', () => {
  const n = issueNonce('walletA', 1000, () => 'NONCE123');
  const r = verifyAuth(n, 'walletA', 'sig:NONCE123', 1100, mock);
  assert.ok(r.ok);
  if (r.ok) assert.ok(sessionValid(r.session, 1200));
});

test('expired nonce is rejected', () => {
  const n = issueNonce('walletA', 1000, () => 'N', 120);
  const r = verifyAuth(n, 'walletA', 'sig:N', 1000 + 121_000, mock);
  assert.deepEqual(r, { ok: false, reason: 'nonce expired' });
});

test('wallet mismatch is rejected', () => {
  const n = issueNonce('walletA', 1000, () => 'N');
  const r = verifyAuth(n, 'walletB', 'sig:N', 1100, mock);
  assert.deepEqual(r, { ok: false, reason: 'wallet mismatch' });
});

test('bad signature is rejected', () => {
  const n = issueNonce('walletA', 1000, () => 'N');
  const r = verifyAuth(n, 'walletA', 'wrong', 1100, mock);
  assert.deepEqual(r, { ok: false, reason: 'bad signature' });
});

test('geofencing blocks restricted, allows others', () => {
  const block = ['XX', 'yy'];
  assert.equal(isGeoAllowed('US', block), true);
  assert.equal(isGeoAllowed('xx', block), false); // case-insensitive
  assert.equal(isGeoAllowed('YY', block), false);
});
