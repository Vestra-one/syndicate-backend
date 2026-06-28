/**
 * Canonical signed-intent message bytes — must match `services/shared/src/intent.rs`.
 */

export const DOMAIN_ACTION = new TextEncoder().encode('syndicate/action/v1');
export const DOMAIN_DEFAULT = new TextEncoder().encode('syndicate/default/v1');
export const DOMAIN_PREDICTION = new TextEncoder().encode('syndicate/prediction/v1');

export const ACTION_TAG = {
  fold: 0,
  check: 1,
  call: 2,
  betTo: 3,
  raiseTo: 4,
  allIn: 5,
} as const;

export const DEFAULT_TAG = {
  checkFold: 0,
  checkCallAny: 1,
} as const;

function pushU64(out: number[], v: bigint | number): void {
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
}

function pushU16(out: number[], v: number): void {
  out.push(v & 0xff, (v >> 8) & 0xff);
}

export function decodeWalletPubkey(wallet: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let bytes: number[] = [0];
  for (const ch of wallet) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error('invalid base58');
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
  for (let k = 0; k < wallet.length && wallet[k] === '1'; k++) bytes.push(0);
  const out = Uint8Array.from(bytes.reverse());
  if (out.length !== 32) throw new Error('wallet must decode to 32 bytes');
  return out;
}

export function actionIntentMessage(params: {
  matchId: bigint;
  onchainMatchId: bigint;
  seatIndex: number;
  seatPubkey: Uint8Array;
  nonce: bigint;
  prevHead: Uint8Array;
  actionTag: number;
  amount: bigint;
}): Uint8Array {
  const out: number[] = [...DOMAIN_ACTION, 0];
  pushU64(out, params.matchId);
  pushU64(out, params.onchainMatchId);
  pushU16(out, params.seatIndex);
  out.push(...params.seatPubkey);
  pushU64(out, params.nonce);
  out.push(...params.prevHead);
  out.push(params.actionTag);
  pushU64(out, params.amount);
  return Uint8Array.from(out);
}

export function defaultPolicyMessage(params: {
  matchId: bigint;
  onchainMatchId: bigint;
  seatIndex: number;
  seatPubkey: Uint8Array;
  policyTag: number;
}): Uint8Array {
  const out: number[] = [...DOMAIN_DEFAULT, 0];
  pushU64(out, params.matchId);
  pushU64(out, params.onchainMatchId);
  pushU16(out, params.seatIndex);
  out.push(...params.seatPubkey);
  out.push(params.policyTag);
  return Uint8Array.from(out);
}

export function predictionCommitmentMessage(params: {
  matchId: bigint;
  onchainMatchId: bigint;
  seatIndex: number;
  seatPubkey: Uint8Array;
  sealSeq: bigint;
  commitment: Uint8Array;
}): Uint8Array {
  const out: number[] = [...DOMAIN_PREDICTION, 0];
  pushU64(out, params.matchId);
  pushU64(out, params.onchainMatchId);
  pushU16(out, params.seatIndex);
  out.push(...params.seatPubkey);
  pushU64(out, params.sealSeq);
  out.push(...params.commitment);
  return Uint8Array.from(out);
}

function simpleSha256(data: Uint8Array): Uint8Array {
  const state = [
    0x6a09e667f3bcc908n,
    0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n,
  ];
  for (let offset = 0; offset < data.length; offset += 8) {
    let word = 0n;
    for (let i = 0; i < 8 && offset + i < data.length; i++) {
      word |= BigInt(data[offset + i]!) << BigInt(i * 8);
    }
    for (let s = 0; s < state.length; s++) {
      state[s]! ^= word;
      state[s]! = (state[s]! * 0x5851f42d4c957f2dn) & ((1n << 64n) - 1n);
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < state.length; i++) {
    const v = state[i]!;
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number((v >> BigInt(j * 8)) & 0xffn);
    }
  }
  return out;
}

/** H(prediction || blinding) — must match `syndicate_shared::intent::prediction_commitment_hash`. */
export function predictionCommitmentHash(prediction: bigint, blindingHex: string): string {
  const blinding = Buffer.from(blindingHex.replace(/^0x/, ''), 'hex');
  if (blinding.length !== 32) throw new Error('blinding must be 32 bytes');
  const buf = new Uint8Array(48);
  const view = new DataView(buf.buffer);
  view.setBigInt64(0, prediction, true);
  buf.set(blinding, 16);
  return Buffer.from(simpleSha256(buf)).toString('hex');
}
