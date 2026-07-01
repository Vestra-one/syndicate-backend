/**
 * On-chain custody: Anchor instruction builders + operator submit + player unsigned previews.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { anchorDiscriminator } from './actionLog.ts';
import { decodeMatchAccount } from './matchAccount.ts';

export const DEFAULT_PRICE_FEEDS = Object.freeze({
  'BTC/USD': '0xa7BaE7da3E4950700BE9f107EB186e89a474d180',
  'ETH/USD': '0x6Dd0C6a2e058bc3F7D6AaCe23965180BcBbb2635',
  'SOL/USD': '0xD31a59c85aE9D8edEFeC411D448f90841571b89c',
});

export class CustodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CustodyConfig {
  primaryRpcUrl: string;
  programId: string;
  chipsTokenMint: string;
  signerKeypairPath: string;
  confirmationTimeoutMs: number;
  maxOracleConfidence?: bigint;
  oracleExponent?: number;
}

export interface CreateMatchInput {
  matchId: string;
  onchainMatchId: number | string | bigint;
  maxPlayers: number;
  minPlayers?: number;
  tierId?: string;
  feedId?: string;
  buyIn?: number | string | bigint;
  entryFee?: number | string | bigint;
  rakeBps?: number;
  rakeCap?: number | string | bigint;
  /** Non-sealer penalty (bps of buy-in), forfeited to the pot (plan_v2 §5). */
  nonsealPenaltyBps?: number;
  configHashHex?: string;
  /** Total wall-clock betting span (Σ street durations + observations). scheduled_end_ts
   *  is derived on-chain at begin_live; this is bound into config_hash. */
  totalBettingDurationSec?: number | string | bigint;
  /** SEALING window length (plan_v2 §1). */
  sealWindowSec?: number | string | bigint;
  /** Max delay after the seal deadline for the operator to call begin_live (default 5s,
   *  plan_v2 §I). Must match the on-chain CreateParams field order. */
  beginLiveWindowSec?: number | string | bigint;
  /** Creator-selected fill window (seconds). The on-chain `fill_deadline_ts` is derived as
   *  `create_ts + fill_window_sec` and must lie within the operator-governed bounds. */
  fillWindowSec?: number | string | bigint;
  feedIdHex?: string;
}

export interface CustodyPreview {
  unsignedTxBase64: string;
  blockhash: string;
  accounts: Record<string, string>;
}

export interface MatchPdas {
  protocol: PublicKey;
  match: PublicKey;
  vault: PublicKey;
  onchainMatchId: bigint;
}

function readKeypair(path: string): Uint8Array {
  const bytes = JSON.parse(readFileSync(path, 'utf8')) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new CustodyError(500, 'settlement signer keypair file must contain 64 bytes');
  }
  return Uint8Array.from(bytes);
}

function parseU64(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && value.trim()) return BigInt(value);
  throw new CustodyError(400, `${label} must be a u64`);
}

function parseFixedHex(value: string, length: number, label: string): Buffer {
  const raw = value.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(raw)) throw new CustodyError(400, `${label} must be hex`);
  const out = Buffer.from(raw, 'hex');
  if (out.length !== length) throw new CustodyError(400, `${label} must be ${length} bytes`);
  return out;
}

function feedIdHexFor(input: CreateMatchInput): string {
  if (input.feedIdHex) return normalizeTokenHex(input.feedIdHex);
  const feed = input.feedId ?? 'BTC/USD';
  const mapped = DEFAULT_PRICE_FEEDS[feed as keyof typeof DEFAULT_PRICE_FEEDS];
  if (!mapped) throw new CustodyError(400, `unknown feedId ${feed}; pass feedIdHex`);
  return normalizeTokenHex(mapped);
}

function feedIdBuffer(hex: string): Buffer {
  return Buffer.from(normalizeTokenHex(hex).slice(2), 'hex');
}

function normalizeTokenHex(value: string): string {
  const hex = value.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new CustodyError(400, 'price token must be 20 bytes');
  return `0x${hex.toLowerCase()}`;
}

function configHashFor(input: CreateMatchInput, onchainMatchId: bigint): Buffer {
  if (input.configHashHex) {
    const hex = input.configHashHex.replace(/^0x/, '');
    if (hex.length !== 64) throw new CustodyError(400, 'configHashHex must be 32 bytes');
    return Buffer.from(hex, 'hex');
  }
  return createHash('sha256')
    .update('syndicate-custody')
    .update(String(input.tierId ?? 'tier'))
    .update(u64(onchainMatchId))
    .digest();
}

/**
 * Borsh layout MUST match `CreateParams` in services/programs (plan_v2 §A) exactly:
 * match_id, buy_in, entry_fee, rake_bps(u32), rake_cap, nonseal_penalty_bps(u32),
 * min_players(u8), max_players(u8), config_hash[32], price_token[20],
 * total_betting_duration_sec, seal_window_sec, begin_live_window_sec, fill_window_sec,
 * max_oracle_confidence, oracle_exponent(i32). (`fill_window_sec` replaced the old absolute
 * `fill_deadline_ts`; same 8-byte slot — the contract derives the deadline as now + window.)
 */
export function encodeCreateParams(input: CreateMatchInput, onchainMatchId: bigint, cfg: CustodyConfig): Buffer {
  const buyIn = parseU64(input.buyIn ?? 10_000_000, 'buyIn');
  const entryFee = parseU64(input.entryFee ?? 0, 'entryFee');
  const rakeCap = parseU64(input.rakeCap ?? buyIn, 'rakeCap');
  const minPlayers = input.minPlayers ?? 2;
  const maxPlayers = input.maxPlayers;
  const totalBettingDuration = parseU64(input.totalBettingDurationSec ?? 600, 'totalBettingDurationSec');
  const sealWindow = parseU64(input.sealWindowSec ?? 20, 'sealWindowSec');
  // 0 → on-chain DEFAULT_BEGIN_LIVE_WINDOW_SEC (5s).
  const beginLiveWindow = parseU64(input.beginLiveWindowSec ?? 5, 'beginLiveWindowSec');
  const fillWindowSec = parseU64(input.fillWindowSec ?? 300, 'fillWindowSec');
  const maxConfidence = cfg.maxOracleConfidence ?? 2n ** 64n - 1n;
  const exponent = cfg.oracleExponent ?? -18;
  return Buffer.concat([
    u64(onchainMatchId),
    u64(buyIn),
    u64(entryFee),
    u32(input.rakeBps ?? 300),
    u64(rakeCap),
    u32(input.nonsealPenaltyBps ?? 2500),
    u8(minPlayers),
    u8(maxPlayers),
    configHashFor(input, onchainMatchId),
    feedIdBuffer(feedIdHexFor(input)),
    u64(totalBettingDuration),
    u64(sealWindow),
    u64(beginLiveWindow),
    u64(fillWindowSec),
    u64(maxConfidence),
    i32(exponent),
  ]);
}

export function deriveMatchPdas(programId: PublicKey, onchainMatchId: bigint): MatchPdas {
  const matchSeed = u64(onchainMatchId);
  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], programId);
  const [match] = PublicKey.findProgramAddressSync([Buffer.from('match'), matchSeed], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), match.toBuffer()], programId);
  return { protocol, match, vault, onchainMatchId };
}

/** Seat PDA for `(match, player)` — seeds `['seat', match, player]`. */
export function deriveSeatPda(programId: PublicKey, match: PublicKey, player: PublicKey): PublicKey {
  const [seat] = PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), match.toBuffer(), player.toBuffer()],
    programId,
  );
  return seat;
}

/** Seat-index dedupe PDA for `(match, seat_index)` — seeds `['seat-index', match, u16(seat_index)]`. */
export function deriveSeatIndexPda(programId: PublicKey, match: PublicKey, seatIndex: number): PublicKey {
  const [seatIndex_] = PublicKey.findProgramAddressSync(
    [Buffer.from('seat-index'), match.toBuffer(), u16(seatIndex)],
    programId,
  );
  return seatIndex_;
}

export function buildCreateMatchInstruction(
  programId: PublicKey,
  authority: PublicKey,
  mint: PublicKey,
  pdas: MatchPdas,
  params: Buffer,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: pdas.protocol, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: pdas.match, isSigner: false, isWritable: true },
      { pubkey: pdas.vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([anchorDiscriminator('global:create_match'), params]),
  });
}

export function buildLockInstruction(
  programId: PublicKey,
  authority: PublicKey,
  protocol: PublicKey,
  match: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: protocol, isSigner: false, isWritable: false },
      { pubkey: match, isSigner: false, isWritable: true },
    ],
    data: anchorDiscriminator('global:lock'),
  });
}

/**
 * `begin_live` — operator-gated, context `AdminMatch` + every seat PDA as a writable
 * `remaining_account` (the on-chain handler requires `remaining_accounts.len() == player_count`).
 * Carries the backend-native `button_randomness[32]` (BeginLiveArgs); the button is derived
 * on-chain. `seatPdas` is the authoritative seat set (enumerate via getProgramAccounts — Phase 02).
 */
export function buildBeginLiveInstruction(
  programId: PublicKey,
  authority: PublicKey,
  protocol: PublicKey,
  match: PublicKey,
  seatPdas: PublicKey[],
  buttonRandomness: Buffer,
): TransactionInstruction {
  if (buttonRandomness.length !== 32) {
    throw new CustodyError(400, 'button_randomness must be 32 bytes');
  }
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: protocol, isSigner: false, isWritable: false },
      { pubkey: match, isSigner: false, isWritable: true },
      ...seatPdas.map((seat) => ({ pubkey: seat, isSigner: false, isWritable: true })),
    ],
    data: Buffer.concat([anchorDiscriminator('global:begin_live'), buttonRandomness]),
  });
}

/**
 * `deposit(seat_index: u16)` — PLAYER-signed (context `Deposit`). Seats the player and moves
 * `buy_in + entry_fee` into the vault. Account order mirrors `Deposit` in lib.rs exactly.
 */
export function buildDepositInstruction(
  programId: PublicKey,
  player: PublicKey,
  protocol: PublicKey,
  match: PublicKey,
  seat: PublicKey,
  seatIndexAccount: PublicKey,
  playerToken: PublicKey,
  vault: PublicKey,
  seatIndex: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: protocol, isSigner: false, isWritable: false },
      { pubkey: match, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: seatIndexAccount, isSigner: false, isWritable: true },
      { pubkey: playerToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([anchorDiscriminator('global:deposit'), u16(seatIndex)]),
  });
}

/**
 * `create_and_deposit(params: CreateParams, seat_index: u16)` — PLAYER-signed (context
 * `CreateAndDeposit`). Atomic create + seat the creator. Args are ordered params then seat_index.
 */
export function buildCreateAndDepositInstruction(
  programId: PublicKey,
  authority: PublicKey,
  mint: PublicKey,
  pdas: MatchPdas,
  seat: PublicKey,
  seatIndexAccount: PublicKey,
  playerToken: PublicKey,
  params: Buffer,
  seatIndex: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: pdas.protocol, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: pdas.match, isSigner: false, isWritable: true },
      { pubkey: pdas.vault, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: seatIndexAccount, isSigner: false, isWritable: true },
      { pubkey: playerToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([anchorDiscriminator('global:create_and_deposit'), params, u16(seatIndex)]),
  });
}

/**
 * `register_prediction_commitment(args)` — PLAYER-signed (context `RegisterPredictionCommitment`).
 * The player's own wallet signature IS the explicit seal (no session key). Args:
 * `commitment[32] || timelock_target(u64)`.
 */
export function buildRegisterPredictionCommitmentInstruction(
  programId: PublicKey,
  player: PublicKey,
  match: PublicKey,
  seat: PublicKey,
  commitment: Buffer,
  timelockTarget: bigint,
): TransactionInstruction {
  if (commitment.length !== 32) {
    throw new CustodyError(400, 'commitment must be 32 bytes');
  }
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: match, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      anchorDiscriminator('global:register_prediction_commitment'),
      commitment,
      u64(timelockTarget),
    ]),
  });
}

/** `void_before_start` — permissionless (context `PermissionlessVoidPreStart`); match PDA only. */
export function buildVoidBeforeStartInstruction(
  programId: PublicKey,
  match: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: match, isSigner: false, isWritable: true }],
    data: anchorDiscriminator('global:void_before_start'),
  });
}

/** `void_live_after_deadline` — permissionless (context `PermissionlessVoidLive`); match PDA only. */
export function buildVoidLiveAfterDeadlineInstruction(
  programId: PublicKey,
  match: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: match, isSigner: false, isWritable: true }],
    data: anchorDiscriminator('global:void_live_after_deadline'),
  });
}

export function buildWithdrawFeesInstruction(
  programId: PublicKey,
  authority: PublicKey,
  protocol: PublicKey,
  match: PublicKey,
  vault: PublicKey,
  treasuryToken: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: protocol, isSigner: false, isWritable: false },
      { pubkey: match, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: treasuryToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator('global:withdraw_fees'),
  });
}

export interface BeginLiveInput {
  onchainMatchId: bigint;
  /** Seat owner wallets (the full sealed+unsealed set). Seat PDAs are derived from these.
   *  The authoritative set is the on-chain seats (enumerate via getProgramAccounts — Phase 02). */
  seatWallets: string[];
  /** Optional 32-byte hex randomness; if omitted the server generates a CSPRNG value. */
  buttonRandomnessHex?: string;
}

export async function submitBeginLive(cfg: CustodyConfig, input: BeginLiveInput) {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const signer = operatorSigner(cfg);
  const pdas = deriveMatchPdas(programId, input.onchainMatchId);
  if (!Array.isArray(input.seatWallets) || input.seatWallets.length === 0) {
    throw new CustodyError(400, 'begin_live requires the full seat-wallet set');
  }
  const seatPdas = input.seatWallets.map((w) =>
    deriveSeatPda(programId, pdas.match, new PublicKey(w)),
  );
  const buttonRandomness = input.buttonRandomnessHex
    ? parseFixedHex(input.buttonRandomnessHex, 32, 'buttonRandomness')
    : randomBytes(32);
  if (buttonRandomness.equals(Buffer.alloc(32))) {
    throw new CustodyError(400, 'button_randomness must not be all zeros');
  }
  const tx = new Transaction().add(
    buildBeginLiveInstruction(programId, signer.publicKey, pdas.protocol, pdas.match, seatPdas, buttonRandomness),
  );
  const txSig = await sendSignedLegacyTx(connection, signer, tx, cfg.confirmationTimeoutMs);
  // Read back the on-chain outcome: the button (engine-seat index) the contract derived, plus the
  // stamped live_start_ts / scheduled_end_ts the engine + caller (DB persistence) need.
  const info = await connection.getAccountInfo(pdas.match, 'confirmed');
  const m = info?.data ? decodeMatchAccount(info.data as Buffer) : undefined;
  return {
    ok: true as const,
    txSig,
    tx_sig: txSig,
    buttonRandomnessHex: buttonRandomness.toString('hex'),
    seatCount: seatPdas.length,
    button: m?.button ?? null,
    status: m?.status ?? null,
    liveStartTs: m ? m.liveStartTs.toString() : null,
    scheduledEndTs: m ? m.scheduledEndTs.toString() : null,
  };
}

/** Permissionless pre-start void (server may relay it; anyone can call on-chain). */
export async function submitVoidBeforeStart(cfg: CustodyConfig, onchainMatchId: bigint) {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const signer = operatorSigner(cfg);
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  // Idempotent: if the match account was never created on-chain (e.g. matchmaking registered a
  // room that was never backed by an on-chain tx), there is nothing to void.
  const info = await connection.getAccountInfo(pdas.match, 'confirmed');
  if (!info) {
    return { ok: true as const, txSig: null, tx_sig: null, matchPda: pdas.match.toBase58(), skipped: 'not_found' as const };
  }
  const tx = new Transaction().add(buildVoidBeforeStartInstruction(programId, pdas.match));
  const txSig = await sendSignedLegacyTx(connection, signer, tx, cfg.confirmationTimeoutMs);
  return { ok: true as const, txSig, tx_sig: txSig, matchPda: pdas.match.toBase58() };
}

/** Permissionless live-after-deadline void backstop (server may relay it; anyone can call). */
export async function submitVoidLiveAfterDeadline(cfg: CustodyConfig, onchainMatchId: bigint) {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const signer = operatorSigner(cfg);
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const info = await connection.getAccountInfo(pdas.match, 'confirmed');
  if (!info) {
    return { ok: true as const, txSig: null, tx_sig: null, matchPda: pdas.match.toBase58(), skipped: 'not_found' as const };
  }
  const tx = new Transaction().add(buildVoidLiveAfterDeadlineInstruction(programId, pdas.match));
  const txSig = await sendSignedLegacyTx(connection, signer, tx, cfg.confirmationTimeoutMs);
  return { ok: true as const, txSig, tx_sig: txSig, matchPda: pdas.match.toBase58() };
}

export async function submitWithdrawFees(
  cfg: CustodyConfig,
  onchainMatchId: bigint,
  treasuryToken: string,
) {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const signer = operatorSigner(cfg);
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const treasury = new PublicKey(treasuryToken);
  const tx = new Transaction().add(
    buildWithdrawFeesInstruction(
      programId,
      signer.publicKey,
      pdas.protocol,
      pdas.match,
      pdas.vault,
      treasury,
    ),
  );
  const txSig = await sendSignedLegacyTx(connection, signer, tx, cfg.confirmationTimeoutMs);
  return { ok: true as const, txSig };
}

export function buildClaimOrRefundInstruction(
  programId: PublicKey,
  name: 'claim' | 'refund',
  player: PublicKey,
  match: PublicKey,
  seat: PublicKey,
  seatIndexAccount: PublicKey,
  vault: PublicKey,
  playerToken: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: match, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: seatIndexAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: playerToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator(`global:${name}`),
  });
}

async function connectionFor(cfg: CustodyConfig): Promise<Connection> {
  return new Connection(cfg.primaryRpcUrl, 'confirmed');
}

function operatorSigner(cfg: CustodyConfig): Keypair {
  return Keypair.fromSecretKey(readKeypair(cfg.signerKeypairPath));
}

export async function submitCreateMatch(cfg: CustodyConfig, input: CreateMatchInput) {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const mint = new PublicKey(cfg.chipsTokenMint);
  const signer = operatorSigner(cfg);
  const onchainMatchId = parseU64(input.onchainMatchId, 'onchainMatchId');
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const params = encodeCreateParams(input, onchainMatchId, cfg);
  const tx = new Transaction().add(
    buildCreateMatchInstruction(programId, signer.publicKey, mint, pdas, params),
  );
  const txSig = await sendSignedLegacyTx(connection, signer, tx, cfg.confirmationTimeoutMs);
  return {
    ok: true as const,
    txSig,
    tx_sig: txSig,
    onchainMatchId: onchainMatchId.toString(),
    matchPda: pdas.match.toBase58(),
    vaultPda: pdas.vault.toBase58(),
    protocolPda: pdas.protocol.toBase58(),
  };
}

export async function submitLockMatch(cfg: CustodyConfig, body: {
  match?: { onchainMatchId?: unknown };
  onchainMatchId?: unknown;
  matchId?: string;
  programId?: string;
}) {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(body.programId ?? cfg.programId);
  const signer = operatorSigner(cfg);
  let onchainRaw = body.match?.onchainMatchId ?? body.onchainMatchId;
  if (onchainRaw === undefined && body.matchId) {
    onchainRaw = hashMatchId(body.matchId);
  }
  const onchainMatchId = parseU64(onchainRaw, 'onchainMatchId');
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const tx = new Transaction().add(
    buildLockInstruction(programId, signer.publicKey, pdas.protocol, pdas.match),
  );
  const txSig = await sendSignedLegacyTx(connection, signer, tx, cfg.confirmationTimeoutMs);
  return { ok: true as const, txSig, tx_sig: txSig, matchPda: pdas.match.toBase58() };
}

export async function buildClaimPreview(
  cfg: CustodyConfig,
  matchId: string,
  wallet: string,
  onchainMatchId?: bigint | string | number,
): Promise<CustodyPreview> {
  return buildPlayerCustodyPreview(cfg, 'claim', matchId, wallet, onchainMatchId);
}

export async function buildRefundPreview(
  cfg: CustodyConfig,
  matchId: string,
  wallet: string,
  onchainMatchId?: bigint | string | number,
): Promise<CustodyPreview> {
  return buildPlayerCustodyPreview(cfg, 'refund', matchId, wallet, onchainMatchId);
}

async function buildPlayerCustodyPreview(
  cfg: CustodyConfig,
  ixName: 'claim' | 'refund',
  _matchId: string,
  wallet: string,
  onchainMatchIdInput?: bigint | string | number,
): Promise<CustodyPreview> {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const player = new PublicKey(wallet);
  const onchainMatchId = onchainMatchIdInput === undefined
    ? parseU64(_matchId, 'onchainMatchId')
    : parseU64(onchainMatchIdInput, 'onchainMatchId');
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const [seat] = PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), pdas.match.toBuffer(), player.toBuffer()],
    programId,
  );
  const seatInfo = await connection.getAccountInfo(seat);
  if (!seatInfo?.data || seatInfo.data.length < 8 + 32 + 32 + 2) {
    throw new CustodyError(404, 'seat account not found; deposit first');
  }
  const seatIndex = seatInfo.data.readUInt16LE(8 + 32 + 32);
  const [seatIndexAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('seat-index'), pdas.match.toBuffer(), u16(seatIndex)],
    programId,
  );
  const mint = new PublicKey(cfg.chipsTokenMint);
  const playerToken = getAssociatedTokenAddressSync(mint, player);
  const ix = buildClaimOrRefundInstruction(
    programId,
    ixName,
    player,
    pdas.match,
    seat,
    seatIndexAccount,
    pdas.vault,
    playerToken,
  );
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(ix);
  tx.feePayer = player;
  tx.recentBlockhash = latest.blockhash;
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    unsignedTxBase64: serialized.toString('base64'),
    blockhash: latest.blockhash,
    accounts: {
      matchPda: pdas.match.toBase58(),
      vaultPda: pdas.vault.toBase58(),
      seat: seat.toBase58(),
      seatIndexAccount: seatIndexAccount.toBase58(),
      wallet: player.toBase58(),
      playerToken: playerToken.toBase58(),
    },
  };
}

/**
 * Unsigned `deposit` tx for the joining player to sign (player is the Signer — not the operator).
 * Mirrors `buildPlayerCustodyPreview`: returns an unsigned, fee-payer=player serialized tx.
 */
export async function buildDepositPreview(
  cfg: CustodyConfig,
  wallet: string,
  seatIndex: number,
  onchainMatchId: bigint | string | number,
): Promise<CustodyPreview> {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const player = new PublicKey(wallet);
  const id = parseU64(onchainMatchId, 'onchainMatchId');
  const pdas = deriveMatchPdas(programId, id);
  const seat = deriveSeatPda(programId, pdas.match, player);
  const seatIndexAccount = deriveSeatIndexPda(programId, pdas.match, seatIndex);
  const mint = new PublicKey(cfg.chipsTokenMint);
  const playerToken = getAssociatedTokenAddressSync(mint, player);
  const ix = buildDepositInstruction(
    programId, player, pdas.protocol, pdas.match, seat, seatIndexAccount, playerToken, pdas.vault, seatIndex,
  );
  return previewFor(connection, ix, player, {
    matchPda: pdas.match.toBase58(),
    vaultPda: pdas.vault.toBase58(),
    seat: seat.toBase58(),
    seatIndexAccount: seatIndexAccount.toBase58(),
    wallet: player.toBase58(),
    playerToken: playerToken.toBase58(),
  });
}

/**
 * Unsigned `create_and_deposit` tx for the host to sign (host is the Signer). Atomic create +
 * seat the creator. Account constraints reference the passed mint (match.mint is zeroed pre-handler).
 */
export async function buildCreateAndDepositPreview(
  cfg: CustodyConfig,
  input: CreateMatchInput & { wallet: string; seatIndex: number },
): Promise<CustodyPreview> {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const authority = new PublicKey(input.wallet);
  const onchainMatchId = parseU64(input.onchainMatchId, 'onchainMatchId');
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const seat = deriveSeatPda(programId, pdas.match, authority);
  const seatIndexAccount = deriveSeatIndexPda(programId, pdas.match, input.seatIndex);
  const mint = new PublicKey(cfg.chipsTokenMint);
  const playerToken = getAssociatedTokenAddressSync(mint, authority);
  const params = encodeCreateParams(input, onchainMatchId, cfg);
  const ix = buildCreateAndDepositInstruction(
    programId, authority, mint, pdas, seat, seatIndexAccount, playerToken, params, input.seatIndex,
  );
  return previewFor(connection, ix, authority, {
    matchPda: pdas.match.toBase58(),
    vaultPda: pdas.vault.toBase58(),
    seat: seat.toBase58(),
    seatIndexAccount: seatIndexAccount.toBase58(),
    wallet: authority.toBase58(),
    playerToken: playerToken.toBase58(),
  });
}

/**
 * Unsigned `register_prediction_commitment` tx for the player to sign during Sealing (the player's
 * own wallet signature IS the explicit seal). `commitmentHex` = 32-byte ciphertext-hash.
 */
export async function buildRegisterCommitmentPreview(
  cfg: CustodyConfig,
  wallet: string,
  commitmentHex: string,
  timelockTarget: bigint | string | number,
  onchainMatchId: bigint | string | number,
): Promise<CustodyPreview> {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const player = new PublicKey(wallet);
  const id = parseU64(onchainMatchId, 'onchainMatchId');
  const pdas = deriveMatchPdas(programId, id);
  const seat = deriveSeatPda(programId, pdas.match, player);
  const commitment = parseFixedHex(commitmentHex, 32, 'commitment');
  const ix = buildRegisterPredictionCommitmentInstruction(
    programId, player, pdas.match, seat, commitment, parseU64(timelockTarget, 'timelockTarget'),
  );
  return previewFor(connection, ix, player, {
    matchPda: pdas.match.toBase58(),
    seat: seat.toBase58(),
    wallet: player.toBase58(),
  });
}

/** Serialize an unsigned, fee-payer=signer tx for a client to sign. */
async function previewFor(
  connection: Connection,
  ix: TransactionInstruction,
  feePayer: PublicKey,
  accounts: Record<string, string>,
): Promise<CustodyPreview> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(ix);
  tx.feePayer = feePayer;
  tx.recentBlockhash = latest.blockhash;
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return { unsignedTxBase64: serialized.toString('base64'), blockhash: latest.blockhash, accounts };
}

export async function settlementStatus(
  cfg: CustodyConfig,
  matchId: string,
  wallet?: string,
  onchainMatchId?: bigint | string | number,
) {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const id = parseU64(onchainMatchId ?? matchId, 'onchainMatchId');
  const pdas = deriveMatchPdas(programId, id);
  const info = await connection.getAccountInfo(pdas.match);
  const statusNames = ['FILLING', 'SEALING', 'LIVE', 'SETTLED', 'VOID'] as const;
  let status: string = 'UNKNOWN';
  if (info?.data && info.data.length > 120) {
    const code = info.data.readUInt8(120);
    status = statusNames[code] ?? 'UNKNOWN';
  }
  const claimable = status === 'SETTLED';
  const voidRefundable = status === 'VOID';
  return {
    matchId,
    onchainMatchId: id.toString(),
    matchPda: pdas.match.toBase58(),
    status,
    payoutByWallet: wallet ? { [wallet]: 0 } : {},
    claimable,
    voidRefundable,
  };
}

async function sendSignedLegacyTx(
  connection: Connection,
  signer: Keypair,
  tx: Transaction,
  confirmationTimeoutMs: number,
): Promise<string> {
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    throw new CustodyError(422, `transaction simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'processed',
  });
  await withTimeout(
    connection.confirmTransaction({ signature, ...latest }, 'confirmed'),
    confirmationTimeoutMs,
    `confirmation timeout for ${signature}`,
  );
  return signature;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new CustodyError(504, message)), ms)),
  ]);
}

function u8(value: number): Buffer {
  const out = Buffer.alloc(1);
  out.writeUInt8(value);
  return out;
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function i32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeInt32LE(value);
  return out;
}

export function hashMatchId(matchId: string): bigint {
  let hash = 0n;
  for (let i = 0; i < matchId.length; i += 1) {
    hash = (hash * 31n + BigInt(matchId.charCodeAt(i))) & ((1n << 64n) - 1n);
  }
  return hash;
}

/** @deprecated use submitCreateMatch — kept for unit tests of param encoding */
export function buildCreateMatchPreview(input: CreateMatchInput): { ok: true; preview: CustodyPreview } {
  const onchainMatchId = parseU64(input.onchainMatchId, 'onchainMatchId');
  const programId = new PublicKey(process.env.SYNDICATE_PROGRAM_ID ?? 'FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS');
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const params = encodeCreateParams(input, onchainMatchId, {
    primaryRpcUrl: 'http://127.0.0.1:8899',
    programId: programId.toBase58(),
    chipsTokenMint: PublicKey.default.toBase58(),
    signerKeypairPath: '/dev/null',
    confirmationTimeoutMs: 30_000,
  });
  const ix = buildCreateMatchInstruction(
    programId,
    PublicKey.default,
    PublicKey.default,
    pdas,
    params,
  );
  return {
    ok: true,
    preview: {
      unsignedTxBase64: ix.data.toString('base64'),
      blockhash: 'preview',
      accounts: {
        matchPda: pdas.match.toBase58(),
        vaultPda: pdas.vault.toBase58(),
        protocolPda: pdas.protocol.toBase58(),
      },
    },
  };
}

/** @deprecated use buildClaimPreview async */
export function buildLockMatchPreview(matchId: string): CustodyPreview {
  const programId = new PublicKey(process.env.SYNDICATE_PROGRAM_ID ?? 'FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS');
  const pdas = deriveMatchPdas(programId, parseU64(matchId, 'matchId'));
  return {
    unsignedTxBase64: anchorDiscriminator('global:lock').toString('base64'),
    blockhash: 'preview',
    accounts: { matchPda: pdas.match.toBase58() },
  };
}
