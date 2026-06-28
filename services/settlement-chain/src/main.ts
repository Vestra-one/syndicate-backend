import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PYTH_HERMES_URL,
  PYTH_UNAVAILABLE_MESSAGE,
  fetchEarliestValidPythUpdate,
  normalizeFeedIdHex,
  redactSecrets,
  type PythCandidate,
} from './pyth.ts';
import {
  anchorDiscriminator,
  buildEd25519VerifyInstruction,
  buildActionIntentMessage,
  buildDefaultPolicyMessage,
  buildPredictionCommitmentMessage,
  decodeBase64Signature,
  decodeWalletPubkey,
  encodeAppendPlayerActionArgs,
  encodeAppendTimeoutActionArgs,
  encodeInitActionLogParams,
  encodeRegisterDefaultPolicyArgs,
  encodeRegisterPredictionCommitmentArgs,
  actionTagFromName,
  ED25519_PROGRAM_ID,
  IX_SYSVAR_ID,
} from './actionLog.ts';
import {
  buildClaimPreview,
  buildCreateMatchPreview,
  buildLockMatchPreview,
  buildRefundPreview,
  CustodyError,
  settlementStatus,
  submitCreateMatch,
  submitLockMatch,
  type CustodyConfig,
  type CreateMatchInput,
  hashMatchId,
} from './custody.ts';

type Config = {
  host: string;
  port: number;
  authToken: string;
  signerKeypairPath: string;
  signerPubkey?: string;
  primaryRpcUrl: string;
  secondaryRpcUrl?: string;
  programId: string;
  chipsTokenMint: string;
  hermesUrl: string;
  pythApiKey: string;
  receiverProgramId: string;
  wormholeProgramId: string;
  pushOracleProgramId: string;
  confirmationTimeoutMs: number;
  computeUnitPriceMicroLamports: number;
  allowTwoStepFallback: boolean;
};

const metrics = {
  resolveTotal: 0,
  submitSettlementTotal: 0,
  voidMatchTotal: 0,
  errorsTotal: 0,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfigFromEnv();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`settlement-chain listening on ${config.host}:${config.port}`);
  });
}

export function createServer(config: Config) {
  return createHttpServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
          ok: true,
          signer: config.signerPubkey ?? null,
          programId: config.programId,
          receiverProgramId: config.receiverProgramId,
          wormholeProgramId: config.wormholeProgramId,
          pushOracleProgramId: config.pushOracleProgramId,
        });
      }
      if (req.method === 'GET' && req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(metricsText());
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/matches/') && req.url.endsWith('/settlement-status')) {
        const matchId = req.url.slice('/matches/'.length, -'/settlement-status'.length);
        const url = new URL(req.url, 'http://local');
        const wallet = url.searchParams.get('wallet') ?? undefined;
        const onchainMatchId = url.searchParams.get('onchainMatchId') ?? undefined;
        return sendJson(res, 200, await settlementStatus(custodyConfig(config), matchId, wallet, onchainMatchId ?? undefined));
      }
      if (req.method === 'POST' && req.url === '/custody/claim-preview') {
        const body = await readJson(req);
        return sendJson(res, 200, await buildClaimPreview(
          custodyConfig(config),
          String(body.matchId),
          String(body.wallet),
          body.onchainMatchId,
        ));
      }
      if (req.method === 'POST' && req.url === '/custody/refund-preview') {
        const body = await readJson(req);
        return sendJson(res, 200, await buildRefundPreview(
          custodyConfig(config),
          String(body.matchId),
          String(body.wallet),
          body.onchainMatchId,
        ));
      }
      if (!req.url?.startsWith('/internal/') || req.method !== 'POST') return sendJson(res, 404, { error: 'not found' });
      if (!isAuthorized(req, config.authToken)) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readJson(req);
      if (req.url === '/internal/pyth/resolve') return sendJson(res, 200, await resolvePyth(config, body));
      if (req.url === '/internal/solana/create-match') {
        const input = body as CreateMatchInput;
        if (custodyChainEnabled(config)) {
          return sendJson(res, 200, await submitCreateMatch(custodyConfig(config), input));
        }
        return sendJson(res, 200, buildCreateMatchPreview(input));
      }
      if (req.url === '/internal/solana/lock-match') {
        if (custodyChainEnabled(config)) {
          return sendJson(res, 200, await submitLockMatch(custodyConfig(config), body));
        }
        return sendJson(res, 200, buildLockMatchPreview(String(body.onchainMatchId ?? body.matchId)));
      }
      if (req.url === '/internal/solana/submit-settlement') return sendJson(res, 200, await submitSettlement(config, body));
      if (req.url === '/internal/solana/sync-action-log') return sendJson(res, 200, await syncActionLog(config, body));
      if (req.url === '/internal/solana/void-match') return sendJson(res, 200, await voidMatch(config, body));
      if (req.url === '/internal/solana/claim-preview') {
        return sendJson(res, 200, await buildClaimPreview(
          custodyConfig(config),
          String(body.matchId),
          String(body.wallet),
          body.onchainMatchId ?? body.match?.onchainMatchId,
        ));
      }
      if (req.url === '/internal/solana/refund-preview') {
        return sendJson(res, 200, await buildRefundPreview(
          custodyConfig(config),
          String(body.matchId),
          String(body.wallet),
          body.onchainMatchId ?? body.match?.onchainMatchId,
        ));
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      metrics.errorsTotal += 1;
      const message = redactSecrets(err instanceof Error ? err.message : String(err), [
        config.authToken,
        config.pythApiKey,
        config.signerKeypairPath,
      ]);
      return sendJson(res, statusFromError(err), { error: message });
    }
  });
}

export function loadConfigFromEnv(): Config {
  const tokenPath = requiredEnv('SETTLEMENT_CHAIN_AUTH_TOKEN_FILE');
  const signerKeypairPath = requiredEnv('SETTLEMENT_SIGNER_KEYPAIR_PATH');
  const authToken = readSecret(tokenPath, 'SETTLEMENT_CHAIN_AUTH_TOKEN_FILE');
  return {
    host: process.env.SETTLEMENT_CHAIN_HOST ?? '127.0.0.1',
    port: envInt('SETTLEMENT_CHAIN_PORT', 8790),
    authToken,
    signerKeypairPath,
    primaryRpcUrl: requiredEnv('SOLANA_RPC_URL_PRIMARY'),
    secondaryRpcUrl: process.env.SOLANA_RPC_URL_SECONDARY || undefined,
    programId: requiredEnv('SYNDICATE_PROGRAM_ID'),
    chipsTokenMint: process.env.CHIPS_TOKEN_MINT ?? '',
    hermesUrl: process.env.PYTH_HERMES_URL ?? DEFAULT_PYTH_HERMES_URL,
    pythApiKey: requiredEnv('PYTH_API_KEY'),
    receiverProgramId: requiredEnv('PYTH_RECEIVER_PROGRAM_ID'),
    wormholeProgramId: requiredEnv('PYTH_WORMHOLE_PROGRAM_ID'),
    pushOracleProgramId: requiredEnv('PYTH_PUSH_ORACLE_PROGRAM_ID'),
    confirmationTimeoutMs: envInt('SETTLEMENT_CONFIRMATION_TIMEOUT_MS', 60_000),
    computeUnitPriceMicroLamports: envInt('SETTLEMENT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS', 100_000),
    allowTwoStepFallback: envBool('PYTH_ALLOW_TWO_STEP_FALLBACK', true),
  };
}

async function resolvePyth(config: Config, body: any) {
  metrics.resolveTotal += 1;
  const selected = await fetchEarliestValidPythUpdate({
    hermesUrl: config.hermesUrl,
    apiKey: config.pythApiKey,
    timeoutMs: envInt('PYTH_HTTP_TIMEOUT_MS', 5_000),
    rules: {
      feedIdHex: body.feedIdHex ?? body.feed_id_hex,
      scheduledEndTs: body.scheduledEndTs ?? body.scheduled_end_ts,
      oracleDelayWindowSec: body.oracleDelayWindowSec ?? body.oracle_delay_window_sec,
      maxConfidence: body.maxConfidence ?? body.max_confidence,
      expectedExponent: body.expectedExponent ?? body.expected_exponent,
    },
  });
  if (!selected) return { available: false, reason: PYTH_UNAVAILABLE_MESSAGE };
  return { available: true, selected: candidateJson(selected) };
}

async function submitSettlement(config: Config, body: any) {
  metrics.submitSettlementTotal += 1;
  const selected = await selectedFromBody(config, body);
  const { Connection, Keypair, PublicKey, TransactionInstruction } = await import('@solana/web3.js');
  const { Wallet } = await import('@coral-xyz/anchor');
  const { PythSolanaReceiver } = await import('@pythnetwork/pyth-solana-receiver');
  const signer = Keypair.fromSecretKey(Uint8Array.from(readKeypair(config.signerKeypairPath)));
  const connection = new Connection(config.primaryRpcUrl, 'confirmed');
  const wallet = new Wallet(signer);
  const receiver = new PythSolanaReceiver({
    connection,
    wallet,
    receiverProgramId: new PublicKey(config.receiverProgramId),
    wormholeProgramId: new PublicKey(config.wormholeProgramId),
    pushOracleProgramId: new PublicKey(config.pushOracleProgramId),
  });
  const programId = new PublicKey(body.programId ?? config.programId);
  const pythContext = requireObject(body.pyth, 'pyth');
  const rules = requireObject(pythContext.rules, 'pyth.rules');
  assertSelectedMatchesRules(selected, rules);
  const bundle = requireObject(body.bundle, 'bundle');
  assertBundleMatchesSelected(bundle, selected);
  const accounts = await deriveSyndicateAccounts(programId, requireObject(body.match, 'match'));
  const protocol = accounts.protocol;
  const match = accounts.match;
  const actionLog = accounts.actionLog;
  const seats = accounts.seats;
  const settlementArgs = encodeSettleArgsFromBundle(bundle);
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates(selected.priceUpdateData);
  let priceUpdateAccount: any = null;
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: (feedId: string) => any) => {
    priceUpdateAccount = getPriceUpdateAccount(selected.feedIdHex);
    if (!priceUpdateAccount) throw new Error(`Pyth builder did not expose price update account for ${selected.feedIdHex}`);
    return [{
      instruction: new TransactionInstruction({
        programId,
        keys: [
          { pubkey: signer.publicKey, isSigner: true, isWritable: false },
          { pubkey: protocol, isSigner: false, isWritable: false },
          { pubkey: match, isSigner: false, isWritable: true },
          { pubkey: actionLog, isSigner: false, isWritable: false },
          { pubkey: priceUpdateAccount, isSigner: false, isWritable: false },
          ...seats.map((seat) => ({ pubkey: seat, isSigner: false, isWritable: true })),
        ],
        data: Buffer.concat([discriminator('global:submit_settlement'), settlementArgs]),
      }),
      signers: [],
      computeUnits: envInt('SETTLEMENT_SUBMIT_COMPUTE_UNITS', 200_000),
    }];
  });
  priceUpdateAccount = priceUpdateAccount ?? builder.getPriceUpdateAccount(selected.feedIdHex);
  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: config.computeUnitPriceMicroLamports,
    tightComputeBudget: true,
  });
  if (txs.length !== 1 && !(body.allowTwoStepFallback ?? config.allowTwoStepFallback)) {
    throw new HttpError(409, `atomic Pyth settlement built ${txs.length} transactions and two-step fallback is disabled`);
  }
  const signatures = [];
  let computeUnits = null;
  let transactionSize = null;
  for (const [index, txWithSigners] of txs.entries()) {
    const sent = await sendVersionedTx(connection, signer, txWithSigners, config.confirmationTimeoutMs);
    signatures.push(sent.signature);
    if (index === txs.length - 1) {
      computeUnits = sent.computeUnits;
      transactionSize = sent.transactionSize;
    }
  }
  const txSig = signatures[signatures.length - 1];
  if (config.secondaryRpcUrl) await verifyOnSecondary(config, txSig);
  return {
    tx_sig: txSig,
    txSig,
    pyth_price_update_account: priceUpdateAccount.toBase58(),
    priceUpdateAccount: priceUpdateAccount.toBase58(),
    selected: candidateJson(selected),
    receiverProgramId: config.receiverProgramId,
    wormholeProgramId: config.wormholeProgramId,
    pushOracleProgramId: config.pushOracleProgramId,
    hermesResponseHash: selected.hermesResponseHash,
    binaryUpdateHash: selected.binaryUpdateHash,
    computeUnits,
    transactionSize,
    transactionCount: txs.length,
    mode: txs.length === 1 ? 'atomic' : 'two_step',
  };
}

async function voidMatch(config: Config, body: any) {
  metrics.voidMatchTotal += 1;
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = await import('@solana/web3.js');
  const signer = Keypair.fromSecretKey(Uint8Array.from(readKeypair(config.signerKeypairPath)));
  const connection = new Connection(config.primaryRpcUrl, 'confirmed');
  const programId = new PublicKey(body.programId ?? config.programId);
  const accounts = await deriveSyndicateAccounts(programId, requireObject(body.match, 'match'));
  const tx = new Transaction().add(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: accounts.protocol, isSigner: false, isWritable: false },
      { pubkey: accounts.match, isSigner: false, isWritable: true },
    ],
    data: discriminator('global:void'),
  }));
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) throw new HttpError(422, `void simulation failed: ${JSON.stringify(sim.value.err)}`);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'processed' });
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (config.secondaryRpcUrl) await verifyOnSecondary(config, signature);
  return { tx_sig: signature, txSig: signature, computeUnits: sim.value.unitsConsumed ?? null, transactionSize: tx.serialize().length };
}

async function syncActionLog(config: Config, body: any) {
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } = await import('@solana/web3.js');
  const signer = Keypair.fromSecretKey(Uint8Array.from(readKeypair(config.signerKeypairPath)));
  const connection = new Connection(config.primaryRpcUrl, 'confirmed');
  const programId = new PublicKey(body.programId ?? config.programId);
  const matchContext = requireObject(body.match, 'match');
  const accounts = await deriveSyndicateAccounts(programId, matchContext);
  const onchainMatchId = parseU64(matchContext.onchainMatchId ?? matchContext.onchain_match_id, 'match.onchainMatchId');
  const signingMatchId = parseU64(body.signingMatchId ?? body.signing_match_id ?? onchainMatchId, 'signingMatchId');
  const entries = requireArray(body.entries, 'entries');
  const signatures: string[] = [];

  if (body.init) {
    const init = requireObject(body.init, 'init');
    const sealSeq = requireArray(init.sealSeq ?? init.seal_seq, 'init.sealSeq').map((v: unknown, i: number) =>
      parseU64(v, `init.sealSeq[${i}]`),
    );
    while (sealSeq.length < 5) sealSeq.push(0n);
    const initData = Buffer.concat([
      anchorDiscriminator('global:init_action_log'),
      encodeInitActionLogParams({
        button: numberField(init, 'button'),
        smallBlind: parseU64(field(init, 'smallBlind', 'small_blind'), 'init.smallBlind'),
        bigBlind: parseU64(field(init, 'bigBlind', 'big_blind'), 'init.bigBlind'),
        roundCount: numberField(init, 'roundCount', 'round_count'),
        settleDeadlineTs: parseU64(field(init, 'settleDeadlineTs', 'settle_deadline_ts'), 'init.settleDeadlineTs'),
        sealSeq,
      }),
    ]);
    const seatWallets = matchContext.seatWallets ?? matchContext.seat_wallets ?? [];
    const seatPubkeys = seatWallets.map((w: unknown) => new PublicKey(requiredString(w, 'seat wallet')));
    const tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: accounts.protocol, isSigner: false, isWritable: false },
        { pubkey: accounts.match, isSigner: false, isWritable: true },
        { pubkey: accounts.actionLog, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...seatPubkeys.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: false })),
      ],
      data: initData,
    }));
    signatures.push(await sendLegacyTx(connection, signer, tx, config.confirmationTimeoutMs));
  }

  const ixSysvar = new PublicKey(IX_SYSVAR_ID);
  const ed25519Program = new PublicKey(ED25519_PROGRAM_ID);

  for (const entry of entries) {
    const kind = requiredString(entry.kind ?? entry.type, 'entry.kind');
    const tx = new Transaction();
    let ed25519IxIndex = 0;
    if (entry.signature) {
      const wallet = requiredString(entry.wallet, 'entry.wallet');
      const seatPubkey = decodeWalletPubkey(wallet);
      let message: Uint8Array;
      if (kind === 'player.action') {
        message = buildActionIntentMessage({
          matchId: signingMatchId,
          onchainMatchId,
          seatIndex: numberField(entry, 'seatIndex', 'seat_index'),
          wallet,
          nonce: parseU64(field(entry, 'nonce'), 'entry.nonce'),
          prevHeadHex: requiredString(field(entry, 'prevHeadHex', 'prev_head_hex'), 'entry.prevHeadHex'),
          actionTag: actionTagFromName(requiredString(field(entry, 'action', 'action_tag'), 'entry.action')),
          amount: parseU64(field(entry, 'amount') ?? 0, 'entry.amount'),
        });
      } else if (kind === 'default.registered') {
        message = buildDefaultPolicyMessage({
          matchId: signingMatchId,
          onchainMatchId,
          seatIndex: numberField(entry, 'seatIndex', 'seat_index'),
          wallet,
          policyTag: numberField(entry, 'policyTag', 'policy_tag'),
        });
      } else if (kind === 'prediction.commitment') {
        message = buildPredictionCommitmentMessage({
          matchId: signingMatchId,
          onchainMatchId,
          seatIndex: numberField(entry, 'seatIndex', 'seat_index'),
          wallet,
          sealSeq: parseU64(field(entry, 'sealSeq', 'seal_seq'), 'entry.sealSeq'),
          commitmentHex: requiredString(field(entry, 'commitmentHex', 'commitment_hex'), 'entry.commitmentHex'),
        });
      } else {
        throw new HttpError(400, `unsupported signed entry kind: ${kind}`);
      }
      const ed = buildEd25519VerifyInstruction({
        publicKey: seatPubkey,
        message,
        signature: decodeBase64Signature(requiredString(entry.signature, 'entry.signature')),
      });
      tx.add(new TransactionInstruction({
        programId: ed25519Program,
        keys: ed.keys,
        data: ed.data,
      }));
    }

    let programData: Buffer;
    let programKeys: { pubkey: any; isSigner: boolean; isWritable: boolean }[];
    if (kind === 'player.action') {
      programData = Buffer.concat([
        anchorDiscriminator('global:append_player_action'),
        encodeAppendPlayerActionArgs({
          seatIndex: numberField(entry, 'seatIndex', 'seat_index'),
          nonce: parseU64(field(entry, 'nonce'), 'entry.nonce'),
          actionTag: actionTagFromName(requiredString(field(entry, 'action', 'action_tag'), 'entry.action')),
          amount: parseU64(field(entry, 'amount') ?? 0, 'entry.amount'),
          ed25519IxIndex,
        }),
      ]);
      programKeys = [
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: accounts.protocol, isSigner: false, isWritable: false },
        { pubkey: accounts.match, isSigner: false, isWritable: false },
        { pubkey: accounts.actionLog, isSigner: false, isWritable: true },
        { pubkey: ixSysvar, isSigner: false, isWritable: false },
      ];
    } else if (kind === 'timeout.default') {
      programData = Buffer.concat([
        anchorDiscriminator('global:append_timeout_action'),
        encodeAppendTimeoutActionArgs(numberField(entry, 'seatIndex', 'seat_index')),
      ]);
      programKeys = [
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: accounts.protocol, isSigner: false, isWritable: false },
        { pubkey: accounts.match, isSigner: false, isWritable: false },
        { pubkey: accounts.actionLog, isSigner: false, isWritable: true },
      ];
    } else if (kind === 'default.registered') {
      programData = Buffer.concat([
        anchorDiscriminator('global:register_default_policy'),
        encodeRegisterDefaultPolicyArgs({
          seatIndex: numberField(entry, 'seatIndex', 'seat_index'),
          policyTag: numberField(entry, 'policyTag', 'policy_tag'),
          ed25519IxIndex,
        }),
      ]);
      programKeys = [
        { pubkey: new PublicKey(requiredString(entry.wallet, 'entry.wallet')), isSigner: false, isWritable: false },
        { pubkey: accounts.actionLog, isSigner: false, isWritable: true },
        { pubkey: accounts.match, isSigner: false, isWritable: false },
        { pubkey: ixSysvar, isSigner: false, isWritable: false },
      ];
    } else if (kind === 'prediction.commitment') {
      const commitment = Buffer.from(
        requiredString(field(entry, 'commitmentHex', 'commitment_hex'), 'entry.commitmentHex').replace(/^0x/, ''),
        'hex',
      );
      if (commitment.length !== 32) throw new HttpError(400, 'commitment must be 32 bytes');
      programData = Buffer.concat([
        anchorDiscriminator('global:register_prediction_commitment'),
        encodeRegisterPredictionCommitmentArgs({
          seatIndex: numberField(entry, 'seatIndex', 'seat_index'),
          sealSeq: parseU64(field(entry, 'sealSeq', 'seal_seq'), 'entry.sealSeq'),
          commitment: Uint8Array.from(commitment),
          ed25519IxIndex,
        }),
      ]);
      programKeys = [
        { pubkey: new PublicKey(requiredString(entry.wallet, 'entry.wallet')), isSigner: false, isWritable: false },
        { pubkey: accounts.actionLog, isSigner: false, isWritable: true },
        { pubkey: accounts.match, isSigner: false, isWritable: false },
        { pubkey: ixSysvar, isSigner: false, isWritable: false },
      ];
    } else {
      throw new HttpError(400, `unsupported action-log entry kind: ${kind}`);
    }
    tx.add(new TransactionInstruction({ programId, keys: programKeys, data: programData }));
    signatures.push(await sendLegacyTx(connection, signer, tx, config.confirmationTimeoutMs));
  }

  if (body.finalize) {
    const finalize = requireObject(body.finalize, 'finalize');
    const rootHex = requiredString(finalize.eventRootHex ?? finalize.event_root_hex, 'finalize.eventRootHex');
    const root = Buffer.from(rootHex.replace(/^0x/, ''), 'hex');
    if (root.length !== 32) throw new HttpError(400, 'eventRoot must be 32 bytes');
    const tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: accounts.protocol, isSigner: false, isWritable: false },
        { pubkey: accounts.match, isSigner: false, isWritable: false },
        { pubkey: accounts.actionLog, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([anchorDiscriminator('global:finalize_action_log'), root]),
    }));
    signatures.push(await sendLegacyTx(connection, signer, tx, config.confirmationTimeoutMs));
  }

  return { tx_sigs: signatures, count: signatures.length };
}

async function sendLegacyTx(connection: any, signer: any, tx: any, confirmationTimeoutMs: number): Promise<string> {
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) throw new HttpError(422, `transaction simulation failed: ${JSON.stringify(sim.value.err)}`);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'processed' });
  await withTimeout(connection.confirmTransaction({ signature, ...latest }, 'confirmed'), confirmationTimeoutMs, `confirmation timeout for ${signature}`);
  return signature;
}

export async function deriveSyndicateAccounts(programId: any, matchContext: any) {
  const { PublicKey } = await import('@solana/web3.js');
  const onchainMatchId = parseU64(matchContext.onchainMatchId ?? matchContext.onchain_match_id, 'match.onchainMatchId');
  const matchSeed = Buffer.alloc(8);
  matchSeed.writeBigUInt64LE(onchainMatchId, 0);
  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], programId);
  const [match] = PublicKey.findProgramAddressSync([Buffer.from('match'), matchSeed], programId);
  const [actionLog] = PublicKey.findProgramAddressSync([Buffer.from('actionlog'), match.toBuffer()], programId);
  const seatWallets = matchContext.seatWallets ?? matchContext.seat_wallets ?? [];
  if (!Array.isArray(seatWallets)) throw new HttpError(400, 'match.seatWallets must be an array');
  const seats = seatWallets.map((wallet: unknown) => {
    const player = new PublicKey(requiredString(wallet, 'match.seatWallets[]'));
    const [seat] = PublicKey.findProgramAddressSync([Buffer.from('seat'), match.toBuffer(), player.toBuffer()], programId);
    return seat;
  });
  return { protocol, match, actionLog, seats };
}

export function encodeSettleArgsFromBundle(bundle: any): Buffer {
  const oracle = requireObject(bundle.oraclePrice ?? bundle.oracle_price, 'bundle.oracle_price');
  const result = requireObject(bundle.result, 'bundle.result');
  const revealed = requireArray(bundle.revealed ?? bundle.revealed_predictions, 'bundle.revealed');
  return Buffer.concat([
    feedIdBytes(field(oracle, 'feedId', 'feed_id')),
    i64(parseI64(field(oracle, 'price'), 'oracle.price')),
    u64(parseU64(field(oracle, 'publishTime', 'publish_time'), 'oracle.publishTime')),
    u64(parseU64(field(oracle, 'confidence'), 'oracle.confidence')),
    i32(numberField(oracle, 'exponent')),
    i64(parseI64(field(result, 'settlementPrice', 'settlement_price'), 'result.settlementPrice')),
    u64(parseU64(field(result, 'oraclePublishTime', 'oracle_publish_time'), 'result.oraclePublishTime')),
    vec(requireArray(result.potAwards ?? result.pot_awards, 'result.potAwards').map((award) => Buffer.concat([
      u16(numberField(award, 'seatIndex', 'seat_index')),
      u64(parseU64(field(award, 'amount'), 'award.amount')),
    ]))),
    vec(requireArray(result.uncalledReturns ?? result.uncalled_returns, 'result.uncalledReturns').map((ret) => Buffer.concat([
      u16(numberField(ret, 'seatIndex', 'seat_index')),
      u64(parseU64(field(ret, 'amount'), 'return.amount')),
    ]))),
    u64(parseU64(field(result, 'rakeCollected', 'rake_collected'), 'result.rakeCollected')),
    vec(revealed.map((r) => {
      const blindingHex = requiredString(field(r, 'blinding', 'blinding_hex') ?? field(r, 'blindingHex', 'blinding_hex'), 'revealed.blinding');
      const blinding = Buffer.from(blindingHex.replace(/^0x/, ''), 'hex');
      if (blinding.length !== 32) throw new HttpError(400, 'revealed.blinding must be 32 bytes');
      return Buffer.concat([
        u16(numberField(r, 'seatIndex', 'seat_index')),
        i64(parseI64(field(r, 'prediction'), 'revealed.prediction')),
        blinding,
      ]);
    })),
  ]);
}

function assertSelectedMatchesRules(selected: PythCandidate, rules: any) {
  const feedIdHex = normalizeFeedIdHex(rules.feedIdHex ?? rules.feed_id_hex);
  const scheduledEndTs = Number(parseU64(rules.scheduledEndTs ?? rules.scheduled_end_ts, 'pyth.rules.scheduledEndTs'));
  const window = Number(parseU64(rules.oracleDelayWindowSec ?? rules.oracle_delay_window_sec, 'pyth.rules.oracleDelayWindowSec'));
  const maxConfidence = parseU64(rules.maxConfidence ?? rules.max_confidence, 'pyth.rules.maxConfidence');
  const expectedExponent = Number(rules.expectedExponent ?? rules.expected_exponent);
  if (selected.feedIdHex !== feedIdHex) throw new HttpError(422, 'selected Pyth feed does not match rules');
  if (selected.publishTime < scheduledEndTs || selected.publishTime > scheduledEndTs + window) {
    throw new HttpError(422, 'selected Pyth publish time is outside settlement window');
  }
  if (selected.exponent !== expectedExponent) throw new HttpError(422, 'selected Pyth exponent does not match rules');
  if (selected.confidence > maxConfidence) throw new HttpError(422, 'selected Pyth confidence exceeds rules');
}

function assertBundleMatchesSelected(bundle: any, selected: PythCandidate) {
  const oracle = requireObject(bundle.oraclePrice ?? bundle.oracle_price, 'bundle.oracle_price');
  if (normalizeFeedIdHex(field(oracle, 'feedId', 'feed_id')) !== selected.feedIdHex) {
    throw new HttpError(422, 'bundle oracle feed does not match selected Pyth proof');
  }
  if (parseI64(field(oracle, 'price'), 'oracle.price') !== selected.price) {
    throw new HttpError(422, 'bundle oracle price does not match selected Pyth proof');
  }
  if (Number(parseU64(field(oracle, 'publishTime', 'publish_time'), 'oracle.publishTime')) !== selected.publishTime) {
    throw new HttpError(422, 'bundle oracle publish time does not match selected Pyth proof');
  }
  if (parseU64(field(oracle, 'confidence'), 'oracle.confidence') !== selected.confidence) {
    throw new HttpError(422, 'bundle oracle confidence does not match selected Pyth proof');
  }
  if (Number(field(oracle, 'exponent')) !== selected.exponent) {
    throw new HttpError(422, 'bundle oracle exponent does not match selected Pyth proof');
  }
}

async function selectedFromBody(config: Config, body: any): Promise<PythCandidate> {
  if (body.selected) return reviveCandidate(body.selected);
  if (body.pyth?.selected) return reviveCandidate(body.pyth.selected);
  const resolve = await resolvePyth(config, body.pyth ?? body);
  if (!resolve.available) throw new HttpError(424, resolve.reason);
  return reviveCandidate(resolve.selected);
}

async function sendVersionedTx(connection: any, signer: any, txWithSigners: any, confirmationTimeoutMs: number) {
  const { tx, signers = [] } = txWithSigners;
  tx.sign([signer, ...signers]);
  const sim = await connection.simulateTransaction(tx, { sigVerify: true });
  if (sim.value.err) throw new HttpError(422, `transaction simulation failed: ${JSON.stringify(sim.value.err)}`);
  const serialized = tx.serialize();
  const signature = await connection.sendRawTransaction(serialized, { skipPreflight: false, preflightCommitment: 'processed' });
  await withTimeout(connection.confirmTransaction(signature, 'confirmed'), confirmationTimeoutMs, `confirmation timeout for ${signature}`);
  return { signature, computeUnits: sim.value.unitsConsumed ?? null, transactionSize: serialized.length };
}

async function verifyOnSecondary(config: Config, txSig: string) {
  const { Connection } = await import('@solana/web3.js');
  const secondary = new Connection(config.secondaryRpcUrl, 'confirmed');
  const status = await secondary.getSignatureStatus(txSig, { searchTransactionHistory: true });
  if (!status.value) throw new HttpError(503, `secondary RPC did not observe signature ${txSig}`);
}

function candidateJson(candidate: PythCandidate) {
  return {
    ...candidate,
    price: candidate.price.toString(),
    confidence: candidate.confidence.toString(),
  };
}

function reviveCandidate(value: any): PythCandidate {
  return {
    ...value,
    feedIdHex: normalizeFeedIdHex(value.feedIdHex),
    price: BigInt(value.price),
    confidence: BigInt(value.confidence),
    exponent: Number(value.exponent),
    publishTime: Number(value.publishTime),
    requestedTimestamp: Number(value.requestedTimestamp ?? value.publishTime),
    binaryDataHex: requireArray(value.binaryDataHex, 'selected.binaryDataHex'),
    priceUpdateData: requireArray(value.priceUpdateData, 'selected.priceUpdateData'),
    hermesResponseHash: requiredString(value.hermesResponseHash, 'selected.hermesResponseHash'),
    binaryUpdateHash: requiredString(value.binaryUpdateHash, 'selected.binaryUpdateHash'),
    hermesUrl: value.hermesUrl ?? DEFAULT_PYTH_HERMES_URL,
  };
}

function readKeypair(path: string): number[] {
  const bytes = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error('settlement signer keypair file must contain 64 bytes');
  if (bytes.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('settlement signer keypair contains invalid byte');
  return bytes;
}

function discriminator(preimage: string): Buffer {
  return createHash('sha256').update(preimage).digest().subarray(0, 8);
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
}

function metricsText(): string {
  return [
    `settlement_chain_pyth_resolve_total ${metrics.resolveTotal}`,
    `settlement_chain_submit_settlement_total ${metrics.submitSettlementTotal}`,
    `settlement_chain_void_match_total ${metrics.voidMatchTotal}`,
    `settlement_chain_errors_total ${metrics.errorsTotal}`,
    '',
  ].join('\n');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readSecret(path: string, name: string): string {
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error(`${name} points to an empty secret file`);
  return value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function field(obj: any, camel: string, snake?: string): any {
  if (obj && Object.prototype.hasOwnProperty.call(obj, camel)) return obj[camel];
  if (snake && obj && Object.prototype.hasOwnProperty.call(obj, snake)) return obj[snake];
  throw new HttpError(400, `${camel} is required`);
}

function numberField(obj: any, camel: string, snake?: string): number {
  const value = field(obj, camel, snake);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HttpError(400, `${camel} must be a safe integer`);
  }
  return value;
}

function boolField(obj: any, camel: string, snake?: string): boolean {
  const value = field(obj, camel, snake);
  if (typeof value !== 'boolean') throw new HttpError(400, `${camel} must be boolean`);
  return value;
}

function parseU64(value: unknown, name: string): bigint {
  const parsed = parseIntegerBigInt(value, name);
  if (parsed < 0n || parsed > 2n ** 64n - 1n) throw new HttpError(400, `${name} must fit u64`);
  return parsed;
}

function parseI64(value: unknown, name: string): bigint {
  const parsed = parseIntegerBigInt(value, name);
  if (parsed < -(2n ** 63n) || parsed > 2n ** 63n - 1n) throw new HttpError(400, `${name} must fit i64`);
  return parsed;
}

function parseIntegerBigInt(value: unknown, name: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new HttpError(400, `${name} must be an integer`);
}

function feedIdBytes(value: unknown): Buffer {
  return Buffer.from(normalizeFeedIdHex(value).slice(2), 'hex');
}

function vec(items: Buffer[]): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(items.length, 0);
  return Buffer.concat([len, ...items]);
}

function bool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

function u16(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new HttpError(400, 'value must fit u16');
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function i64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value, 0);
  return out;
}

function i32(value: number): Buffer {
  if (!Number.isInteger(value) || value < -(2 ** 31) || value > 2 ** 31 - 1) throw new HttpError(400, 'value must fit i32');
  const out = Buffer.alloc(4);
  out.writeInt32LE(value, 0);
  return out;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${name} is required`);
  return value;
}

function requireObject(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${name} is required`);
  return value as Record<string, any>;
}

function requireArray(value: unknown, name: string): any[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${name} is required`);
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new HttpError(504, message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function custodyConfig(config: Config): CustodyConfig {
  if (!config.chipsTokenMint) {
    throw new HttpError(503, 'CHIPS_TOKEN_MINT is required for on-chain custody operations');
  }
  return {
    primaryRpcUrl: config.primaryRpcUrl,
    programId: config.programId,
    chipsTokenMint: config.chipsTokenMint,
    signerKeypairPath: config.signerKeypairPath,
    confirmationTimeoutMs: config.confirmationTimeoutMs,
  };
}

function custodyChainEnabled(config: Config): boolean {
  return Boolean(config.chipsTokenMint);
}

function statusFromError(err: unknown): number {
  if (err instanceof HttpError || err instanceof CustodyError) return err.status;
  return 500;
}
