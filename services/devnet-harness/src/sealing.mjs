import { createHash, randomBytes } from 'node:crypto';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { predictionCommitmentHash } from './intent.mjs';

export function anchorDiscriminator(preimage) {
  return createHash('sha256').update(preimage).digest().subarray(0, 8);
}

export function buildRegisterPredictionCommitmentIx(programId, player, matchPda, seatPda, args) {
  const commitment = Buffer.from(args.commitmentHex.replace(/^0x/, ''), 'hex');
  if (commitment.length !== 32) throw new Error('commitment must be 32 bytes');
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: false },
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      anchorDiscriminator('global:register_prediction_commitment'),
      commitment,
      u64(args.timelockTarget),
    ]),
  });
}

export function buildBeginLiveIx(programId, authority, protocolPda, matchPda, buttonRandomness, seatAccounts) {
  if (buttonRandomness.length !== 32) throw new Error('button_randomness must be 32 bytes');
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: protocolPda, isSigner: false, isWritable: false },
      { pubkey: matchPda, isSigner: false, isWritable: true },
      ...seatAccounts.map((seat) => ({ pubkey: seat, isSigner: false, isWritable: true })),
    ],
    data: Buffer.concat([
      anchorDiscriminator('global:begin_live'),
      Buffer.from(buttonRandomness),
    ]),
  });
}

export function readMatchButton(accountData) {
  // MatchAccount layout: button is after many fields; read from on-chain offset used by program tests.
  if (accountData.length < 400) throw new Error('match account too short');
  return accountData.readUInt8(359);
}

export function deriveButtonFromRandomness(randomness, playerCount) {
  const seedU64 = randomness.readBigUInt64LE(0);
  return Number(seedU64 % BigInt(playerCount));
}

export function newPredictionSecrets(oraclePrice) {
  const blindingHex = randomBytes(32).toString('hex');
  const prediction = BigInt(oraclePrice);
  const commitmentHex = predictionCommitmentHash(prediction, blindingHex);
  return { prediction, blindingHex, commitmentHex };
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
  };
}

function u64(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value), 0);
  return out;
}
