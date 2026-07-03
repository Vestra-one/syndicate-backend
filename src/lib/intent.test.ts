import { describe, it, expect } from 'vitest'
import {
  sha256,
  ciphertextCommitment,
  predictionCommitmentHash,
  actionIntentMessage,
  defaultPolicyMessage,
  predictionCommitmentMessage,
  i128le,
  bytesToHex,
  hexToBytes,
  DOMAIN_ACTION,
  DOMAIN_DEFAULT,
  DOMAIN_PREDICTION,
  ACTION_TAG,
} from './intent'

const enc = new TextEncoder()

describe('sha256 — the normative commitment hash (must match sha2 crate)', () => {
  it('matches the NIST vector for "abc" (intent.rs test vector)', async () => {
    expect(bytesToHex(await sha256(enc.encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
  it('matches the vector for "" (intent.rs test vector)', async () => {
    expect(bytesToHex(await sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
  it('ciphertextCommitment(x) === sha256(x)', async () => {
    const ct = enc.encode('abc')
    expect(bytesToHex(await ciphertextCommitment(ct))).toBe(bytesToHex(await sha256(ct)))
  })
})

describe('i128le — signed 128-bit little-endian', () => {
  it('encodes 100000 as 16 LE bytes', () => {
    const b = i128le(100000n) // 0x0186A0
    expect(b.length).toBe(16)
    expect(Array.from(b.slice(0, 3))).toEqual([0xa0, 0x86, 0x01])
    expect(b.slice(3).every((x) => x === 0)).toBe(true)
  })
  it("encodes -1 as all 0xff (two's complement)", () => {
    expect(Array.from(i128le(-1n)).every((x) => x === 0xff)).toBe(true)
  })
})

describe('predictionCommitmentHash — sha256(price_i128_le ‖ blinding)', () => {
  it('matches the reconstructed 48-byte preimage (intent.rs vector)', async () => {
    const blinding = new Uint8Array(32).fill(7)
    const price = 100000n
    const buf = new Uint8Array(48)
    buf.set(i128le(price), 0)
    buf.set(blinding, 16)
    expect(bytesToHex(await predictionCommitmentHash(price, blinding))).toBe(bytesToHex(await sha256(buf)))
  })
})

describe('actionIntentMessage — byte layout mirrors intent.rs', () => {
  const pk = new Uint8Array(32).fill(1)
  const head = new Uint8Array(32).fill(2)
  const build = () =>
    actionIntentMessage({
      matchId: 1,
      onchainMatchId: 42,
      seatIndex: 0,
      seatPubkey: pk,
      nonce: 1,
      prevHead: head,
      actionTag: ACTION_TAG.call,
      amount: 0,
    })

  it('is deterministic (action_message_is_deterministic)', () => {
    expect(bytesToHex(build())).toBe(bytesToHex(build()))
  })
  it('starts with the domain tag + 0 separator', () => {
    const m = build()
    expect(new TextDecoder().decode(m.slice(0, DOMAIN_ACTION.length))).toBe(DOMAIN_ACTION)
    expect(m[DOMAIN_ACTION.length]).toBe(0)
  })
  it('has the exact fixed length', () => {
    // domain(19) ‖ sep(1) ‖ match_id(8) ‖ onchain(8) ‖ seat(2) ‖ pk(32) ‖ nonce(8) ‖ head(32) ‖ tag(1) ‖ amount(8)
    expect(build().length).toBe(19 + 1 + 8 + 8 + 2 + 32 + 8 + 32 + 1 + 8)
  })
  it('encodes both u64 match-id slots little-endian right after the separator', () => {
    const m = build()
    const off = DOMAIN_ACTION.length + 1
    expect(Array.from(m.slice(off, off + 8))).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect(Array.from(m.slice(off + 8, off + 16))).toEqual([42, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('default & prediction messages — domain tags + lengths', () => {
  const pk = new Uint8Array(32).fill(1)
  const commitment = new Uint8Array(32).fill(9)
  it('defaultPolicyMessage: domain(19) ‖ sep ‖ 8 ‖ 8 ‖ 2 ‖ 32 ‖ tag(1)', () => {
    const m = defaultPolicyMessage({ matchId: 1, onchainMatchId: 42, seatIndex: 0, seatPubkey: pk, policyTag: 1 })
    expect(new TextDecoder().decode(m.slice(0, DOMAIN_DEFAULT.length))).toBe(DOMAIN_DEFAULT)
    expect(m.length).toBe(DOMAIN_DEFAULT.length + 1 + 8 + 8 + 2 + 32 + 1)
  })
  it('predictionCommitmentMessage: domain ‖ sep ‖ 8 ‖ 8 ‖ 2 ‖ 32 ‖ target(8) ‖ commitment(32)', () => {
    const m = predictionCommitmentMessage({ matchId: 1, onchainMatchId: 42, seatIndex: 0, seatPubkey: pk, timelockTarget: 7, commitment })
    expect(new TextDecoder().decode(m.slice(0, DOMAIN_PREDICTION.length))).toBe(DOMAIN_PREDICTION)
    expect(m.length).toBe(DOMAIN_PREDICTION.length + 1 + 8 + 8 + 2 + 32 + 8 + 32)
  })
})

describe('parseJsonU64Safe — u64 fields survive JSON.parse', () => {
  it('quotes u64::MAX (the create_params max_oracle_confidence case)', async () => {
    const { parseJsonU64Safe } = await import('./api')
    const j = parseJsonU64Safe('{"max_oracle_confidence":18446744073709551615,"oracle_exponent":-18}') as Record<string, unknown>
    expect(j.max_oracle_confidence).toBe('18446744073709551615') // exact, as a string
    expect(j.oracle_exponent).toBe(-18)
  })
  it('leaves normal numbers, ms timestamps, and string values untouched', async () => {
    const { parseJsonU64Safe } = await import('./api')
    const j = parseJsonU64Safe('{"buy_in":1000000,"expires_at":1783080695231,"sig":"5K1x","nested":{"a":[1,2]}}') as Record<string, unknown>
    expect(j.buy_in).toBe(1_000_000)
    expect(j.expires_at).toBe(1_783_080_695_231) // 13 digits — stays numeric
    expect(j.sig).toBe('5K1x')
  })
})

describe('hex helpers', () => {
  it('roundtrips a 32-byte hex string', () => {
    const h = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(bytesToHex(hexToBytes(h, 32))).toBe(h)
  })
  it('rejects a wrong-length hex when len is enforced', () => {
    expect(() => hexToBytes('aabb', 32)).toThrow()
  })
})
