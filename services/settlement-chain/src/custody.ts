/**
 * On-chain custody: Anchor instruction builders + operator submit + player unsigned previews.
 */

import { createHash } from 'node:crypto';
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
import { normalizeFeedIdHex } from './pyth.ts';

export const DEFAULT_PRICE_FEEDS = Object.freeze({
  'BTC/USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'SOL/USD': '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
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
  oracleDelayWindowSec?: bigint;
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
  configHashHex?: string;
  scheduledEndTs?: number | string | bigint;
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

function feedIdHexFor(input: CreateMatchInput): string {
  if (input.feedIdHex) return normalizeFeedIdHex(input.feedIdHex);
  const feed = input.feedId ?? 'BTC/USD';
  const mapped = DEFAULT_PRICE_FEEDS[feed as keyof typeof DEFAULT_PRICE_FEEDS];
  if (!mapped) throw new CustodyError(400, `unknown feedId ${feed}; pass feedIdHex`);
  return normalizeFeedIdHex(mapped);
}

function feedIdBuffer(hex: string): Buffer {
  return Buffer.from(normalizeFeedIdHex(hex).slice(2), 'hex');
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

export function encodeCreateParams(input: CreateMatchInput, onchainMatchId: bigint, cfg: CustodyConfig): Buffer {
  const buyIn = parseU64(input.buyIn ?? 10_000_000, 'buyIn');
  const entryFee = parseU64(input.entryFee ?? 0, 'entryFee');
  const rakeCap = parseU64(input.rakeCap ?? buyIn, 'rakeCap');
  const minPlayers = input.minPlayers ?? 2;
  const maxPlayers = input.maxPlayers;
  const scheduledEndTs = parseU64(
    input.scheduledEndTs ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
    'scheduledEndTs',
  );
  const oracleDelay = cfg.oracleDelayWindowSec ?? 5n;
  const maxConfidence = cfg.maxOracleConfidence ?? 2n ** 64n - 1n;
  const exponent = cfg.oracleExponent ?? -8;
  return Buffer.concat([
    u64(onchainMatchId),
    u64(buyIn),
    u64(entryFee),
    u32(input.rakeBps ?? 300),
    u64(rakeCap),
    u8(minPlayers),
    u8(maxPlayers),
    configHashFor(input, onchainMatchId),
    feedIdBuffer(feedIdHexFor(input)),
    u64(scheduledEndTs),
    u64(oracleDelay),
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

export function buildBeginLiveInstruction(
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
    data: anchorDiscriminator('global:begin_live'),
  });
}

export function buildSetButtonSeedInstruction(
  programId: PublicKey,
  authority: PublicKey,
  protocol: PublicKey,
  match: PublicKey,
  vrfSeed: Buffer,
  vrfProofHash: Buffer,
): TransactionInstruction {
  const params = Buffer.concat([vrfSeed, vrfProofHash]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: protocol, isSigner: false, isWritable: false },
      { pubkey: match, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([anchorDiscriminator('global:set_button_seed'), params]),
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

export async function submitSetButtonSeed(
  cfg: CustodyConfig,
  onchainMatchId: bigint,
  vrfSeedHex: string,
  vrfProofHashHex: string,
) {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const signer = operatorSigner(cfg);
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const vrfSeed = Buffer.from(vrfSeedHex.replace(/^0x/, ''), 'hex');
  const vrfProofHash = Buffer.from(vrfProofHashHex.replace(/^0x/, ''), 'hex');
  if (vrfSeed.length !== 32 || vrfProofHash.length !== 32) {
    throw new CustodyError(400, 'vrf seed and proof hash must be 32 bytes');
  }
  const tx = new Transaction().add(
    buildSetButtonSeedInstruction(programId, signer.publicKey, pdas.protocol, pdas.match, vrfSeed, vrfProofHash),
  );
  const txSig = await sendSignedLegacyTx(connection, signer, tx, cfg.confirmationTimeoutMs);
  return { ok: true as const, txSig, button: Number(vrfSeed.readBigUInt64LE(0) % BigInt(3)) };
}

export async function submitBeginLive(cfg: CustodyConfig, onchainMatchId: bigint) {
  const connection = await connectionFor(cfg);
  const programId = new PublicKey(cfg.programId);
  const signer = operatorSigner(cfg);
  const pdas = deriveMatchPdas(programId, onchainMatchId);
  const tx = new Transaction().add(
    buildBeginLiveInstruction(programId, signer.publicKey, pdas.protocol, pdas.match),
  );
  const txSig = await sendSignedLegacyTx(connection, signer, tx, cfg.confirmationTimeoutMs);
  return { ok: true as const, txSig };
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
