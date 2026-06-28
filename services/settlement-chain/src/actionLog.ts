/**
 * Action-log PDA transaction builders + Ed25519 verify instruction helper.
 * Instruction discriminators match Anchor `global:<name>` SHA256 prefix bytes.
 */

import { createHash } from 'node:crypto';
import {
  ACTION_TAG,
  actionIntentMessage,
  decodeWalletPubkey,
  defaultPolicyMessage,
  predictionCommitmentMessage,
} from './intent.ts';

export const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111';
export const IX_SYSVAR_ID = 'Sysvar1nstructions1111111111111111111111111';

export function anchorDiscriminator(preimage: string): Buffer {
  return createHash('sha256').update(preimage).digest().subarray(0, 8);
}

/** Native Ed25519 verify instruction (must precede program append ix in the same tx). */
export function buildEd25519VerifyInstruction(params: {
  publicKey: Uint8Array;
  message: Uint8Array;
  signature: Uint8Array;
}): { programId: any; keys: any[]; data: Buffer } {
  if (params.publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  if (params.signature.length !== 64) throw new Error('ed25519 signature must be 64 bytes');
  const numSignatures = 1;
  const publicKeyOffset = 16;
  const signatureOffset = publicKeyOffset + 32;
  const messageDataOffset = signatureOffset + 64;
  const data = Buffer.alloc(messageDataOffset + params.message.length);
  data.writeUInt8(numSignatures, 0);
  data.writeUInt8(0, 1);
  data.writeUInt16LE(signatureOffset, 2);
  data.writeUInt16LE(0xffff, 4);
  data.writeUInt16LE(publicKeyOffset, 6);
  data.writeUInt16LE(0xffff, 8);
  data.writeUInt16LE(messageDataOffset, 10);
  data.writeUInt16LE(params.message.length, 12);
  data.writeUInt16LE(0xffff, 14);
  params.publicKey.forEach((b, i) => data.writeUInt8(b, publicKeyOffset + i));
  params.signature.forEach((b, i) => data.writeUInt8(b, signatureOffset + i));
  params.message.forEach((b, i) => data.writeUInt8(b, messageDataOffset + i));
  return {
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data,
  };
}

export function decodeBase64Signature(sig: string): Uint8Array {
  const bytes = Buffer.from(sig.trim(), 'base64');
  if (bytes.length !== 64) throw new Error('signature must decode to 64 bytes');
  return Uint8Array.from(bytes);
}

export function encodeAppendPlayerActionArgs(args: {
  seatIndex: number;
  nonce: bigint;
  actionTag: number;
  amount: bigint;
  ed25519IxIndex: number;
}): Buffer {
  return Buffer.concat([
    u16(args.seatIndex),
    u64(args.nonce),
    Buffer.from([args.actionTag]),
    u64(args.amount),
    Buffer.from([args.ed25519IxIndex]),
  ]);
}

export function encodeRegisterDefaultPolicyArgs(args: {
  seatIndex: number;
  policyTag: number;
  ed25519IxIndex: number;
}): Buffer {
  return Buffer.concat([u16(args.seatIndex), Buffer.from([args.policyTag, args.ed25519IxIndex])]);
}

export function encodeRegisterPredictionCommitmentArgs(args: {
  seatIndex: number;
  sealSeq: bigint;
  commitment: Uint8Array;
  ed25519IxIndex: number;
}): Buffer {
  if (args.commitment.length !== 32) throw new Error('commitment must be 32 bytes');
  return Buffer.concat([
    u16(args.seatIndex),
    u64(args.sealSeq),
    Buffer.from(args.commitment),
    Buffer.from([args.ed25519IxIndex]),
  ]);
}

export function encodeAppendTimeoutActionArgs(seatIndex: number): Buffer {
  return u16(seatIndex);
}

export function encodeInitActionLogParams(params: {
  button: number;
  smallBlind: bigint;
  bigBlind: bigint;
  roundCount: number;
  settleDeadlineTs: bigint;
  sealSeq: bigint[];
}): Buffer {
  const seals = Buffer.alloc(8 * 5);
  for (let i = 0; i < 5; i++) {
    seals.writeBigUInt64LE(params.sealSeq[i] ?? 0n, i * 8);
  }
  return Buffer.concat([
    Buffer.from([params.button]),
    u64(params.smallBlind),
    u64(params.bigBlind),
    Buffer.from([params.roundCount]),
    u64(params.settleDeadlineTs),
    seals,
  ]);
}

export function buildActionIntentMessage(params: {
  matchId: bigint;
  onchainMatchId: bigint;
  seatIndex: number;
  wallet: string;
  nonce: bigint;
  prevHeadHex: string;
  actionTag: number;
  amount: bigint;
}): Uint8Array {
  const seatPubkey = decodeWalletPubkey(params.wallet);
  const prevHead = Buffer.from(params.prevHeadHex.replace(/^0x/, ''), 'hex');
  if (prevHead.length !== 32) throw new Error('prevHead must be 32 bytes');
  return actionIntentMessage({
    matchId: params.matchId,
    onchainMatchId: params.onchainMatchId,
    seatIndex: params.seatIndex,
    seatPubkey,
    nonce: params.nonce,
    prevHead: Uint8Array.from(prevHead),
    actionTag: params.actionTag,
    amount: params.amount,
  });
}

export function buildDefaultPolicyMessage(params: {
  matchId: bigint;
  onchainMatchId: bigint;
  seatIndex: number;
  wallet: string;
  policyTag: number;
}): Uint8Array {
  return defaultPolicyMessage({
    matchId: params.matchId,
    onchainMatchId: params.onchainMatchId,
    seatIndex: params.seatIndex,
    seatPubkey: decodeWalletPubkey(params.wallet),
    policyTag: params.policyTag,
  });
}

export function buildPredictionCommitmentMessage(params: {
  matchId: bigint;
  onchainMatchId: bigint;
  seatIndex: number;
  wallet: string;
  sealSeq: bigint;
  commitmentHex: string;
}): Uint8Array {
  const commitment = Buffer.from(params.commitmentHex.replace(/^0x/, ''), 'hex');
  if (commitment.length !== 32) throw new Error('commitment must be 32 bytes');
  return predictionCommitmentMessage({
    matchId: params.matchId,
    onchainMatchId: params.onchainMatchId,
    seatIndex: params.seatIndex,
    seatPubkey: decodeWalletPubkey(params.wallet),
    sealSeq: params.sealSeq,
    commitment: Uint8Array.from(commitment),
  });
}

export { decodeWalletPubkey } from './intent.ts';

export function actionTagFromName(name: string): number {
  switch (name) {
    case 'fold':
    case 'Fold':
      return ACTION_TAG.fold;
    case 'check':
    case 'Check':
      return ACTION_TAG.check;
    case 'call':
    case 'Call':
      return ACTION_TAG.call;
    case 'bet_to':
    case 'BetTo':
      return ACTION_TAG.betTo;
    case 'raise_to':
    case 'RaiseTo':
      return ACTION_TAG.raiseTo;
    case 'all_in':
    case 'AllIn':
      return ACTION_TAG.allIn;
    default:
      throw new Error(`unknown action tag: ${name}`);
  }
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}
