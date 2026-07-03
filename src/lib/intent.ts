/**
 * Canonical signed-intent message bytes — a byte-exact TypeScript port of the backend's
 * `services/shared/src/intent.rs`. The off-chain verifier reconstructs these exact bytes and
 * checks the ed25519 signature, so any layout drift here is silently rejected on-chain.
 *
 * Layout primitives: little-endian integers, domain tag + a `0` separator byte, then fields
 * in declaration order. Reproduce SHA-256 with WebCrypto (FIPS 180-4 — matches the sha2 crate).
 */

export const DOMAIN_ACTION = 'syndicate/action/v1'
export const DOMAIN_DEFAULT = 'syndicate/default/v1'
export const DOMAIN_PREDICTION = 'syndicate/prediction/v1'

export const ACTION_TAG = {
  fold: 0,
  check: 1,
  call: 2,
  bet_to: 3,
  raise_to: 4,
  all_in: 5,
} as const

export const DEFAULT_TAG = {
  check_fold: 0,
  check_call_any: 1,
} as const

// ---------------------------------------------------------------------------
// LE encoders
// ---------------------------------------------------------------------------

function u16le(v: number): Uint8Array {
  const b = new Uint8Array(2)
  b[0] = v & 0xff
  b[1] = (v >> 8) & 0xff
  return b
}

function u64le(v: bigint | number): Uint8Array {
  let x = BigInt(v)
  const b = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return b
}

/** Signed 128-bit little-endian (two's complement) — the on-chain `Price` (i128, expo −18). */
export function i128le(v: bigint): Uint8Array {
  const mod = 1n << 128n
  let x = ((v % mod) + mod) % mod // wrap to unsigned 128-bit two's complement
  const b = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    b[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return b
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const len = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

const enc = new TextEncoder()

/** Parse hex ("0x…"/bare) into bytes; enforces `len` if given. */
export function hexToBytes(hex: string, len?: number): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  if (len !== undefined && clean.length !== len * 2) {
    throw new Error(`expected ${len}-byte hex, got ${clean.length / 2}`)
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// SHA-256 (WebCrypto) — the normative commitment hash
// ---------------------------------------------------------------------------

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Cast to BufferSource: TS 5.7's typed-array generics infer ArrayBufferLike (which could be
  // SharedArrayBuffer) but WebCrypto accepts our plain Uint8Array at runtime.
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource)
  return new Uint8Array(digest)
}

/** v2 on-chain prediction commitment: `sha256(tlock_ciphertext_bytes)`. */
export function ciphertextCommitment(ciphertext: Uint8Array): Promise<Uint8Array> {
  return sha256(ciphertext)
}

/** v1 reveal binding `sha256(prediction_i128_le ‖ blinding_32)` — kept for parity/tests. */
export function predictionCommitmentHash(price: bigint, blinding: Uint8Array): Promise<Uint8Array> {
  if (blinding.length !== 32) throw new Error('blinding must be 32 bytes')
  return sha256(concat(i128le(price), blinding))
}

// ---------------------------------------------------------------------------
// Intent messages (mirror intent.rs exactly)
// ---------------------------------------------------------------------------

/**
 * Action intent, signed by the seat owner before each move. Mirrors
 * `action_intent_message`: DOMAIN ‖ 0 ‖ match_id ‖ onchain_match_id ‖ seat_index ‖
 * seat_pubkey(32) ‖ nonce ‖ prev_head(32) ‖ action_tag ‖ amount.
 */
export function actionIntentMessage(args: {
  matchId: bigint | number
  onchainMatchId: bigint | number
  seatIndex: number
  seatPubkey: Uint8Array // 32
  nonce: bigint | number
  prevHead: Uint8Array // 32
  actionTag: number
  amount: bigint | number
}): Uint8Array {
  if (args.seatPubkey.length !== 32) throw new Error('seatPubkey must be 32 bytes')
  if (args.prevHead.length !== 32) throw new Error('prevHead must be 32 bytes')
  return concat(
    enc.encode(DOMAIN_ACTION),
    [0],
    u64le(args.matchId),
    u64le(args.onchainMatchId),
    u16le(args.seatIndex),
    args.seatPubkey,
    u64le(args.nonce),
    args.prevHead,
    [args.actionTag & 0xff],
    u64le(args.amount),
  )
}

/** Pre-signed default policy (CheckFold / CheckCallAny) bound at join. */
export function defaultPolicyMessage(args: {
  matchId: bigint | number
  onchainMatchId: bigint | number
  seatIndex: number
  seatPubkey: Uint8Array // 32
  policyTag: number
}): Uint8Array {
  if (args.seatPubkey.length !== 32) throw new Error('seatPubkey must be 32 bytes')
  return concat(
    enc.encode(DOMAIN_DEFAULT),
    [0],
    u64le(args.matchId),
    u64le(args.onchainMatchId),
    u16le(args.seatIndex),
    args.seatPubkey,
    [args.policyTag & 0xff],
  )
}

/**
 * Prediction commitment (SEALING): binds seat + tlock ciphertext hash + drand target.
 * `seal_seq` is assigned on-chain, NOT signed.
 */
export function predictionCommitmentMessage(args: {
  matchId: bigint | number
  onchainMatchId: bigint | number
  seatIndex: number
  seatPubkey: Uint8Array // 32
  timelockTarget: bigint | number
  commitment: Uint8Array // 32
}): Uint8Array {
  if (args.seatPubkey.length !== 32) throw new Error('seatPubkey must be 32 bytes')
  if (args.commitment.length !== 32) throw new Error('commitment must be 32 bytes')
  return concat(
    enc.encode(DOMAIN_PREDICTION),
    [0],
    u64le(args.matchId),
    u64le(args.onchainMatchId),
    u16le(args.seatIndex),
    args.seatPubkey,
    u64le(args.timelockTarget),
    args.commitment,
  )
}

/** Map a betting action to its (tag, amount) pair — mirrors `action_tag_and_amount`. */
export function actionTagAndAmount(action: string, amount = 0): { tag: number; amount: number } {
  switch (action) {
    case 'fold':
    case 'Fold':
      return { tag: ACTION_TAG.fold, amount: 0 }
    case 'check':
    case 'Check':
      return { tag: ACTION_TAG.check, amount: 0 }
    case 'call':
    case 'Call':
      return { tag: ACTION_TAG.call, amount: 0 }
    case 'all_in':
    case 'AllIn':
      return { tag: ACTION_TAG.all_in, amount: 0 }
    case 'bet_to':
    case 'BetTo':
      return { tag: ACTION_TAG.bet_to, amount }
    case 'raise_to':
    case 'RaiseTo':
      return { tag: ACTION_TAG.raise_to, amount }
    default:
      return { tag: ACTION_TAG.fold, amount: 0 }
  }
}
