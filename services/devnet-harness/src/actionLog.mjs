import { createHash, randomBytes, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  ACTION_TAG,
  actionIntentMessage,
  decodeWalletPubkey,
  predictionCommitmentHash,
  predictionCommitmentMessage,
} from './intent.mjs';

export const ACTION_LOG_SEED = 'actionlog';
export const ED25519_PROGRAM_ID = new PublicKey('Ed25519SigVerify111111111111111111111111111');
export const IX_SYSVAR_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');
export const GENESIS_HEAD_HEX = '00'.repeat(32);

export function actionLogPda(programId, matchPda) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ACTION_LOG_SEED), matchPda.toBuffer()],
    programId,
  );
}

export function anchorDiscriminator(preimage) {
  return createHash('sha256').update(preimage).digest().subarray(0, 8);
}

export function signWithKeypair(keypair, message) {
  const seed = keypair.secretKey.subarray(0, 32);
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return Uint8Array.from(cryptoSign(null, message, privateKey));
}

export function buildEd25519VerifyInstruction({ publicKey, message, signature }) {
  if (publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  if (signature.length !== 64) throw new Error('ed25519 signature must be 64 bytes');
  const numSignatures = 1;
  const publicKeyOffset = 16;
  const signatureOffset = publicKeyOffset + 32;
  const messageDataOffset = signatureOffset + 64;
  const data = Buffer.alloc(messageDataOffset + message.length);
  data.writeUInt8(numSignatures, 0);
  data.writeUInt8(0, 1);
  data.writeUInt16LE(signatureOffset, 2);
  data.writeUInt16LE(0xffff, 4);
  data.writeUInt16LE(publicKeyOffset, 6);
  data.writeUInt16LE(0xffff, 8);
  data.writeUInt16LE(messageDataOffset, 10);
  data.writeUInt16LE(message.length, 12);
  data.writeUInt16LE(0xffff, 14);
  publicKey.forEach((b, i) => data.writeUInt8(b, publicKeyOffset + i));
  signature.forEach((b, i) => data.writeUInt8(b, signatureOffset + i));
  message.forEach((b, i) => data.writeUInt8(b, messageDataOffset + i));
  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [{ pubkey: IX_SYSVAR_ID, isSigner: false, isWritable: false }],
    data,
  });
}

export function encodeInitActionLogParams(params) {
  const seals = Buffer.alloc(8 * 5);
  for (let i = 0; i < 5; i += 1) {
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

export function encodeRegisterPredictionCommitmentArgs(args) {
  if (args.commitment.length !== 32) throw new Error('commitment must be 32 bytes');
  return Buffer.concat([
    u16(args.seatIndex),
    u64(args.sealSeq),
    Buffer.from(args.commitment),
    Buffer.from([args.ed25519IxIndex]),
  ]);
}

export function encodeAppendPlayerActionArgs(args) {
  return Buffer.concat([
    u16(args.seatIndex),
    u64(args.nonce),
    Buffer.from([args.actionTag]),
    u64(args.amount),
    Buffer.from([args.ed25519IxIndex]),
  ]);
}

export function buildInitActionLogIx(programId, authority, protocolPda, matchPda, seatAccounts, params) {
  const [actionLog] = actionLogPda(programId, matchPda);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: protocolPda, isSigner: false, isWritable: false },
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: actionLog, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...seatAccounts.map((seat) => ({ pubkey: seat, isSigner: false, isWritable: false })),
    ],
    data: Buffer.concat([anchorDiscriminator('global:init_action_log'), encodeInitActionLogParams(params)]),
  });
}

export function buildRegisterPredictionCommitmentIx(programId, player, matchPda, args) {
  const [actionLog] = actionLogPda(programId, matchPda);
  const seatPubkey = decodeWalletPubkey(player.publicKey.toBase58());
  const commitment = Buffer.from(args.commitmentHex.replace(/^0x/, ''), 'hex');
  const message = predictionCommitmentMessage({
    matchId: args.matchId,
    onchainMatchId: args.matchId,
    seatIndex: args.seatIndex,
    seatPubkey,
    sealSeq: args.sealSeq,
    commitment: Uint8Array.from(commitment),
  });
  const signature = signWithKeypair(player, message);
  const ed25519Ix = buildEd25519VerifyInstruction({
    publicKey: Uint8Array.from(player.publicKey.toBytes()),
    message,
    signature,
  });
  const progIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: false },
      { pubkey: actionLog, isSigner: false, isWritable: true },
      { pubkey: matchPda, isSigner: false, isWritable: false },
      { pubkey: IX_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator('global:register_prediction_commitment'),
      encodeRegisterPredictionCommitmentArgs({
        seatIndex: args.seatIndex,
        sealSeq: args.sealSeq,
        commitment,
        ed25519IxIndex: 0,
      }),
    ]),
  });
  return [ed25519Ix, progIx];
}

export function buildAppendPlayerActionIx(programId, player, protocolPda, matchPda, args) {
  const [actionLog] = actionLogPda(programId, matchPda);
  const prevHead = Buffer.from(args.prevHeadHex.replace(/^0x/, ''), 'hex');
  if (prevHead.length !== 32) throw new Error('prevHead must be 32 bytes');
  const seatPubkey = decodeWalletPubkey(player.publicKey.toBase58());
  const message = actionIntentMessage({
    matchId: args.matchId,
    onchainMatchId: args.matchId,
    seatIndex: args.seatIndex,
    seatPubkey,
    nonce: args.nonce,
    prevHead: Uint8Array.from(prevHead),
    actionTag: args.actionTag,
    amount: args.amount,
  });
  const signature = signWithKeypair(player, message);
  const ed25519Ix = buildEd25519VerifyInstruction({
    publicKey: Uint8Array.from(player.publicKey.toBytes()),
    message,
    signature,
  });
  const progIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: false },
      { pubkey: protocolPda, isSigner: false, isWritable: false },
      { pubkey: actionLog, isSigner: false, isWritable: true },
      { pubkey: matchPda, isSigner: false, isWritable: false },
      { pubkey: IX_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator('global:append_player_action'),
      encodeAppendPlayerActionArgs({
        seatIndex: args.seatIndex,
        nonce: args.nonce,
        actionTag: args.actionTag,
        amount: args.amount,
        ed25519IxIndex: 0,
      }),
    ]),
  });
  return [ed25519Ix, progIx];
}

export function buildFinalizeActionLogIx(programId, authority, protocolPda, matchPda, eventRoot) {
  const [actionLog] = actionLogPda(programId, matchPda);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: protocolPda, isSigner: false, isWritable: false },
      { pubkey: actionLog, isSigner: false, isWritable: true },
      { pubkey: matchPda, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([anchorDiscriminator('global:finalize_action_log'), Buffer.from(eventRoot)]),
  });
}

export function buildSetButtonSeedIx(programId, authority, protocolPda, matchPda, vrfSeed, vrfProofHash) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: protocolPda, isSigner: false, isWritable: false },
      { pubkey: matchPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      anchorDiscriminator('global:set_button_seed'),
      Buffer.from(vrfSeed),
      Buffer.from(vrfProofHash),
    ]),
  });
}

export function buildBeginLiveIx(programId, authority, protocolPda, matchPda) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: protocolPda, isSigner: false, isWritable: false },
      { pubkey: matchPda, isSigner: false, isWritable: true },
    ],
    data: anchorDiscriminator('global:begin_live'),
  });
}

export function readActionLogHead(accountData) {
  if (accountData.length < 72) throw new Error('action log account too short');
  return Buffer.from(accountData.subarray(40, 72));
}

export function readMatchButton(accountData) {
  if (accountData.length < 328) throw new Error('match account too short');
  return accountData.readUInt8(327);
}

export function readMatchVrfSeed(accountData) {
  if (accountData.length < 294) throw new Error('match account too short');
  return Buffer.from(accountData.subarray(262, 294));
}

export function deriveButtonFromVrfSeed(vrfSeed, playerCount) {
  const seedU64 = vrfSeed.readBigUInt64LE(0);
  return Number(seedU64 % BigInt(playerCount));
}

export function headsUpSbBbSeats(button) {
  const sbSeat = button;
  const bbSeat = (button + 1) % 2;
  return { sbSeat, bbSeat };
}

export function newPredictionSecrets(oraclePrice) {
  const blindingHex = randomBytes(32).toString('hex');
  const prediction = BigInt(oraclePrice);
  const commitmentHex = predictionCommitmentHash(prediction, blindingHex);
  return { prediction, blindingHex, commitmentHex };
}

export function playerStatesAfterHeadsUpAllInCall({ buyIn, winnerSecrets, loserSecrets }) {
  return {
    players: [
      {
        seatIndex: 0,
        contribution: buyIn,
        folded: false,
        hasPrediction: true,
        prediction: winnerSecrets.seatIndex === 0 ? winnerSecrets.prediction : loserSecrets.prediction,
        sealSeq: 0n,
      },
      {
        seatIndex: 1,
        contribution: buyIn,
        folded: false,
        hasPrediction: true,
        prediction: winnerSecrets.seatIndex === 1 ? winnerSecrets.prediction : loserSecrets.prediction,
        sealSeq: 1n,
      },
    ],
    revealed: [
      {
        seatIndex: winnerSecrets.seatIndex,
        prediction: winnerSecrets.prediction,
        blindingHex: winnerSecrets.blindingHex,
      },
      {
        seatIndex: loserSecrets.seatIndex,
        prediction: loserSecrets.prediction,
        blindingHex: loserSecrets.blindingHex,
      },
    ],
  };
}

export function assignWinnerLoserSecrets(oraclePrice, button) {
  const seat0 = { ...newPredictionSecrets(oraclePrice), seatIndex: 0 };
  const seat1 = { ...newPredictionSecrets(oraclePrice + 10_000n), seatIndex: 1 };
  const bbSeat = (button + 1) % 2;
  return {
    winnerSecrets: bbSeat === 0 ? seat0 : seat1,
    loserSecrets: bbSeat === 0 ? seat1 : seat0,
  };
}

export { ACTION_TAG };

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(Number(value), 0);
  return out;
}

function u64(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value), 0);
  return out;
}
