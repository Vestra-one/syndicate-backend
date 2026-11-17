import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import bs58 from 'bs58'
import { newSessionKey, sessionKeyGrantMessage, signWithSessionKey } from './sessionKey'

describe('session key', () => {
  it('builds the grant text byte-for-byte like the server (verify.rs vector)', () => {
    // Same inputs as `session_key_grant_round_trips_and_binds_every_field` in the backend.
    const wallet = bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(7)))
    const sessionPk = ed25519.getPublicKey(new Uint8Array(32).fill(9))
    expect(sessionKeyGrantMessage(42n, wallet, sessionPk, 1000)).toBe(
      "Satoshi's Table — one-tap play\n\nLet this browser make your moves in this match (bet, check, call, fold, seal) without asking you to sign each one. It cannot move your funds.\n\n" +
        `match: 42\nwallet: ${wallet}\nsession key: ${bs58.encode(sessionPk)}\nexpires: 1000`,
    )
  })

  it('signs intents that verify against its public key', () => {
    const key = newSessionKey('m', 'w', 1_000)
    expect(key.expiresAt).toBeGreaterThan(1_000)
    const msg = new Uint8Array([1, 2, 3, 0, 255])
    const sig = Uint8Array.from(atob(signWithSessionKey(key, msg)), (c) => c.charCodeAt(0))
    expect(ed25519.verify(sig, msg, key.pubkey)).toBe(true)
    expect(ed25519.verify(sig, new Uint8Array([1, 2, 3]), key.pubkey)).toBe(false)
  })
})
