/**
 * Phase 11 — devnet lifecycle signing client.
 *
 * The operator-provided signing client the e2e gate needs: it owns the wallet key material and
 * builds/sends the real v1 instructions against a deployed devnet program. It is the layer the
 * `devnet-lifecycle.test.ts` harness documented as "plug E2E_PAYER_KEYPAIR + IDL to complete
 * steps 1–6". This module IS that client.
 *
 * It drives the on-chain lifecycle directly (the actual custody/settlement gate — in v1 the HTTP
 * services only verify client-reported txhashes and keep a registry, they never custody funds):
 *
 *   happy path: create_and_deposit → deposit → lock → register_prediction_commitment ×N →
 *               begin_live(randomness + seats) → submit_settlement(signed price) → claim ×N
 *   void path:  create_and_deposit → (past fill_deadline) → void_before_start → refund
 *
 * and asserts the vault SPL-token balance drains to exactly 0 at each terminal state.
 *
 * Encodings (discriminators, account orderings, borsh args, PDA seeds) are derived from the
 * deployed program's instruction handlers (services/programs/.../lib.rs) and the IDL. The signed
 * price is produced locally with an e2e-controlled secp256k1 key after rotating the protocol's
 * `price_signer` to that key's Ethereum address via `set_price_signer` — so the full settlement
 * path is exercisable without the external signed-price-server.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';

// ---- drand timelock constants (mirror lib.rs) ----
const DRAND_GENESIS_TIME = 1_692_803_367n;
const DRAND_PERIOD_SEC = 3n;
const MAX_TIMELOCK_SKEW_SEC = 20n;
// Hardcoded in signed_price.rs; the match's oracle_exponent must equal this.
const SIGNED_PRICE_EXPONENT = -18;

export const MATCH_STATUS = { Filling: 0, Sealing: 1, Live: 2, Settled: 3, Void: 4 };

// MatchAccount field byte offsets (from state.rs layout).
const M_OFF = { status: 120, seal_deadline_ts: 189, scheduled_end_ts: 205 };
// SeatAccount field byte offsets.
const S_OFF = { seat_index: 72, commitment_set: 148, engine_seat: 158 };

export function loadConfig(env = process.env) {
  const programId = new PublicKey(env.PROGRAM_ID ?? '8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX');
  return {
    rpcUrl: env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
    programId,
    keysFile: env.SYNDICATE_DEVNET_KEYS_FILE ?? 'devnet_testing_keys.md',
    operatorKeypairPath: env.E2E_OPERATOR_KEYPAIR ?? env.DEPLOYER_KEYPAIR ?? `${homedir()}/.config/solana/id.json`,
    chipsDecimals: intEnv(env, 'E2E_CHIPS_DECIMALS', 6),
    buyIn: bigEnv(env, 'E2E_BUY_IN', 1_000_000n),
    mintAmount: bigEnv(env, 'E2E_PLAYER_MINT_AMOUNT', 10_000_000n),
    sealWindowSec: bigEnv(env, 'E2E_SEAL_WINDOW_SEC', 20n),
    beginLiveWindowSec: bigEnv(env, 'E2E_BEGIN_LIVE_WINDOW_SEC', 120n),
    totalBettingSec: bigEnv(env, 'E2E_TOTAL_BETTING_SEC', 3n),
    nonsealPenaltyBps: intEnv(env, 'E2E_NONSEAL_PENALTY_BPS', 2500),
    interTxDelayMs: intEnv(env, 'E2E_INTER_TX_DELAY_MS', 1500),
    rpcRetries: intEnv(env, 'E2E_RPC_RETRIES', 8),
    rpcRetryBaseMs: intEnv(env, 'E2E_RPC_RETRY_BASE_MS', 750),
    minPlayerSol: bigEnv(env, 'E2E_MIN_PLAYER_LAMPORTS', 80_000_000n), // 0.08 SOL
  };
}

// ============================================================================
// Top-level lifecycle entry points
// ============================================================================

/** Run both gates (happy + void). Returns a structured result for assertions. */
export async function runDevnetGate(env = process.env, log = console.log) {
  const cfg = loadConfig(env);
  const connection = new Connection(cfg.rpcUrl, 'confirmed');
  const ctx = await setup(connection, cfg, log);
  const happy = await runHappyPath(connection, cfg, ctx, log);
  const voided = await runVoidPath(connection, cfg, ctx, log);
  return { happy, voided };
}

async function setup(connection, cfg, log) {
  const operator = loadKeypairFile(cfg.operatorKeypairPath);
  const players = parseKeypairs(cfg.keysFile);
  if (players.length < 2) throw new Error(`${cfg.keysFile} must contain at least two keypairs`);
  const [playerA, playerB] = players;

  log(`cluster:  ${cfg.rpcUrl}`);
  log(`program:  ${cfg.programId.toBase58()}`);
  log(`operator: ${operator.publicKey.toBase58()} (admin/settlement)`);
  log(`playerA:  ${playerA.publicKey.toBase58()} (host, seat 0)`);
  log(`playerB:  ${playerB.publicKey.toBase58()} (joiner, seat 1)`);

  await requireProgram(connection, cfg.programId);
  const [protocolPda] = pda(cfg.programId, [Buffer.from('protocol')]);
  await requireInitialized(connection, protocolPda, 'protocol_state');

  // Ensure players can pay tx fees + PDA rent (top up from the operator if short).
  for (const [label, p] of [['playerA', playerA], ['playerB', playerB]]) {
    await ensureLamports(connection, cfg, operator, p.publicKey, label, log);
  }

  // Fresh chips mint each run (operator is mint authority); mint test chips to both players.
  const mint = Keypair.generate();
  await createChipsMint(connection, cfg, operator, mint, log);
  const ataA = await createAtaAndMint(connection, cfg, operator, mint.publicKey, playerA.publicKey, log);
  const ataB = await createAtaAndMint(connection, cfg, operator, mint.publicKey, playerB.publicKey, log);
  log(`chips mint: ${mint.publicKey.toBase58()}`);

  // Treasury ATA (operator-owned) for any withdraw_fees calls.
  const treasuryAta = getAssociatedTokenAddressSync(mint.publicKey, operator.publicKey, false, TOKEN_PROGRAM_ID);

  // Rotate price_signer to an e2e-controlled secp256k1 key so we can sign settlement prices.
  const signer = newEthSigner();
  await sendTx(connection, cfg, operator, 'set_price_signer', [
    setPriceSignerIx(cfg.programId, operator.publicKey, protocolPda, signer.address),
  ], [], log);
  log(`price_signer rotated → 0x${Buffer.from(signer.address).toString('hex')}`);

  return { operator, playerA, playerB, protocolPda, mint, ataA, ataB, treasuryAta, signer };
}

async function runHappyPath(connection, cfg, ctx, log) {
  log('\n=== HAPPY PATH: create → deposit → seal → begin_live → settle → claim ===');
  const matchId = BigInt(Math.floor(Date.now() / 1000));
  const priceToken = Buffer.alloc(20, 0x07);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const m = matchPdas(cfg.programId, matchId, [ctx.playerA.publicKey, ctx.playerB.publicKey]);

  // 1. Host create_and_deposit (seat 0).
  await sendTx(connection, cfg, ctx.playerA, 'create_and_deposit', [
    createAndDepositIx(cfg, ctx, m, {
      matchId, priceToken, fillDeadlineTs: now + 3600n, seatIndex: 0, player: ctx.playerA.publicKey, ata: ctx.ataA,
    }),
  ], [], log);

  // 2. Joiner deposit (seat 1).
  await sendTx(connection, cfg, ctx.playerB, 'deposit', [
    depositIx(cfg, ctx, m, { player: ctx.playerB.publicKey, ata: ctx.ataB, seatIndex: 1 }),
  ], [], log);

  // 3. Operator lock → Sealing (derives seal_deadline_ts).
  await sendTx(connection, cfg, ctx.operator, 'lock', [
    adminMatchIx(cfg.programId, 'lock', ctx.operator.publicKey, ctx.protocolPda, m.matchPda),
  ], [], log);

  const sealDeadline = await readU64(connection, cfg, m.matchPda, M_OFF.seal_deadline_ts);
  const timelockTarget = pickTimelockTarget(sealDeadline, cfg);
  log(`seal_deadline_ts=${sealDeadline} timelock_target_round=${timelockTarget}`);

  // 4. Both players seal (register_prediction_commitment during Sealing). v1 stores the
  //    commitment hash only; it is not re-derived on-chain, so a random 32-byte hash is valid.
  for (const [player, seat] of [[ctx.playerA, m.seats[0]], [ctx.playerB, m.seats[1]]]) {
    await sendTx(connection, cfg, player, 'register_prediction_commitment', [
      registerCommitmentIx(cfg.programId, player.publicKey, m.matchPda, seat, randomBytes(32), timelockTarget),
    ], [], log);
  }

  // 5. Wait for the seal deadline, then begin_live within begin_live_window_sec.
  await waitUntilUnix(sealDeadline + 1n, log);
  const buttonRandomness = randomBytes(32);
  buttonRandomness[0] = buttonRandomness[0] || 1;
  await sendTx(connection, cfg, ctx.operator, 'begin_live', [
    beginLiveIx(cfg.programId, ctx.operator.publicKey, ctx.protocolPda, m.matchPda, buttonRandomness, m.seats),
  ], [], log);

  // 6. Build + sign the settlement price at exactly scheduled_end_ts; submit settlement.
  const scheduledEnd = await readU64(connection, cfg, m.matchPda, M_OFF.scheduled_end_ts);
  const engineSeats = await readEngineSeats(connection, cfg, m.seats);
  // v1 trusts backend payouts; conservation requires Σpayout == sealed*buy_in + dead_money - rake.
  // Two sealers, rake 0, no penalty pool: winner takes the whole 2×buy_in pot.
  const pot = 2n * cfg.buyIn;
  const payouts = engineSeats.map((engineSeat, i) => ({ engineSeat, amount: i === 0 ? pot : 0n }));
  const signed = signPrice(ctx.signer, priceToken, 60_000n * 10n ** 18n, scheduledEnd * 1000n);
  await sendTx(connection, cfg, ctx.operator, 'submit_settlement', [
    submitSettlementIx(cfg.programId, ctx.operator.publicKey, ctx.protocolPda, m.matchPda, signed, 0n, payouts, m.seats),
  ], [], log);

  // 7. Both players claim.
  await sendTx(connection, cfg, ctx.playerA, 'claim', [
    claimIx(cfg.programId, 'claim', ctx.playerA.publicKey, m, m.seats[0], m.seatIndexes[0], ctx.ataA),
  ], [], log);
  await sendTx(connection, cfg, ctx.playerB, 'claim', [
    claimIx(cfg.programId, 'claim', ctx.playerB.publicKey, m, m.seats[1], m.seatIndexes[1], ctx.ataB),
  ], [], log);

  // Assertions: terminal status Settled + vault drained to exactly 0 (rake/entry_fee 0 ⇒ no fees left).
  const status = await readU8(connection, cfg, m.matchPda, M_OFF.status);
  const vaultBal = await vaultTokenBalance(connection, cfg, m.vaultPda);
  assertEq(status, MATCH_STATUS.Settled, `happy: match status (Settled)`);
  assertEq(vaultBal, 0n, `happy: vault token balance drains to 0`);
  log(`✅ happy path: status=Settled, vault=0  match_id=${matchId} ${m.matchPda.toBase58()}`);
  return { matchId: matchId.toString(), matchPda: m.matchPda.toBase58(), vaultPda: m.vaultPda.toBase58(), status, vaultBal: vaultBal.toString() };
}

async function runVoidPath(connection, cfg, ctx, log) {
  log('\n=== VOID PATH: create → past fill_deadline → void_before_start → refund ===');
  const matchId = BigInt(Math.floor(Date.now() / 1000)) + 1n;
  const priceToken = Buffer.alloc(20, 0x07);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const fillDeadlineTs = now + 12n; // short, so we can wait it out
  const m = matchPdas(cfg.programId, matchId, [ctx.playerA.publicKey]);

  // 1. Host create_and_deposit only — never reach min_players, so it cannot lock.
  await sendTx(connection, cfg, ctx.playerA, 'create_and_deposit', [
    createAndDepositIx(cfg, ctx, m, {
      matchId, priceToken, fillDeadlineTs, seatIndex: 0, player: ctx.playerA.publicKey, ata: ctx.ataA,
    }),
  ], [], log);

  // 2. Wait past fill_deadline_ts, then permissionless void_before_start (operator pays the fee).
  await waitUntilUnix(fillDeadlineTs + 2n, log);
  await sendTx(connection, cfg, ctx.operator, 'void_before_start', [
    voidBeforeStartIx(cfg.programId, m.matchPda),
  ], [], log);

  // 3. Depositor refunds (full deposit + entry fee for a pre-LIVE void).
  await sendTx(connection, cfg, ctx.playerA, 'refund', [
    claimIx(cfg.programId, 'refund', ctx.playerA.publicKey, m, m.seats[0], m.seatIndexes[0], ctx.ataA),
  ], [], log);

  const status = await readU8(connection, cfg, m.matchPda, M_OFF.status);
  const vaultBal = await vaultTokenBalance(connection, cfg, m.vaultPda);
  assertEq(status, MATCH_STATUS.Void, `void: match status (Void)`);
  assertEq(vaultBal, 0n, `void: vault token balance drains to 0`);
  log(`✅ void path: status=Void, vault=0  match_id=${matchId} ${m.matchPda.toBase58()}`);
  return { matchId: matchId.toString(), matchPda: m.matchPda.toBase58(), vaultPda: m.vaultPda.toBase58(), status, vaultBal: vaultBal.toString() };
}

// ============================================================================
// PDA derivation
// ============================================================================

function pda(programId, seeds) {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function matchPdas(programId, matchId, players) {
  const [matchPda] = pda(programId, [Buffer.from('match'), u64(matchId)]);
  const [vaultPda] = pda(programId, [Buffer.from('vault'), matchPda.toBuffer()]);
  const seats = players.map((p) => pda(programId, [Buffer.from('seat'), matchPda.toBuffer(), p.toBuffer()])[0]);
  const seatIndexes = players.map((_, i) => pda(programId, [Buffer.from('seat-index'), matchPda.toBuffer(), u16(i)])[0]);
  return { matchPda, vaultPda, seats, seatIndexes };
}

// ============================================================================
// Instruction builders (discriminator = sha256("global:<name>")[..8])
// ============================================================================

function disc(name) {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function ix(programId, name, keys, data = Buffer.alloc(0)) {
  return new TransactionInstruction({ programId, keys, data: Buffer.concat([disc(name), data]) });
}

const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

function setPriceSignerIx(programId, authority, protocolPda, address20) {
  return ix(programId, 'set_price_signer', [
    meta(authority, true, false),
    meta(protocolPda, false, true),
  ], Buffer.from(address20));
}

function createAndDepositIx(cfg, ctx, m, { matchId, priceToken, fillDeadlineTs, seatIndex, player, ata }) {
  const params = encodeCreateParams(cfg, { matchId, priceToken, fillDeadlineTs });
  return ix(cfg.programId, 'create_and_deposit', [
    meta(player, true, true),
    meta(ctx.protocolPda, false, false),
    meta(ctx.mint.publicKey, false, false),
    meta(m.matchPda, false, true),
    meta(m.vaultPda, false, true),
    meta(m.seats[seatIndex], false, true),
    meta(m.seatIndexes[seatIndex], false, true),
    meta(ata, false, true),
    meta(TOKEN_PROGRAM_ID, false, false),
    meta(SystemProgram.programId, false, false),
    meta(SYSVAR_RENT_PUBKEY, false, false),
  ], Buffer.concat([params, u16(seatIndex)]));
}

function depositIx(cfg, ctx, m, { player, ata, seatIndex }) {
  const [seat] = pda(cfg.programId, [Buffer.from('seat'), m.matchPda.toBuffer(), player.toBuffer()]);
  const [seatIndexAcc] = pda(cfg.programId, [Buffer.from('seat-index'), m.matchPda.toBuffer(), u16(seatIndex)]);
  return ix(cfg.programId, 'deposit', [
    meta(player, true, true),
    meta(ctx.protocolPda, false, false),
    meta(m.matchPda, false, true),
    meta(seat, false, true),
    meta(seatIndexAcc, false, true),
    meta(ata, false, true),
    meta(m.vaultPda, false, true),
    meta(TOKEN_PROGRAM_ID, false, false),
    meta(SystemProgram.programId, false, false),
  ], u16(seatIndex));
}

function adminMatchIx(programId, name, authority, protocolPda, matchPda) {
  return ix(programId, name, [
    meta(authority, true, false),
    meta(protocolPda, false, false),
    meta(matchPda, false, true),
  ]);
}

function registerCommitmentIx(programId, player, matchPda, seat, commitment, timelockTarget) {
  if (commitment.length !== 32) throw new Error('commitment must be 32 bytes');
  return ix(programId, 'register_prediction_commitment', [
    meta(player, true, false),
    meta(matchPda, false, true),
    meta(seat, false, true),
  ], Buffer.concat([Buffer.from(commitment), u64(timelockTarget)]));
}

function beginLiveIx(programId, authority, protocolPda, matchPda, buttonRandomness, seats) {
  if (buttonRandomness.length !== 32) throw new Error('button_randomness must be 32 bytes');
  return ix(programId, 'begin_live', [
    meta(authority, true, false),
    meta(protocolPda, false, false),
    meta(matchPda, false, true),
    ...seats.map((s) => meta(s, false, true)), // remaining_accounts: exactly player_count seats
  ], Buffer.from(buttonRandomness));
}

function submitSettlementIx(programId, authority, protocolPda, matchPda, signed, rakeCollected, payouts, sealedSeats) {
  return ix(programId, 'submit_settlement', [
    meta(authority, true, false),
    meta(protocolPda, false, false),
    meta(matchPda, false, true),
    ...sealedSeats.map((s) => meta(s, false, true)), // remaining_accounts: exactly sealed_count seats
  ], encodeSettleArgs(signed, rakeCollected, payouts));
}

/** `claim` and `refund` share the same Context (account ordering). */
function claimIx(programId, name, player, m, seat, seatIndexAcc, ata) {
  return ix(programId, name, [
    meta(player, true, true),
    meta(m.matchPda, false, true),
    meta(seat, false, true),
    meta(seatIndexAcc, false, true),
    meta(m.vaultPda, false, true),
    meta(ata, false, true),
    meta(TOKEN_PROGRAM_ID, false, false),
  ]);
}

function voidBeforeStartIx(programId, matchPda) {
  return ix(programId, 'void_before_start', [meta(matchPda, false, true)]);
}

// ============================================================================
// Borsh encoders for the IDL argument structs
// ============================================================================

function encodeCreateParams(cfg, { matchId, priceToken, fillDeadlineTs }) {
  if (priceToken.length !== 20) throw new Error('price_token must be 20 bytes');
  return Buffer.concat([
    u64(matchId),                 // match_id
    u64(cfg.buyIn),               // buy_in
    u64(0n),                      // entry_fee
    u32(0),                       // rake_bps
    u64(0n),                      // rake_cap
    u32(cfg.nonsealPenaltyBps),   // nonseal_penalty_bps
    u8(2),                        // min_players
    u8(2),                        // max_players
    randomBytes(32),              // config_hash (any 32 bytes; no on-chain allowlist in v1 program)
    Buffer.from(priceToken),      // price_token (20)
    u64(cfg.totalBettingSec),     // total_betting_duration_sec
    u64(cfg.sealWindowSec),       // seal_window_sec
    u64(cfg.beginLiveWindowSec),  // begin_live_window_sec
    u64(fillDeadlineTs),          // fill_deadline_ts
    u64(2n ** 64n - 1n),          // max_oracle_confidence
    i32(SIGNED_PRICE_EXPONENT),   // oracle_exponent (must equal SIGNED_PRICE_EXPONENT)
  ]);
}

function encodeSettleArgs(signed, rakeCollected, payouts) {
  const signedDto = Buffer.concat([
    Buffer.from(signed.token),       // token (20)
    Buffer.from(signed.priceInWad),  // price_in_wad (32)
    u64(signed.timestampMs),         // timestamp_ms
    u8(signed.v),                    // v
    Buffer.from(signed.r),           // r (32)
    Buffer.from(signed.s),           // s (32)
  ]);
  const payoutVec = Buffer.concat([
    u32(payouts.length),
    ...payouts.map((p) => Buffer.concat([u8(p.engineSeat), u64(p.amount)])),
  ]);
  return Buffer.concat([signedDto, u64(rakeCollected), payoutVec]);
}

// ============================================================================
// EIP-191 signed price (mirrors signed_price.rs)
// ============================================================================

function newEthSigner() {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(privateKey, false); // 65 bytes, 0x04 || X || Y
  const address = keccak_256(pub.subarray(1)).subarray(12); // last 20 bytes of keccak(pubkey)
  return { privateKey, address };
}

/**
 * Sign `keccak256(token || price_in_wad || timestamp_ms_be32)` with the EIP-191
 * `"\x19Ethereum Signed Message:\n32"` prefix, emitting { token, priceInWad, timestampMs, v, r, s }.
 */
function signPrice(signer, token, priceWadValue, timestampMs) {
  if (token.length !== 20) throw new Error('token must be 20 bytes');
  const priceInWad = uint256BE(priceWadValue);     // 32-byte BE, top 16 bytes must be zero
  const tsBytes = uint256BE(BigInt(timestampMs));   // timestamp_ms as 32-byte BE
  const messageHash = keccak_256(Buffer.concat([Buffer.from(token), priceInWad, tsBytes]));
  const prefixed = keccak_256(Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n32', 'latin1'), messageHash]));
  const sig = secp256k1.sign(prefixed, signer.privateKey); // signs the 32-byte hash directly (lowS)
  const compact = sig.toCompactRawBytes(); // r(32) || s(32)
  return {
    token: Buffer.from(token),
    priceInWad,
    timestampMs: BigInt(timestampMs),
    v: sig.recovery + 27,
    r: compact.subarray(0, 32),
    s: compact.subarray(32, 64),
  };
}

function uint256BE(value) {
  const out = Buffer.alloc(32);
  let v = BigInt(value);
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// ============================================================================
// Timelock target selection (mirror register_prediction_commitment bounds)
// ============================================================================

function pickTimelockTarget(sealDeadline, cfg) {
  // latest_match_end = seal_deadline + total_betting + begin_live_window. The target drand round
  // must publish in (latest_match_end, latest_match_end + MAX_TIMELOCK_SKEW_SEC].
  const lme = sealDeadline + cfg.totalBettingSec + cfg.beginLiveWindowSec;
  // smallest round whose publish ts is strictly after lme.
  let round = (lme - DRAND_GENESIS_TIME) / DRAND_PERIOD_SEC + 1n;
  let pubTs = round * DRAND_PERIOD_SEC + DRAND_GENESIS_TIME;
  while (pubTs <= lme) { round += 1n; pubTs = round * DRAND_PERIOD_SEC + DRAND_GENESIS_TIME; }
  if (pubTs > lme + MAX_TIMELOCK_SKEW_SEC) {
    throw new Error(`no valid drand round in timelock window (lme=${lme}, pub=${pubTs})`);
  }
  return round;
}

// ============================================================================
// Token + protocol helpers
// ============================================================================

async function createChipsMint(connection, cfg, payer, mint, log) {
  const lamports = await rpcRetry(cfg, 'mint rent', () => connection.getMinimumBalanceForRentExemption(MINT_SIZE));
  await sendTx(connection, cfg, payer, 'create_chips_mint', [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, cfg.chipsDecimals, payer.publicKey, payer.publicKey, TOKEN_PROGRAM_ID),
  ], [mint], log);
}

async function createAtaAndMint(connection, cfg, payer, mint, owner, log) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  await sendTx(connection, cfg, payer, 'mint_chips', [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint, TOKEN_PROGRAM_ID),
    createMintToInstruction(mint, ata, payer.publicKey, cfg.mintAmount, [], TOKEN_PROGRAM_ID),
  ], [], log);
  return ata;
}

async function ensureLamports(connection, cfg, funder, target, label, log) {
  const bal = BigInt(await rpcRetry(cfg, `${label} balance`, () => connection.getBalance(target, 'confirmed')));
  if (bal >= cfg.minPlayerSol) return;
  const top = cfg.minPlayerSol - bal;
  log(`funding ${label} ${target.toBase58()} with ${top} lamports (had ${bal})`);
  await sendTx(connection, cfg, funder, `fund_${label}`, [
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: target, lamports: Number(top) }),
  ], [], log);
}

// ============================================================================
// RPC / account reads
// ============================================================================

async function requireProgram(connection, programId) {
  const acct = await connection.getAccountInfo(programId, 'confirmed');
  if (!acct?.executable) throw new Error(`program ${programId.toBase58()} not deployed/executable`);
}

async function requireInitialized(connection, pubkey, label) {
  const acct = await connection.getAccountInfo(pubkey, 'confirmed');
  if (!acct) throw new Error(`${label} ${pubkey.toBase58()} not initialized (run initialize_protocol)`);
}

async function accountData(connection, cfg, pubkey) {
  const acct = await rpcRetry(cfg, `get ${pubkey.toBase58()}`, () => connection.getAccountInfo(pubkey, 'confirmed'));
  if (!acct) throw new Error(`account not found: ${pubkey.toBase58()}`);
  return acct.data;
}

async function readU8(connection, cfg, pubkey, offset) {
  return (await accountData(connection, cfg, pubkey)).readUInt8(offset);
}

async function readU64(connection, cfg, pubkey, offset) {
  return (await accountData(connection, cfg, pubkey)).readBigUInt64LE(offset);
}

async function readEngineSeats(connection, cfg, seatPdas) {
  const out = [];
  for (const s of seatPdas) out.push((await accountData(connection, cfg, s)).readUInt8(S_OFF.engine_seat));
  return out;
}

async function vaultTokenBalance(connection, cfg, vaultTokenAccount) {
  const res = await rpcRetry(cfg, 'getTokenAccountBalance', async () => {
    const r = await fetch(cfg.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountBalance', params: [vaultTokenAccount.toBase58(), { commitment: 'confirmed' }] }),
    });
    return r.json();
  });
  return BigInt(res?.result?.value?.amount ?? '0');
}

async function sendTx(connection, cfg, payer, name, instructions, extraSigners, log) {
  await sleep(cfg.interTxDelayMs);
  const latest = await rpcRetry(cfg, `${name} blockhash`, () => connection.getLatestBlockhash('confirmed'));
  const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(...instructions);
  tx.sign(payer, ...extraSigners);
  const sim = await rpcRetry(cfg, `${name} simulate`, () => connection.simulateTransaction(tx));
  if (sim.value.err) {
    throw new Error(`${name} simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join('\n')}`);
  }
  const raw = tx.serialize();
  const sig = await rpcRetry(cfg, `${name} send`, () => connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'processed' }));
  await rpcRetry(cfg, `${name} confirm`, () => connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed'));
  log(`  ${name}: ${sig}`);
  return sig;
}

async function rpcRetry(cfg, label, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= cfg.rpcRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === cfg.rpcRetries || !/fetch failed|429|Too Many Requests|ECONNRESET|ETIMEDOUT|ECONNREFUSED|503|504|block height exceeded/i.test(msg)) {
        throw err;
      }
      const delay = cfg.rpcRetryBaseMs * 2 ** Math.min(attempt, 5);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function waitUntilUnix(targetTs, log) {
  for (;;) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now >= targetTs) return;
    const waitMs = Number((targetTs - now) * 1000n) + 500;
    log(`  waiting ${waitMs}ms until unix ${targetTs}`);
    await sleep(Math.min(waitMs, 5000));
  }
}

// ============================================================================
// Misc helpers
// ============================================================================

function assertEq(actual, expected, label) {
  const a = typeof actual === 'bigint' ? actual.toString() : String(actual);
  const e = typeof expected === 'bigint' ? expected.toString() : String(expected);
  if (a !== e) throw new Error(`ASSERT FAILED — ${label}: got ${a}, expected ${e}`);
}

function parseKeypairs(path) {
  const text = readFileSync(path, 'utf8');
  return [...text.matchAll(/\[([0-9,\s]+)\]/g)]
    .map((m) => m[1].split(',').map((v) => Number.parseInt(v.trim(), 10)))
    .filter((bytes) => bytes.length === 64 && bytes.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
    .map((bytes) => Keypair.fromSecretKey(Uint8Array.from(bytes)));
}

function loadKeypairFile(path) {
  const bytes = JSON.parse(readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function u8(v) { const b = Buffer.alloc(1); b.writeUInt8(Number(v)); return b; }
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v)); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v)); return b; }
function i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(Number(v)); return b; }
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }

function bigEnv(env, name, fallback) { const v = env[name]; return v === undefined || v === '' ? fallback : BigInt(v); }
function intEnv(env, name, fallback) { const v = env[name]; return v === undefined || v === '' ? fallback : Number.parseInt(v, 10); }

// CLI entry: `node src/devnet-driver.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  runDevnetGate()
    .then((r) => { console.log('\nGATE RESULT:', JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((err) => { console.error('\nGATE FAILED:\n', err?.stack ?? err); process.exit(1); });
}
