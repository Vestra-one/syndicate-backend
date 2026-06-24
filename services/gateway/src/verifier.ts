/**
 * Real Solana ed25519 signature verifier (`05 §3`). Solana wallets sign with ed25519
 * and the wallet address is the base58-encoded 32-byte public key. Verification uses
 * Node's built-in `crypto` (no external deps) — this is the production `SignatureVerifier`
 * the gateway injects; tests prove it against self-generated keypairs.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { SignatureVerifier } from './index.ts';

const BS58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a base58 (Bitcoin/Solana alphabet) string to bytes. */
export function bs58decode(s: string): Uint8Array {
  let bytes: number[] = [0];
  for (const ch of s) {
    const value = BS58.indexOf(ch);
    if (value === -1) throw new Error('invalid base58 char');
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // leading '1's are leading zero bytes
  for (let k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/** Encode bytes to base58 (used in tests to derive a wallet from a generated key). */
export function bs58encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += BS58[digits[i]];
  return out;
}

/** Wrap a raw 32-byte ed25519 public key in SPKI DER so node:crypto can use it. */
function ed25519PublicKey(raw: Uint8Array) {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex'); // ed25519 SPKI prefix
  const der = Buffer.concat([prefix, Buffer.from(raw)]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export class Ed25519Verifier implements SignatureVerifier {
  /**
   * @param wallet  base58 Solana address (= ed25519 public key)
   * @param message the signed message (the auth nonce), utf-8
   * @param signature base64-encoded ed25519 signature
   */
  verify(wallet: string, message: string, signature: string): boolean {
    try {
      const raw = bs58decode(wallet);
      if (raw.length !== 32) return false;
      const pub = ed25519PublicKey(raw);
      const sig = Buffer.from(signature, 'base64');
      return cryptoVerify(null, Buffer.from(message, 'utf8'), pub, sig);
    } catch {
      return false;
    }
  }
}
