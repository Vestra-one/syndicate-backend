import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet } from '@coral-xyz/anchor';
import { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver';
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
  resolvePythStackFromEnv,
} from './pythStack.mjs';
import {
  DEFAULT_PRICE_FEEDS,
  PYTH_UNAVAILABLE_MESSAGE,
  createHermesClient,
  feedIdToBuffer,
  fetchEarliestValidPythUpdate,
  normalizeFeedIdHex,
  pythAuditReceipt,
  redactedHermesConfig,
} from './pyth.mjs';
import {
  ACTION_TAG,
  actionLogPda,
  buildAppendPlayerActionIx,
  buildBeginLiveIx,
  buildFinalizeActionLogIx,
  buildInitActionLogIx,
  buildRegisterPredictionCommitmentIx,
  buildSetButtonSeedIx,
  GENESIS_HEAD_HEX,
  headsUpSbBbSeats,
  newPredictionSecrets,
  playerStatesAfterHeadsUpAllInCall,
  assignWinnerLoserSecrets,
  deriveButtonFromVrfSeed,
  readActionLogHead,
  readMatchButton,
  readMatchVrfSeed,
} from './actionLog.mjs';

const PROGRAM_ID = new PublicKey(process.env.SYNDICATE_PROGRAM_ID ?? 'FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS');

const PYTH_STACK = resolvePythStackFromEnv(process.env);
const PYTH_RECEIVER_PROGRAM_ID = PYTH_STACK.receiverProgramId;
const RPC_URL = process.env.SYNDICATE_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const KEYS_FILE = process.env.SYNDICATE_DEVNET_KEYS_FILE ?? 'devnet_testing_keys.md';
const CHIPS_DECIMALS = envInt('SYNDICATE_DEVNET_CHIPS_DECIMALS', 6);
const BUY_IN = envBigInt('SYNDICATE_DEVNET_BUY_IN', 1_000_000n);
const SMALL_BLIND = envBigInt('SYNDICATE_DEVNET_SMALL_BLIND', 10_000n);
const BIG_BLIND = envBigInt('SYNDICATE_DEVNET_BIG_BLIND', 20_000n);
const ROUND_COUNT = envInt('SYNDICATE_DEVNET_ROUND_COUNT', 1);
const PLAYER_MINT_AMOUNT = envBigInt('SYNDICATE_DEVNET_PLAYER_MINT_AMOUNT', 10_000_000n);
const ORACLE_DELAY_WINDOW_SEC = envBigInt('SYNDICATE_DEVNET_ORACLE_DELAY_WINDOW_SEC', 5n);
const MAX_ORACLE_CONFIDENCE = envBigInt('SYNDICATE_DEVNET_MAX_ORACLE_CONFIDENCE', 2n ** 64n - 1n);
const ORACLE_EXPONENT = envInt('SYNDICATE_DEVNET_ORACLE_EXPONENT', -8);
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
const PYTH_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = envInt('SYNDICATE_PYTH_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS', 100_000);
const SUBMIT_SETTLEMENT_COMPUTE_UNITS = envInt('SYNDICATE_SUBMIT_SETTLEMENT_COMPUTE_UNITS', 200_000);
const ALLOW_TWO_STEP_PYTH_FALLBACK = envBool('SYNDICATE_DEVNET_ALLOW_TWO_STEP_PYTH_FALLBACK', true);
const RECEIPT_DIR = process.env.SYNDICATE_DEVNET_RECEIPT_DIR ?? '/tmp/syndicate-devnet-receipts';
const PRICE_UPDATE_MIN_LEN = 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8;
const PRICE_MESSAGE_OFFSET = 8 + 32 + 2;

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
    feedId: feedIdToBuffer(pyth.feedIdHex),
    scheduledEndTs: pyth.scheduledEndTs,
    oracleDelayWindowSec: ORACLE_DELAY_WINDOW_SEC,
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
    oracleDelayWindowSec: ORACLE_DELAY_WINDOW_SEC,
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
    feedId: feedIdToBuffer(selected.feedIdHex),
    price: selected.price,
    confidence: selected.confidence,
    exponent: selected.exponent,
    publishTime: selected.publishTime,
  };

  await runSealingAndActionLog(connection, operator, playerA, playerB, protocolPda, ctx, oracle);

  const receipt = await submitSettlementWithPyth(connection, operator, protocolPda, ctx, selected, oracle, pyth);
  await claimOrRefund(connection, playerA, ctx, ataA, 'claim');
  await claimOrRefund(connection, playerB, ctx, ataB, 'claim');
  await assertMatchStatus(connection, ctx.matchPda, MATCH_STATUS.Settled);
  console.log(`settlement lifecycle complete: match_id=${matchId} tx=${receipt.atomicSettlementTxSignature}`);
}

async function createMatch(connection, operator, playerA, playerB, protocolPda, mint, matchId, label, oracleRules = null) {
  const matchSeed = u64(matchId);
  const [matchPda] = PublicKey.findProgramAddressSync([Buffer.from('match'), matchSeed], PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), matchPda.toBuffer()], PROGRAM_ID);
  const [seatA] = PublicKey.findProgramAddressSync([Buffer.from('seat'), matchPda.toBuffer(), playerA.toBuffer()], PROGRAM_ID);
  const [seatB] = PublicKey.findProgramAddressSync([Buffer.from('seat'), matchPda.toBuffer(), playerB.toBuffer()], PROGRAM_ID);
  const [seatIndexA] = PublicKey.findProgramAddressSync([Buffer.from('seat-index'), matchPda.toBuffer(), u16(0)], PROGRAM_ID);
  const [seatIndexB] = PublicKey.findProgramAddressSync([Buffer.from('seat-index'), matchPda.toBuffer(), u16(1)], PROGRAM_ID);
  const scheduledEndTs = oracleRules ? BigInt(oracleRules.scheduledEndTs) : BigInt(Math.floor(Date.now() / 1000));
  const feedId = oracleRules ? oracleRules.feedId : Buffer.alloc(32, 7);
  const oracleDelayWindowSec = oracleRules ? BigInt(oracleRules.oracleDelayWindowSec) : ORACLE_DELAY_WINDOW_SEC;
  const maxOracleConfidence = oracleRules ? BigInt(oracleRules.maxConfidence) : MAX_ORACLE_CONFIDENCE;
  const oracleExponent = oracleRules ? oracleRules.expectedExponent : ORACLE_EXPONENT;

  const params = Buffer.concat([
    u64(matchId),
    u64(BUY_IN),
    u64(0n),
    u32(RAKE_BPS),
    u64(RAKE_CAP),
    u8(2),
    u8(2),
    configHash(label, matchId),
    feedId,
    u64(scheduledEndTs),
    u64(oracleDelayWindowSec),
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

async function runSealingAndActionLog(connection, operator, playerA, playerB, protocolPda, ctx, oracle) {
  const players = [playerA, playerB];
  const seedBytes = randomBytes(32);
  seedBytes[0] = 1; // non-zero seed required by program
  const vrfProofHash = createHash('sha256').update('devnet-harness-vrf-proof').update(seedBytes).digest();

  await sendTx(connection, operator, 'set_button_seed', [
    buildSetButtonSeedIx(PROGRAM_ID, operator.publicKey, protocolPda, ctx.matchPda, seedBytes, vrfProofHash),
  ]);
  await sendTx(connection, operator, 'begin_live', [
    buildBeginLiveIx(PROGRAM_ID, operator.publicKey, protocolPda, ctx.matchPda),
  ]);

  const matchData = await accountData(connection, ctx.matchPda);
  const vrfSeed = readMatchVrfSeed(matchData);
  const button = readMatchButton(matchData);
  if (button !== deriveButtonFromVrfSeed(vrfSeed, 2)) {
    throw new Error(`button mismatch: account=${button} derived=${deriveButtonFromVrfSeed(vrfSeed, 2)}`);
  }
  ctx.vrfSeed = vrfSeed;
  ctx.button = button;
  console.log(`sealing complete: button=${button} vrf_seed=${ctx.vrfSeed.toString('hex')}`);

  const settleDeadlineTs = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const sealSeq = [0n, 1n, 0n, 0n, 0n];
  await sendTx(connection, operator, 'init_action_log', [
    buildInitActionLogIx(
      PROGRAM_ID,
      operator.publicKey,
      protocolPda,
      ctx.matchPda,
      [ctx.seatA, ctx.seatB],
      {
        button,
        smallBlind: SMALL_BLIND,
        bigBlind: BIG_BLIND,
        roundCount: ROUND_COUNT,
        settleDeadlineTs,
        sealSeq,
      },
    ),
  ]);

  const { winnerSecrets, loserSecrets } = assignWinnerLoserSecrets(oracle.price, button);
  ctx.winnerSecrets = winnerSecrets;
  ctx.loserSecrets = loserSecrets;
  const { sbSeat, bbSeat } = headsUpSbBbSeats(button);

  for (const seatIndex of [0, 1]) {
    const secrets = seatIndex === winnerSecrets.seatIndex ? winnerSecrets : loserSecrets;
    const registerIxs = buildRegisterPredictionCommitmentIx(
      PROGRAM_ID,
      players[seatIndex],
      ctx.matchPda,
      {
        matchId: ctx.matchId,
        seatIndex,
        sealSeq: BigInt(seatIndex),
        commitmentHex: secrets.commitmentHex,
      },
    );
    await sendTx(connection, players[seatIndex], `register_prediction_commitment_${seatIndex}`, registerIxs);
  }

  const allInIxs = buildAppendPlayerActionIx(
    PROGRAM_ID,
    players[sbSeat],
    protocolPda,
    ctx.matchPda,
    {
      matchId: ctx.matchId,
      seatIndex: sbSeat,
      nonce: 1n,
      prevHeadHex: GENESIS_HEAD_HEX,
      actionTag: ACTION_TAG.allIn,
      amount: 0n,
    },
  );
  await sendTx(connection, players[sbSeat], 'append_player_action_all_in', allInIxs);

  let actionLogData = await accountData(connection, actionLogPda(PROGRAM_ID, ctx.matchPda)[0]);
  let head = readActionLogHead(actionLogData);

  const callIxs = buildAppendPlayerActionIx(
    PROGRAM_ID,
    players[bbSeat],
    protocolPda,
    ctx.matchPda,
    {
      matchId: ctx.matchId,
      seatIndex: bbSeat,
      nonce: 1n,
      prevHeadHex: head.toString('hex'),
      actionTag: ACTION_TAG.call,
      amount: 0n,
    },
  );
  await sendTx(connection, players[bbSeat], 'append_player_action_call', callIxs);

  actionLogData = await accountData(connection, actionLogPda(PROGRAM_ID, ctx.matchPda)[0]);
  head = readActionLogHead(actionLogData);
  ctx.eventRoot = head;
  console.log(`action log head: ${head.toString('hex')}`);

  await sendTx(connection, operator, 'finalize_action_log', [
    buildFinalizeActionLogIx(PROGRAM_ID, operator.publicKey, protocolPda, ctx.matchPda, head),
  ]);
  console.log(`action log finalized: match_id=${ctx.matchId}`);
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

async function submitSettlementWithPyth(connection, operator, protocolPda, ctx, selected, oracle, pyth) {
  const wallet = new Wallet(operator);
  const receiver = new PythSolanaReceiver({
    connection,
    wallet,
    receiverProgramId: PYTH_STACK.receiverProgramId,
    wormholeProgramId: PYTH_STACK.wormholeProgramId,
    pushOracleProgramId: PYTH_STACK.pushOracleProgramId,
  });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates(selected.priceUpdateData);
  let priceUpdateAccount = null;
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    priceUpdateAccount = getPriceUpdateAccount(selected.feedIdHex);
    if (!priceUpdateAccount) {
      throw new Error(`Pyth builder did not expose price update account for ${selected.feedIdHex}`);
    }
    return [{
      instruction: submitSettlementIx(operator, protocolPda, ctx, priceUpdateAccount, oracle),
      signers: [],
      computeUnits: SUBMIT_SETTLEMENT_COMPUTE_UNITS,
    }];
  });
  priceUpdateAccount = priceUpdateAccount ?? builder.getPriceUpdateAccount(selected.feedIdHex);
  const transactions = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: PYTH_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
    tightComputeBudget: true,
  });
  if (transactions.length !== 1 && !ALLOW_TWO_STEP_PYTH_FALLBACK) {
    throw new Error(
      `Pyth full-verification settlement did not fit in one atomic transaction; built ${transactions.length} transactions. ` +
      'Set SYNDICATE_DEVNET_ALLOW_TWO_STEP_PYTH_FALLBACK=true only after reviewing this measured size/compute result.',
    );
  }
  const signatures = [];
  if (transactions.length === 1) {
    signatures.push(await sendVersionedTx(connection, operator, 'pyth_submit_settlement_atomic', transactions[0]));
  } else {
    for (const [index, transaction] of transactions.slice(0, -1).entries()) {
      signatures.push(await sendVersionedTxWithRetry(
        connection,
        operator,
        `pyth_post_price_update_step_${index + 1}_of_${transactions.length - 1}`,
        transaction,
      ));
    }
    priceUpdateAccount = builder.getPriceUpdateAccount(selected.feedIdHex);
    if (!priceUpdateAccount) {
      throw new Error(`Pyth builder did not expose price update account for ${selected.feedIdHex} after posting`);
    }
    await assertPriceUpdateOwner(connection, priceUpdateAccount, PYTH_STACK.receiverProgramId);
    console.log(`pyth price update account: ${priceUpdateAccount.toBase58()} owner=${PYTH_STACK.receiverProgramId.toBase58()}`);
    signatures.push(await sendTx(
      connection,
      operator,
      'submit_settlement',
      [submitSettlementIx(operator, protocolPda, ctx, priceUpdateAccount, oracle)],
    ));
  }
  const txSig = signatures[signatures.length - 1];
  const receipt = pythAuditReceipt({
    matchId: ctx.matchId,
    idempotencyKey: pyth.idempotencyKey,
    selected,
    priceUpdateAccount: priceUpdateAccount.toBase58(),
    settlementTxSignature: txSig,
    settlementTxSignatures: signatures,
    settlementMode: transactions.length === 1 ? 'atomic' : 'two_step',
    receiverProgramId: PYTH_STACK.receiverProgramId.toBase58(),
    wormholeProgramId: PYTH_STACK.wormholeProgramId.toBase58(),
    pushOracleProgramId: PYTH_STACK.pushOracleProgramId.toBase58(),
  });
  persistPythAuditReceipt(receipt);
  console.log(`pyth settlement receipt: ${JSON.stringify(receipt)}`);
  return receipt;
}

function submitSettlementIx(operator, protocolPda, ctx, priceUpdate, oracle) {
  const args = encodeSettleArgs(ctx, oracle);
  const [actionLog] = actionLogPda(PROGRAM_ID, ctx.matchPda);
  return ix('submit_settlement', [
    meta(operator.publicKey, true, false),
    meta(protocolPda, false, false),
    meta(ctx.matchPda, false, true),
    meta(actionLog, false, false),
    meta(priceUpdate, false, false),
    meta(ctx.seatA, false, true),
    meta(ctx.seatB, false, true),
  ], args);
}

function encodeSettleArgs(ctx, oracle) {
  if (!ctx.vrfSeed || !ctx.winnerSecrets || !ctx.loserSecrets || ctx.button === undefined) {
    throw new Error('encodeSettleArgs requires sealing/action-log context');
  }
  const { players, revealed } = playerStatesAfterHeadsUpAllInCall({
    buyIn: BUY_IN,
    winnerSecrets: ctx.winnerSecrets,
    loserSecrets: ctx.loserSecrets,
  });
  const result = settle(players, oracle);
  return Buffer.concat([
    ctx.vrfSeed,
    oracle.feedId,
    i64(oracle.price),
    u64(BigInt(oracle.publishTime)),
    u64(oracle.confidence),
    i32(oracle.exponent),
    i64(result.settlementPrice),
    u64(BigInt(oracle.publishTime)),
    vec(result.potAwards.map((a) => Buffer.concat([u16(a.seatIndex), u64(a.amount)]))),
    vec(result.uncalledReturns.map((r) => Buffer.concat([u16(r.seatIndex), u64(r.amount)]))),
    u64(result.rakeCollected),
    vec(revealed.map((r) => {
      const blinding = Buffer.from(r.blindingHex.replace(/^0x/, ''), 'hex');
      return Buffer.concat([u16(r.seatIndex), i64(r.prediction), blinding]);
    })),
  ]);
}

function settle(players, oracle) {
  const awards = new Map();
  const returns = new Map();
  let rakeCollected = 0n;
  let previousLevel = 0n;
  const levels = [...new Set(players.map((p) => p.contribution).filter((v) => v > 0n))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const level of levels) {
    const height = level - previousLevel;
    const contributors = players
      .filter((p) => p.contribution >= level)
      .sort((a, b) => a.seatIndex - b.seatIndex);
    if (contributors.length === 1) {
      addAmount(returns, contributors[0].seatIndex, height);
      previousLevel = level;
      continue;
    }

    const potAmount = height * BigInt(contributors.length);
    const eligible = contributors.filter((p) => !p.folded);
    if (eligible.length === 0) {
      splitProRata(returns, potAmount, contributors);
      previousLevel = level;
      continue;
    }

    const rake = potRake(potAmount, RAKE_BPS, RAKE_CAP);
    rakeCollected += rake;
    const payable = potAmount - rake;
    const winners = potWinners(eligible, oracle.price);
    splitAward(awards, payable, winners);
    previousLevel = level;
  }

  const totalIn = players.reduce((acc, p) => acc + p.contribution, 0n);
  const totalOut = sumMap(awards) + sumMap(returns) + rakeCollected;
  if (totalIn !== totalOut) {
    throw new Error(`settlement conservation failed: in=${totalIn} out=${totalOut}`);
  }

  return {
    settlementPrice: oracle.price,
    potAwards: mapEntries(awards),
    uncalledReturns: mapEntries(returns),
    rakeCollected,
  };
}

function potWinners(eligible, settlementPrice) {
  if (eligible.length === 1) return eligible;
  let best = null;
  let winners = [];
  for (const player of eligible) {
    if (!player.hasPrediction) throw new Error(`seat ${player.seatIndex} is missing prediction`);
    const distance = absBigInt(player.prediction - settlementPrice);
    if (best === null || distance < best) {
      best = distance;
      winners = [player];
    } else if (distance === best) {
      winners.push(player);
    }
  }
  return winners;
}

function splitAward(out, amount, winners) {
  const base = amount / BigInt(winners.length);
  let remainder = amount % BigInt(winners.length);
  const ordered = [...winners].sort((a, b) => (
    a.sealSeq === b.sealSeq ? a.seatIndex - b.seatIndex : (a.sealSeq < b.sealSeq ? -1 : 1)
  ));
  for (const winner of ordered) {
    const extra = remainder > 0n ? 1n : 0n;
    addAmount(out, winner.seatIndex, base + extra);
    if (remainder > 0n) remainder -= 1n;
  }
}

function splitProRata(out, amount, contributors) {
  const base = amount / BigInt(contributors.length);
  let remainder = amount % BigInt(contributors.length);
  for (const contributor of contributors) {
    const extra = remainder > 0n ? 1n : 0n;
    addAmount(out, contributor.seatIndex, base + extra);
    if (remainder > 0n) remainder -= 1n;
  }
}

function potRake(amount, bps, cap) {
  const computed = (amount * BigInt(bps)) / 10_000n;
  const capped = computed < cap ? computed : cap;
  return capped < amount ? capped : amount;
}

function addAmount(map, seatIndex, amount) {
  if (amount === 0n) return;
  map.set(seatIndex, (map.get(seatIndex) ?? 0n) + amount);
}

function mapEntries(map) {
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seatIndex, amount]) => ({ seatIndex, amount }));
}

function sumMap(map) {
  return [...map.values()].reduce((acc, amount) => acc + amount, 0n);
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

async function assertPriceUpdateOwner(connection, priceUpdate, expectedOwner) {
  const account = await rpcRetry(
    `get pyth price update owner ${priceUpdate.toBase58()}`,
    () => connection.getAccountInfo(priceUpdate, 'confirmed'),
  );
  if (!account) throw new Error(`Pyth price update account not found: ${priceUpdate.toBase58()}`);
  if (!account.owner.equals(expectedOwner)) {
    throw new Error(
      `Pyth price update owner ${account.owner.toBase58()} != expected ${expectedOwner.toBase58()}`,
    );
  }
}

async function parsePythPriceUpdate(connection, priceUpdate) {
  const account = await rpcRetry(
    `get pyth price update ${priceUpdate.toBase58()}`,
    () => connection.getAccountInfo(priceUpdate, 'confirmed'),
  );
  if (!account) throw new Error(`Pyth price update account not found: ${priceUpdate.toBase58()}`);
  if (!account.owner.equals(PYTH_RECEIVER_PROGRAM_ID)) {
    throw new Error(`Pyth price update owner ${account.owner.toBase58()} != ${PYTH_RECEIVER_PROGRAM_ID.toBase58()}`);
  }
  const data = account.data;
  if (data.length < PRICE_UPDATE_MIN_LEN) {
    throw new Error(`Pyth price update account too short: ${data.length}, expected at least ${PRICE_UPDATE_MIN_LEN}`);
  }
  const verificationVariant = data.readUInt8(40);
  if (verificationVariant !== 1) {
    throw new Error(`Pyth price update is not fully verified; verification variant=${verificationVariant}`);
  }
  const offset = PRICE_MESSAGE_OFFSET;
  const feedId = Buffer.from(data.subarray(offset, offset + 32));
  const price = data.readBigInt64LE(offset + 32);
  const confidence = data.readBigUInt64LE(offset + 40);
  const exponent = data.readInt32LE(offset + 48);
  const publishTime = Number(data.readBigInt64LE(offset + 52));
  if (publishTime < 0) throw new Error(`negative Pyth publish time: ${publishTime}`);
  console.log(`pyth price update: ${priceUpdate.toBase58()} publish_time=${publishTime} price=${price} exponent=${exponent}`);
  return { feedId, price, confidence, exponent, publishTime };
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

async function sendVersionedTxWithRetry(connection, payer, name, transactionWithSigners) {
  let lastErr;
  for (let attempt = 0; attempt <= DEVNET_RPC_RETRIES; attempt += 1) {
    try {
      return await sendVersionedTx(connection, payer, name, transactionWithSigners);
    } catch (err) {
      lastErr = err;
      const message = retryableMessage(err);
      if (attempt === DEVNET_RPC_RETRIES || !/guardian_set|AccountNotInitialized|3012|429|Too Many Requests/i.test(message)) {
        throw err;
      }
      const delayMs = DEVNET_RPC_RETRY_BASE_MS * 2 ** Math.min(attempt, 5);
      console.warn(`${name} failed (${message}), retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function sendVersionedTx(connection, payer, name, transactionWithSigners) {
  await sleep(DEVNET_INTER_TX_DELAY_MS);
  const { tx, signers = [] } = transactionWithSigners;
  tx.sign([payer, ...signers]);
  const sim = await rpcRetry(`${name} simulate`, () => connection.simulateTransaction(tx, { sigVerify: true }));
  if (sim.value.err) {
    throw new Error(`${name} simulation failed: ${JSON.stringify(sim.value.err)} logs=${JSON.stringify(sim.value.logs)}`);
  }
  const serialized = tx.serialize();
  const sig = await rpcRetry(
    `${name} sendRawTransaction`,
    () => connection.sendRawTransaction(serialized, { skipPreflight: false, preflightCommitment: 'processed' }),
  );
  await rpcRetry(`${name} confirm`, () => connection.confirmTransaction(sig, 'confirmed'));
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

function persistPythAuditReceipt(receipt) {
  mkdirSync(RECEIPT_DIR, { recursive: true });
  const safeKey = receipt.idempotencyKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = join(RECEIPT_DIR, `${receipt.matchId}-${safeKey}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`pyth settlement receipt file: ${path}`);
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
