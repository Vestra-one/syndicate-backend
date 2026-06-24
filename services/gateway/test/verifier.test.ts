import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { Ed25519Verifier, bs58encode, bs58decode } from '../src/verifier.ts';

test('base58 round-trips', () => {
  const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
  assert.deepEqual(bs58decode(bs58encode(bytes)), bytes);
});

test('real ed25519: a genuine Solana-style signature verifies, a tampered one does not', () => {
  // Generate an ed25519 keypair; derive the wallet (base58 of the raw 32-byte pubkey).
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = Uint8Array.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(12); // strip SPKI prefix
  const wallet = bs58encode(rawPub);

  const message = 'syndicate-login-nonce-abc123';
  const signature = cryptoSign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');

  const v = new Ed25519Verifier();
  assert.ok(v.verify(wallet, message, signature), 'valid signature must verify');
  assert.ok(!v.verify(wallet, 'tampered-message', signature), 'wrong message must fail');
  assert.ok(!v.verify(wallet, message, Buffer.from('garbage').toString('base64')), 'wrong signature must fail');
});
