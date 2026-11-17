/**
 * Per-match session key — "one-tap play".
 *
 * Every bet, check, call and fold is a signed intent. Signing each one with the wallet means a
 * wallet popup per move, against a 25-second action timer. Instead the wallet signs ONE
 * human-readable grant per match that delegates those gameplay signatures to an ephemeral
 * ed25519 key held by this browser; the server then accepts that key for this wallet's seat
 * in this match only (`POST /v1/matches/{id}/session-key`).
 *
 * The key can make moves in one match until it expires. It cannot move funds: deposits, the
 * on-chain seal commitment, claims and refunds are still wallet-signed transactions.
 */
import { ed25519 } from '@noble/curves/ed25519'
import bs58 from 'bs58'

export interface SessionKey {
  matchId: string
  wallet: string
  secret: Uint8Array // 32-byte seed
  pubkey: Uint8Array
  expiresAt: number // ms epoch
}

/** Outlives any single match (fill window + seal + betting) with room to spare. */
export const SESSION_KEY_TTL_MS = 6 * 60 * 60 * 1000

const storageKey = (matchId: string, wallet: string) => `syn.sk.v1:${matchId}:${wallet}`

/**
 * The exact text the wallet signs — byte-identical to
 * `syndicate_engine::verify::session_key_grant_message` (the server rebuilds it to verify).
 */
export function sessionKeyGrantMessage(
  onchainMatchId: string | bigint,
  wallet: string,
  sessionPubkey: Uint8Array,
  expiresAt: number,
): string {
  return (
    "Satoshi's Table — one-tap play\n\n" +
    'Let this browser make your moves in this match (bet, check, call, fold, seal) ' +
    'without asking you to sign each one. It cannot move your funds.\n\n' +
    `match: ${onchainMatchId.toString()}\n` +
    `wallet: ${wallet}\n` +
    `session key: ${bs58.encode(sessionPubkey)}\n` +
    `expires: ${expiresAt}`
  )
}

export function newSessionKey(matchId: string, wallet: string, now = Date.now()): SessionKey {
  const secret = ed25519.utils.randomPrivateKey()
  return { matchId, wallet, secret, pubkey: ed25519.getPublicKey(secret), expiresAt: now + SESSION_KEY_TTL_MS }
}

/** base64 ed25519 signature over the raw intent bytes. */
export function signWithSessionKey(key: SessionKey, message: Uint8Array): string {
  return btoa(String.fromCharCode(...ed25519.sign(message, key.secret)))
}

/** Persist a key the server has accepted, so a reload mid-hand needs no new wallet prompt. */
export function saveSessionKey(key: SessionKey) {
  try {
    localStorage.setItem(
      storageKey(key.matchId, key.wallet),
      JSON.stringify({ secret: bs58.encode(key.secret), expiresAt: key.expiresAt }),
    )
  } catch {
    /* storage unavailable — the key lives for this page only */
  }
}

/** A previously accepted, unexpired key for this match + wallet. Sweeps expired entries. */
export function loadSessionKey(matchId: string, wallet: string, now = Date.now()): SessionKey | null {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (!k?.startsWith('syn.sk.v1:')) continue
      const v = JSON.parse(localStorage.getItem(k) ?? 'null') as { expiresAt?: number } | null
      if (!v?.expiresAt || v.expiresAt <= now) localStorage.removeItem(k)
    }
    const raw = localStorage.getItem(storageKey(matchId, wallet))
    if (!raw) return null
    const { secret, expiresAt } = JSON.parse(raw) as { secret: string; expiresAt: number }
    // Leave a margin so a key never expires between signing and the server checking it.
    if (expiresAt - 60_000 <= now) return null
    const seed = bs58.decode(secret)
    return { matchId, wallet, secret: seed, pubkey: ed25519.getPublicKey(seed), expiresAt }
  } catch {
    return null
  }
}
