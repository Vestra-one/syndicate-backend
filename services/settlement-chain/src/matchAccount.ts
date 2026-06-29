/**
 * Deserializers for the on-chain `MatchAccount` / `SeatAccount` (Anchor, 8-byte discriminator
 * prefix). Offsets are derived field-by-field from
 * services/programs/programs/syndicate_program/src/state.rs — keep in lockstep with that layout.
 *
 * MatchAccount = 435 bytes, SeatAccount = 168 bytes (incl. the 8-byte discriminator).
 */

import { PublicKey } from '@solana/web3.js';

export const MATCH_ACCOUNT_SIZE = 435;
export const SEAT_ACCOUNT_SIZE = 168;

/** MatchStatus enum order (state.rs `MatchStatus`). */
export const MATCH_STATUS = ['Filling', 'Sealing', 'Live', 'Settled', 'Void'] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];

/** VoidKind enum order (state.rs `VoidKind`). */
export const VOID_KIND = ['None', 'FillingVoid', 'UnderMinSealed', 'Emergency'] as const;
export type VoidKind = (typeof VOID_KIND)[number];

export interface DecodedMatch {
  authority: string;
  mint: string;
  vault: string;
  matchId: bigint;
  buyIn: bigint;
  status: MatchStatus;
  /** 32-byte config hash as lowercase hex, NO `0x` prefix (matches config `templateAllowlist()`). */
  configHash: string;
  /** 20-byte price token as lowercase hex, NO `0x` prefix. */
  priceToken: string;
  fillDeadlineTs: bigint;
  lockTs: bigint;
  sealDeadlineTs: bigint;
  liveStartTs: bigint;
  scheduledEndTs: bigint;
  totalBettingDurationSec: bigint;
  sealWindowSec: bigint;
  beginLiveWindowSec: bigint;
  entryFee: bigint;
  rakeBps: number;
  rakeCap: bigint;
  nonsealPenaltyBps: number;
  minPlayers: number;
  maxPlayers: number;
  playerCount: number;
  sealedCount: number;
  deadMoney: bigint;
  settledPayout: bigint;
  voidKind: VoidKind;
}

export function decodeMatchAccount(data: Buffer): DecodedMatch {
  if (data.length < MATCH_ACCOUNT_SIZE) {
    throw new Error(`match account data too short: ${data.length} < ${MATCH_ACCOUNT_SIZE}`);
  }
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32)).toBase58();
  return {
    authority: pk(8),
    mint: pk(40),
    vault: pk(72),
    matchId: data.readBigUInt64LE(104),
    buyIn: data.readBigUInt64LE(112),
    status: statusFrom(data.readUInt8(120)),
    configHash: data.subarray(121, 153).toString('hex'),
    priceToken: data.subarray(153, 173).toString('hex'),
    fillDeadlineTs: data.readBigUInt64LE(173),
    lockTs: data.readBigUInt64LE(181),
    sealDeadlineTs: data.readBigUInt64LE(189),
    liveStartTs: data.readBigUInt64LE(197),
    scheduledEndTs: data.readBigUInt64LE(205),
    totalBettingDurationSec: data.readBigUInt64LE(213),
    sealWindowSec: data.readBigUInt64LE(221),
    beginLiveWindowSec: data.readBigUInt64LE(229),
    // max_oracle_confidence (237) + oracle_exponent (245) + signed_price_hash (249) +
    // signed_price_timestamp_ms (281) are skipped — not needed by the registry/verifier.
    entryFee: data.readBigUInt64LE(289),
    rakeBps: data.readUInt32LE(297),
    rakeCap: data.readBigUInt64LE(301),
    nonsealPenaltyBps: data.readUInt32LE(309),
    minPlayers: data.readUInt8(313),
    maxPlayers: data.readUInt8(314),
    playerCount: data.readUInt8(315),
    sealedCount: data.readUInt8(316),
    // next_seal_seq (317), total_deposited (325), total_fees (333), forfeited_fees (341) skipped.
    deadMoney: data.readBigUInt64LE(349),
    settledPayout: data.readBigUInt64LE(357),
    // button_randomness (365), button (397), button_set (398), bumps (399..402) skipped.
    voidKind: voidKindFrom(data.readUInt8(402)),
  };
}

export interface DecodedSeat {
  matchKey: string;
  player: string;
  seatIndex: number;
  deposit: bigint;
  entryFeePaid: bigint;
  payout: bigint;
  claimed: boolean;
  predictionCommitment: string;
  timelockTarget: bigint;
  sealSeq: bigint;
  commitmentSet: boolean;
  isNonSealer: boolean;
  penalty: bigint;
  engineSeat: number;
  getsRemainder: boolean;
}

export function decodeSeatAccount(data: Buffer): DecodedSeat {
  if (data.length < SEAT_ACCOUNT_SIZE) {
    throw new Error(`seat account data too short: ${data.length} < ${SEAT_ACCOUNT_SIZE}`);
  }
  return {
    matchKey: new PublicKey(data.subarray(8, 40)).toBase58(),
    player: new PublicKey(data.subarray(40, 72)).toBase58(),
    seatIndex: data.readUInt16LE(72),
    deposit: data.readBigUInt64LE(74),
    entryFeePaid: data.readBigUInt64LE(82),
    payout: data.readBigUInt64LE(90),
    claimed: data.readUInt8(98) !== 0,
    predictionCommitment: data.subarray(100, 132).toString('hex'),
    timelockTarget: data.readBigUInt64LE(132),
    sealSeq: data.readBigUInt64LE(140),
    commitmentSet: data.readUInt8(148) !== 0,
    isNonSealer: data.readUInt8(149) !== 0,
    penalty: data.readBigUInt64LE(150),
    engineSeat: data.readUInt8(158),
    getsRemainder: data.readUInt8(159) !== 0,
  };
}

function statusFrom(code: number): MatchStatus {
  const s = MATCH_STATUS[code];
  if (!s) throw new Error(`unknown MatchStatus code ${code}`);
  return s;
}

function voidKindFrom(code: number): VoidKind {
  const v = VOID_KIND[code];
  if (!v) throw new Error(`unknown VoidKind code ${code}`);
  return v;
}
