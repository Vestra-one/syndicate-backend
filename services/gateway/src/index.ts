/**
 * @syndicate/gateway — edge auth + geofencing (`05 §2, §3`, `08 OQ18`).
 *
 * Wallet auth is nonce → client signs → verify → session. Signature verification is
 * behind an injected `SignatureVerifier` (real impl = ed25519 for Solana) so the logic
 * is testable offline and the crypto provider is swappable. WebSocket transport and
 * fan-out wrap this; the gateway never decides game outcomes (`06 §4, §9, §10`).
 */

export interface SignatureVerifier {
  /** True iff `signature` is a valid signature of `message` by `wallet`. */
  verify(wallet: string, message: string, signature: string): boolean;
}

export interface Nonce {
  wallet: string;
  nonce: string;
  expiresAt: number;
}

export interface Session {
  wallet: string;
  expiresAt: number;
}

export type AuthResult = { ok: true; session: Session } | { ok: false; reason: string };

/** Issue a login nonce for a wallet. `rng` injects randomness for determinism in tests. */
export function issueNonce(wallet: string, now: number, rng: () => string, ttlSec = 120): Nonce {
  return { wallet, nonce: rng(), expiresAt: now + ttlSec * 1000 };
}

/** Verify a signed nonce and mint a session. The wallet becomes the match identity. */
export function verifyAuth(
  n: Nonce,
  wallet: string,
  signature: string,
  now: number,
  verifier: SignatureVerifier,
  sessionTtlSec = 3600,
): AuthResult {
  if (now > n.expiresAt) return { ok: false, reason: 'nonce expired' };
  if (wallet !== n.wallet) return { ok: false, reason: 'wallet mismatch' };
  if (!verifier.verify(wallet, n.nonce, signature)) return { ok: false, reason: 'bad signature' };
  return { ok: true, session: { wallet, expiresAt: now + sessionTtlSec * 1000 } };
}

export function sessionValid(s: Session, now: number): boolean {
  return now <= s.expiresAt;
}

/** Geofence: block connections from restricted jurisdictions at entry (`08 OQ18`). */
export function isGeoAllowed(countryCode: string, blocklist: string[]): boolean {
  const cc = countryCode.toUpperCase();
  return !blocklist.map((b) => b.toUpperCase()).includes(cc);
}
