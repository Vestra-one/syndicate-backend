import { randomBytes } from 'node:crypto';
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
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  DEFAULT_PYTH_HERMES_URL,
} from './pythStack.mjs';
import {
  DEFAULT_PRICE_FEEDS,
  PYTH_UNAVAILABLE_MESSAGE,
  createHermesClient,
  fetchEarliestValidPythUpdate,
  normalizeFeedIdHex,
  priceTokenFromFeedId,
  redactedHermesConfig,
} from './pyth.mjs';
import {
  assignWinnerLoserSecrets,
  buildBeginLiveIx,
  buildRegisterPredictionCommitmentIx,
  readMatchButton,
} from './sealing.mjs';

const PROGRAM_ID = new PublicKey(process.env.SYNDICATE_PROGRAM_ID ?? 'FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS');

const RPC_URL = process.env.SYNDICATE_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const KEYS_FILE = process.env.SYNDICATE_DEVNET_KEYS_FILE ?? 'devnet_testing_keys.md';
const CHIPS_DECIMALS = envInt('SYNDICATE_DEVNET_CHIPS_DECIMALS', 6);
const BUY_IN = envBigInt('SYNDICATE_DEVNET_BUY_IN', 1_000_000n);
const PLAYER_MINT_AMOUNT = envBigInt('SYNDICATE_DEVNET_PLAYER_MINT_AMOUNT', 10_000_000n);
const MAX_ORACLE_CONFIDENCE = envBigInt('SYNDICATE_DEVNET_MAX_ORACLE_CONFIDENCE', 2n ** 64n - 1n);
const ORACLE_EXPONENT = envInt('SYNDICATE_DEVNET_ORACLE_EXPONENT', -18);
const TOTAL_BETTING_DURATION_SEC = envBigInt('SYNDICATE_DEVNET_TOTAL_BETTING_DURATION_SEC', 600n);
const SEAL_WINDOW_SEC = envBigInt('SYNDICATE_DEVNET_SEAL_WINDOW_SEC', 20n);
const BEGIN_LIVE_WINDOW_SEC = envBigInt('SYNDICATE_DEVNET_BEGIN_LIVE_WINDOW_SEC', 5n);
const NONSEAL_PENALTY_BPS = envInt('SYNDICATE_DEVNET_NONSEAL_PENALTY_BPS', 2500);
const RAKE_BPS = envInt('SYNDICATE_DEVNET_RAKE_BPS', 0);
const RAKE_CAP = envBigInt('SYNDICATE_DEVNET_RAKE_CAP', 0n);
const PYTH_HERMES_URL = process.env.PYTH_HERMES_URL ?? DEFAULT_PYTH_HERMES_URL;
const PYTH_API_KEY = process.env.PYTH_API_KEY ?? '';
const PYTH_PRICE_FEED_ID_HEX = normalizeFeedIdHex(
  process.env.SYNDICATE_DEVNET_PRICE_FEED_ID_HEX ?? DEFAULT_PRICE_FEEDS.BTC_USD,
);
const PYTH_HTTP_TIMEOUT_MS = envInt('PYTH_HTTP_TIMEOUT_MS', 5_000);
const PYTH_HTTP_RETRIES = envInt('PYTH_HTTP_RETRIES', 3);
const DEVNET_RPC_RETRIES = envInt('SYNDICATE_DEVNET_RPC_RETRIES', 10);
const DEVNET_RPC_RETRY_BASE_MS = envInt('SYNDICATE_DEVNET_RPC_RETRY_BASE_MS', 750);
const DEVNET_INTER_TX_DELAY_MS = envInt('SYNDICATE_DEVNET_INTER_TX_DELAY_MS', 2_000);

const MATCH_STATUS = {
  Filling: 0,
  Sealing: 1,
  Live: 2,
  Settled: 3,
  Void: 4,
};

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const keys = parseKeypairs(KEYS_FILE);
  if (keys.length < 2) throw new Error(`${KEYS_FILE} must contain at least two keypairs`);

  const operator = keys[0];
  const playerA = keys[0];
  const playerB = keys[1];
  console.log(`cluster: ${RPC_URL}`);
  console.log(`program: ${PROGRAM_ID.toBase58()}`);
  console.log(`operator/playerA: ${operator.publicKey.toBase58()}`);
  console.log(`playerB: ${playerB.publicKey.toBase58()}`);

  await requireProgram(connection, PROGRAM_ID);
  await requireBalance(connection, operator.publicKey, 1_000_000_000n, 'operator/playerA');
  await requireBalance(connection, playerB.publicKey, 20_000_000n, 'playerB');

  const mint = Keypair.generate();
  await createChipsMint(connection, operator, mint);
  const ataA = await createAtaAndMint(connection, operator, mint.publicKey, playerA.publicKey);
  const ataB = await createAtaAndMint(connection, operator, mint.publicKey, playerB.publicKey);
  console.log(`chips mint: ${mint.publicKey.toBase58()}`);
  console.log(`playerA chips ata: ${ataA.toBase58()}`);
  console.log(`playerB chips ata: ${ataB.toBase58()}`);

  const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], PROGRAM_ID);
  await ensureProtocol(connection, operator, protocolPda);

  const baseMatchId = process.env.SYNDICATE_DEVNET_MATCH_ID
    ? BigInt(process.env.SYNDICATE_DEVNET_MATCH_ID)
    : BigInt(Math.floor(Date.now() / 1000));

  if (!envBool('SYNDICATE_DEVNET_SETTLEMENT_ONLY', false)) {
    await runRefundLifecycle(connection, operator, playerA, playerB, protocolPda, mint.publicKey, ataA, ataB, baseMatchId);
  }

  if (!PYTH_API_KEY) {
    const message = `settlement/claim skipped: PYTH_API_KEY is not set ${JSON.stringify(redactedHermesConfig({
      hermesUrl: PYTH_HERMES_URL,
      apiKey: PYTH_API_KEY,
    }))}`;
    if (envBool('SYNDICATE_DEVNET_REQUIRE_PYTH_SETTLEMENT', false)) throw new Error(message);
    console.log(message);
    return;
  }

  await runSettlementLifecycle(
    connection,
    operator,
    playerA,
    playerB,
    protocolPda,
    mint.publicKey,
    ataA,
    ataB,
    baseMatchId + 1n,
    pythConfig(),
  );
}

function parseKeypairs(path) {
  const text = readFileSync(path, 'utf8');
  const matches = [...text.matchAll(/\[([^\]]+)\]/g)];
  return matches.map((m) => {
    const bytes = m[1].split(',').map((v) => Number.parseInt(v.trim(), 10));
    if (bytes.length !== 64 || bytes.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
      throw new Error(`invalid keypair byte array in ${path}`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  });
}

async function requireProgram(connection, programId) {
  const account = await connection.getAccountInfo(programId, 'confirmed');
  if (!account) throw new Error(`program ${programId.toBase58()} is not deployed`);
  const upgradeableLoader = 'BPFLoaderUpgradeab1e11111111111111111111111';
  if (account.owner.toBase58() !== upgradeableLoader) {
    throw new Error(`program owner ${account.owner.toBase58()} != ${upgradeableLoader}`);
  }
}

async function requireBalance(connection, pubkey, minLamports, label) {
  const balance = BigInt(await connection.getBalance(pubkey, 'confirmed'));
  if (balance < minLamports) {
    throw new Error(`${label} ${pubkey.toBase58()} has ${balance} lamports, needs ${minLamports}`);
  }
}

async function createChipsMint(connection, payer, mint) {
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  await sendTx(connection, payer, 'create_chips_mint', [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, CHIPS_DECIMALS, payer.publicKey, payer.publicKey, TOKEN_PROGRAM_ID),
  ], [mint]);
}

async function createAtaAndMint(connection, payer, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  await sendTx(connection, payer, 'create_ata_and_mint_chips', [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint, TOKEN_PROGRAM_ID),
    createMintToInstruction(mint, ata, payer.publicKey, PLAYER_MINT_AMOUNT, [], TOKEN_PROGRAM_ID),
  ]);
  return ata;
}

async function ensureProtocol(connection, operator, protocolPda) {
  const existing = await connection.getAccountInfo(protocolPda, 'confirmed');
  if (existing) {
    assertProtocolRoles(existing.data, operator.publicKey);
    console.log(`protocol reused: ${protocolPda.toBase58()}`);
    return;
  }
  const roles = [
    operator.publicKey,
    operator.publicKey,
    operator.publicKey,
    operator.publicKey,
    operator.publicKey,
    operator.publicKey,
    operator.publicKey,
    operator.publicKey,
  ];
  await sendTx(connection, operator, 'initialize_protocol', [
    ix('initialize_protocol', [
      meta(operator.publicKey, true, true),
      meta(protocolPda, false, true),
      meta(SystemProgram.programId, false, false),
    ], Buffer.concat(roles.map((k) => k.toBuffer()))),
  ]);
  console.log(`protocol initialized: ${protocolPda.toBase58()}`);
}

function assertProtocolRoles(data, operator) {
  if (data.length < 8 + 32 * 8) throw new Error('protocol account too short');
  for (let i = 0; i < 5; i += 1) {
    const role = new PublicKey(data.subarray(8 + i * 32, 8 + (i + 1) * 32));
    if (!role.equals(operator)) {
      throw new Error(`protocol role ${i} is ${role.toBase58()}, expected ${operator.toBase58()}`);
    }
  }
}

async function runRefundLifecycle(connection, operator, playerA, playerB, protocolPda, mint, ataA, ataB, matchId) {
  const ctx = await createMatch(connection, operator, playerA.publicKey, playerB.publicKey, protocolPda, mint, matchId, 'refund');
  await deposit(connection, playerA, protocolPda, ctx, ataA, 0);
  await deposit(connection, playerB, protocolPda, ctx, ataB, 1);
  await adminMatch(connection, operator, protocolPda, ctx.matchPda, 'lock');
  await adminMatch(connection, operator, protocolPda, ctx.matchPda, 'void');
  await claimOrRefund(connection, playerA, ctx, ataA, 'refund');
  await claimOrRefund(connection, playerB, ctx, ataB, 'refund');
  await assertMatchStatus(connection, ctx.matchPda, MATCH_STATUS.Void);
  console.log(`refund lifecycle complete: match_id=${matchId}`);
}

async function runSettlementLifecycle(connection, operator, playerA, playerB, protocolPda, mint, ataA, ataB, matchId, pyth) {
  const oracleRules = {
    feedId: priceTokenFromFeedId(pyth.feedIdHex),
    scheduledEndTs: pyth.scheduledEndTs,
    maxConfidence: MAX_ORACLE_CONFIDENCE,
    expectedExponent: ORACLE_EXPONENT,
  };
  const ctx = await createMatch(connection, operator, playerA.publicKey, playerB.publicKey, protocolPda, mint, matchId, 'settle', oracleRules);
  await deposit(connection, playerA, protocolPda, ctx, ataA, 0);
  await deposit(connection, playerB, protocolPda, ctx, ataB, 1);
  await adminMatch(connection, operator, protocolPda, ctx.matchPda, 'lock');

  const selected = await fetchEarliestValidPythUpdate({
    client: pyth.client,
    hermesUrl: pyth.hermesUrl,
    feedIdHex: pyth.feedIdHex,
    scheduledEndTs: pyth.scheduledEndTs,
    maxConfidence: MAX_ORACLE_CONFIDENCE,
    expectedExponent: ORACLE_EXPONENT,
  });
  if (!selected) {
    console.log(`oracle unavailable: ${PYTH_UNAVAILABLE_MESSAGE}`);
    await adminMatch(connection, operator, protocolPda, ctx.matchPda, 'void');
    await claimOrRefund(connection, playerA, ctx, ataA, 'refund');
    await claimOrRefund(connection, playerB, ctx, ataB, 'refund');
    await assertMatchStatus(connection, ctx.matchPda, MATCH_STATUS.Void);
    console.log(`oracle-unavailable refund lifecycle complete: match_id=${matchId}`);
    return;
  }

  const oracle = {
    price: selected.price,
    publishTime: selected.publishTime,
  };

  await runSealingAndBeginLive(connection, operator, playerA, playerB, protocolPda, ctx, oracle);

  console.log(
    'submit_settlement skipped: v1 settlement uses signed-price-server via settlement-chain ' +
    '(/internal/solana/submit-settlement). This harness no longer posts Pyth receiver txs or syncs action logs.',
  );
  console.log(`sealing-to-live lifecycle complete: match_id=${matchId}`);
}

async function createMatch(connection, operator, playerA, playerB, protocolPda, mint, matchId, label, oracleRules = null) {
  const matchSeed = u64(matchId);
  const [matchPda] = PublicKey.findProgramAddressSync([Buffer.from('match'), matchSeed], PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), matchPda.toBuffer()], PROGRAM_ID);
  const [seatA] = PublicKey.findProgramAddressSync([Buffer.from('seat'), matchPda.toBuffer(), playerA.toBuffer()], PROGRAM_ID);
  const [seatB] = PublicKey.findProgramAddressSync([Buffer.from('seat'), matchPda.toBuffer(), playerB.toBuffer()], PROGRAM_ID);
  const [seatIndexA] = PublicKey.findProgramAddressSync([Buffer.from('seat-index'), matchPda.toBuffer(), u16(0)], PROGRAM_ID);
  const [seatIndexB] = PublicKey.findProgramAddressSync([Buffer.from('seat-index'), matchPda.toBuffer(), u16(1)], PROGRAM_ID);
  const priceToken = oracleRules ? oracleRules.feedId : Buffer.alloc(20, 7);
  const maxOracleConfidence = oracleRules ? BigInt(oracleRules.maxConfidence) : MAX_ORACLE_CONFIDENCE;
  const oracleExponent = oracleRules ? oracleRules.expectedExponent : ORACLE_EXPONENT;
  const fillDeadlineTs = BigInt(Math.floor(Date.now() / 1000) + 86_400);

  const params = Buffer.concat([
    u64(matchId),
    u64(BUY_IN),
    u64(0n),
    u32(RAKE_BPS),
    u64(RAKE_CAP),
    u32(NONSEAL_PENALTY_BPS),
    u8(2),
    u8(2),
    configHash(label, matchId),
    priceToken,
    u64(TOTAL_BETTING_DURATION_SEC),
    u64(SEAL_WINDOW_SEC),
    u64(BEGIN_LIVE_WINDOW_SEC),
    u64(fillDeadlineTs),
    u64(maxOracleConfidence),
    i32(oracleExponent),
  ]);

  await sendTx(connection, operator, 'create_match', [
    ix('create_match', [
      meta(operator.publicKey, true, true),
      meta(protocolPda, false, false),
      meta(mint, false, false),
      meta(matchPda, false, true),
      meta(vaultPda, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
    ], params),
  ]);
  console.log(`match created: ${matchId} ${matchPda.toBase58()}`);
  return { matchId, matchPda, vaultPda, seatA, seatB, seatIndexA, seatIndexB, feedId, scheduledEndTs };
}

async function deposit(connection, player, protocolPda, ctx, playerToken, seatIndex) {
  const [seat] = PublicKey.findProgramAddressSync([Buffer.from('seat'), ctx.matchPda.toBuffer(), player.publicKey.toBuffer()], PROGRAM_ID);
  const [seatIndexAccount] = PublicKey.findProgramAddressSync([Buffer.from('seat-index'), ctx.matchPda.toBuffer(), u16(seatIndex)], PROGRAM_ID);
  await sendTx(connection, player, 'deposit', [
    ix('deposit', [
      meta(player.publicKey, true, true),
      meta(protocolPda, false, false),
      meta(ctx.matchPda, false, true),
      meta(seat, false, true),
      meta(seatIndexAccount, false, true),
      meta(playerToken, false, true),
      meta(ctx.vaultPda, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ], u16(seatIndex)),
  ]);
  console.log(`deposit ok: ${player.publicKey.toBase58()} seat=${seatIndex}`);
}

async function adminMatch(connection, operator, protocolPda, matchPda, name) {
  await sendTx(connection, operator, name, [
    ix(name, [
      meta(operator.publicKey, true, false),
      meta(protocolPda, false, false),
      meta(matchPda, false, true),
    ]),
  ]);
}

async function runSealingAndBeginLive(connection, operator, playerA, playerB, protocolPda, ctx, oracle) {
  const players = [playerA, playerB];
  const seats = [ctx.seatA, ctx.seatB];
  const { winnerSecrets, loserSecrets } = assignWinnerLoserSecrets(oracle.price, 0);
  ctx.winnerSecrets = winnerSecrets;
  ctx.loserSecrets = loserSecrets;

  // Timelock target must publish after projected match end; use a far-future drand round for harness.
  const timelockTarget = 10_000_000n;
  for (const seatIndex of [0, 1]) {
    const secrets = seatIndex === winnerSecrets.seatIndex ? winnerSecrets : loserSecrets;
    const registerIx = buildRegisterPredictionCommitmentIx(
      PROGRAM_ID,
      players[seatIndex],
      ctx.matchPda,
      seats[seatIndex],
      {
        commitmentHex: secrets.commitmentHex,
        timelockTarget,
      },
    );
    await sendTx(connection, players[seatIndex], `register_prediction_commitment_${seatIndex}`, [registerIx]);
  }

  // Wait until seal window closes before begin_live.
  const waitMs = Number(SEAL_WINDOW_SEC * 1000n + 500n);
  console.log(`waiting ${waitMs}ms for seal deadline before begin_live`);
  await sleep(waitMs);

  const buttonRandomness = randomBytes(32);
  buttonRandomness[0] = 1;
  await sendTx(connection, operator, 'begin_live', [
    buildBeginLiveIx(PROGRAM_ID, operator.publicKey, protocolPda, ctx.matchPda, buttonRandomness, seats),
  ]);

  const liveMatchData = await accountData(connection, ctx.matchPda);
  const button = readMatchButton(liveMatchData);
  ctx.button = button;
  console.log(`live: button=${button} scheduled_end derived on-chain`);
}

async function claimOrRefund(connection, player, ctx, playerToken, name) {
  const [seat] = PublicKey.findProgramAddressSync([Buffer.from('seat'), ctx.matchPda.toBuffer(), player.publicKey.toBuffer()], PROGRAM_ID);
  const seatData = await accountData(connection, seat);
  const seatIndex = seatData.readUInt16LE(8 + 32 + 32);
  const [seatIndexAccount] = PublicKey.findProgramAddressSync([Buffer.from('seat-index'), ctx.matchPda.toBuffer(), u16(seatIndex)], PROGRAM_ID);
  await sendTx(connection, player, name, [
    ix(name, [
      meta(player.publicKey, true, true),
      meta(ctx.matchPda, false, true),
      meta(seat, false, true),
      meta(seatIndexAccount, false, true),
      meta(ctx.vaultPda, false, true),
      meta(playerToken, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ]),
  ]);
  console.log(`${name} ok: ${player.publicKey.toBase58()}`);
}

async function assertMatchStatus(connection, matchPda, expected) {
  const data = await accountData(connection, matchPda);
  const status = data.readUInt8(8 + 32 + 32 + 32 + 8 + 8);
  if (status !== expected) {
    throw new Error(`match ${matchPda.toBase58()} status ${status}, expected ${expected}`);
  }
}

async function accountData(connection, pubkey) {
  const account = await rpcRetry(
    `get account ${pubkey.toBase58()}`,
    () => connection.getAccountInfo(pubkey, 'confirmed'),
  );
  if (!account) throw new Error(`account not found: ${pubkey.toBase58()}`);
  return account.data;
}

async function sendTx(connection, payer, name, instructions, extraSigners = []) {
  await sleep(DEVNET_INTER_TX_DELAY_MS);
  const latest = await rpcRetry(`${name} getLatestBlockhash`, () => connection.getLatestBlockhash('confirmed'));
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...instructions);
  tx.sign(payer, ...extraSigners);
  const sim = await rpcRetry(`${name} simulate`, () => connection.simulateTransaction(tx));
  if (sim.value.err) {
    throw new Error(`${name} simulation failed: ${JSON.stringify(sim.value.err)} logs=${JSON.stringify(sim.value.logs)}`);
  }
  const serialized = tx.serialize();
  const sig = await rpcRetry(
    `${name} sendRawTransaction`,
    () => connection.sendRawTransaction(serialized, { skipPreflight: false, preflightCommitment: 'processed' }),
  );
  await rpcRetry(`${name} confirm`, () => connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed'));
  console.log(`${name}: ${sig}`);
  return sig;
}



async function rpcRetry(label, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= DEVNET_RPC_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === DEVNET_RPC_RETRIES || !isRetryableRpcError(err)) {
        throw err;
      }
      const delayMs = DEVNET_RPC_RETRY_BASE_MS * 2 ** Math.min(attempt, 5);
      console.warn(`${label} RPC failed (${retryableMessage(err)}), retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function isRetryableRpcError(err) {
  const message = retryableMessage(err);
  return /fetch failed|429|Too Many Requests|ECONNRESET|ETIMEDOUT|ECONNREFUSED|503|504/i.test(message);
}

function retryableMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pythConfig() {
  const scheduledEndTs = process.env.SYNDICATE_DEVNET_SETTLEMENT_TS
    ? BigInt(process.env.SYNDICATE_DEVNET_SETTLEMENT_TS)
    : BigInt(Math.floor(Date.now() / 1000));
  return {
    hermesUrl: PYTH_HERMES_URL,
    feedIdHex: PYTH_PRICE_FEED_ID_HEX,
    scheduledEndTs,
    idempotencyKey: process.env.SYNDICATE_DEVNET_IDEMPOTENCY_KEY ?? `devnet:${scheduledEndTs.toString()}:${PYTH_PRICE_FEED_ID_HEX}`,
    client: createHermesClient({
      hermesUrl: PYTH_HERMES_URL,
      apiKey: PYTH_API_KEY,
      timeoutMs: PYTH_HTTP_TIMEOUT_MS,
      httpRetries: PYTH_HTTP_RETRIES,
    }),
  };
}


function ix(name, accounts, data = Buffer.alloc(0)) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: accounts,
    data: Buffer.concat([discriminator(`global:${name}`), data]),
  });
}

function meta(pubkey, isSigner, isWritable) {
  return { pubkey, isSigner, isWritable };
}

function discriminator(preimage) {
  return createHash('sha256').update(preimage).digest().subarray(0, 8);
}

function configHash(label, matchId) {
  return createHash('sha256')
    .update('syndicate-devnet-harness')
    .update(label)
    .update(u64(matchId))
    .digest();
}

function vec(items) {
  return Buffer.concat([u32(items.length), ...items]);
}

function bool(value) {
  return u8(value ? 1 : 0);
}

function u8(value) {
  const out = Buffer.alloc(1);
  out.writeUInt8(Number(value));
  return out;
}

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(Number(value));
  return out;
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(Number(value));
  return out;
}

function i32(value) {
  const out = Buffer.alloc(4);
  out.writeInt32LE(Number(value));
  return out;
}

function u64(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function i64(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function envPubkey(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  return new PublicKey(value);
}

function envBigInt(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : BigInt(value);
}

function envInt(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
