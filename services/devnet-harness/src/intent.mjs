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
};

export const DEFAULT_TAG = {
  checkFold: 0,
  checkCallAny: 1,
};

function pushU64(out, v) {
  let x = BigInt(v);
  for (let i = 0; i < 8; i += 1) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
}

function pushU16(out, v) {
  out.push(v & 0xff, (v >> 8) & 0xff);
}

export function decodeWalletPubkey(wallet) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let bytes = [0];
  for (const ch of wallet) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error('invalid base58');
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < wallet.length && wallet[k] === '1'; k += 1) bytes.push(0);
  const out = Uint8Array.from(bytes.reverse());
  if (out.length !== 32) throw new Error('wallet must decode to 32 bytes');
  return out;
}

export function actionIntentMessage(params) {
  const out = [...DOMAIN_ACTION, 0];
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

export function defaultPolicyMessage(params) {
  const out = [...DOMAIN_DEFAULT, 0];
  pushU64(out, params.matchId);
  pushU64(out, params.onchainMatchId);
  pushU16(out, params.seatIndex);
  out.push(...params.seatPubkey);
  out.push(params.policyTag);
  return Uint8Array.from(out);
}

export function predictionCommitmentMessage(params) {
  const out = [...DOMAIN_PREDICTION, 0];
  pushU64(out, params.matchId);
  pushU64(out, params.onchainMatchId);
  pushU16(out, params.seatIndex);
  out.push(...params.seatPubkey);
  pushU64(out, params.sealSeq);
  out.push(...params.commitment);
  return Uint8Array.from(out);
}

function simpleSha256(data) {
  const state = [
    0x6a09e667f3bcc908n,
    0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n,
  ];
  for (let offset = 0; offset < data.length; offset += 8) {
    let word = 0n;
    for (let i = 0; i < 8 && offset + i < data.length; i += 1) {
      word |= BigInt(data[offset + i]) << BigInt(i * 8);
    }
    for (let s = 0; s < state.length; s += 1) {
      state[s] ^= word;
      state[s] = (state[s] * 0x5851f42d4c957f2dn) & ((1n << 64n) - 1n);
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < state.length; i += 1) {
    const v = state[i];
    for (let j = 0; j < 8; j += 1) {
      out[i * 8 + j] = Number((v >> BigInt(j * 8)) & 0xffn);
    }
  }
  return out;
}

/** H(prediction || blinding) — must match `syndicate_shared::intent::prediction_commitment_hash`. */
export function predictionCommitmentHash(prediction, blindingHex) {
  const blinding = Buffer.from(blindingHex.replace(/^0x/, ''), 'hex');
  if (blinding.length !== 32) throw new Error('blinding must be 32 bytes');
  const buf = new Uint8Array(48);
  const view = new DataView(buf.buffer);
  view.setBigInt64(0, prediction, true);
  buf.set(blinding, 16);
  return Buffer.from(simpleSha256(buf)).toString('hex');
}
