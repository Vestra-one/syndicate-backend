import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  normalizeFeedIdHex,
  redactSecrets,
} from './pyth.ts';
import {
  buildClaimPreview,
  buildCreateMatchPreview,
  buildLockMatchPreview,
  buildRefundPreview,
  buildDepositPreview,
  buildCreateAndDepositPreview,
  buildRegisterCommitmentPreview,
  CustodyError,
  settlementStatus,
  submitCreateMatch,
  submitLockMatch,
  submitBeginLive,
  submitVoidBeforeStart,
  submitVoidLiveAfterDeadline,
  submitWithdrawFees,
  deriveMatchPdas,
  type CustodyConfig,
  type CreateMatchInput,
  hashMatchId,
} from './custody.ts';
import {
  connectionVerifyRpc,
  verifyDepositTx,
  verifyCreateTx,
  enumerateSeatPdas,
} from './verify.ts';
import { templateAllowlist } from '../../config/src/index.ts';

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
  signedPriceServerUrl: string;
  confirmationTimeoutMs: number;
  computeUnitPriceMicroLamports: number;
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
          signedPriceServerUrl: config.signedPriceServerUrl,
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
      if (req.url === '/internal/solana/deposit') {
        const onchain = body.onchainMatchId ?? body.match?.onchainMatchId;
        return sendJson(res, 200, await buildDepositPreview(
          custodyConfig(config),
          String(body.wallet),
          numberArg(body.seatIndex ?? body.seat_index, 'seatIndex'),
          BigInt(String(onchain)),
        ));
      }
      if (req.url === '/internal/solana/create-and-deposit') {
        const input = body as CreateMatchInput & { wallet: string; seatIndex: number };
        return sendJson(res, 200, await buildCreateAndDepositPreview(custodyConfig(config), input));
      }
      if (req.url === '/internal/solana/register-commitment') {
        const onchain = body.onchainMatchId ?? body.match?.onchainMatchId;
        return sendJson(res, 200, await buildRegisterCommitmentPreview(
          custodyConfig(config),
          String(body.wallet),
          String(body.commitmentHex ?? body.commitment_hex),
          body.timelockTarget ?? body.timelock_target,
          BigInt(String(onchain)),
        ));
      }
      if (req.url === '/internal/solana/begin-live') {
        const onchain = body.onchainMatchId ?? body.match?.onchainMatchId;
        let seatWallets = ((body.seatWallets ?? body.seat_wallets ?? body.match?.seatWallets ?? []) as unknown[]).map((w) => String(w));
        // Authoritative seat set comes from chain (never the registry) — enumerate if not supplied.
        if (seatWallets.length === 0) {
          const { rpc, programId } = await verifyRpcFor(config);
          const pdas = deriveMatchPdas(programId, BigInt(String(onchain)));
          const seats = await enumerateSeatPdas(rpc, pdas.match);
          seatWallets = seats.map((s) => s.player);
        }
        return sendJson(res, 200, await submitBeginLive(custodyConfig(config), {
          onchainMatchId: BigInt(String(onchain)),
          seatWallets,
          buttonRandomnessHex: body.buttonRandomnessHex ?? body.button_randomness_hex,
        }));
      }
      if (req.url === '/internal/solana/void-before-start') {
        const onchain = body.onchainMatchId ?? body.match?.onchainMatchId;
        return sendJson(res, 200, await submitVoidBeforeStart(custodyConfig(config), BigInt(String(onchain))));
      }
      if (req.url === '/internal/solana/void-live-after-deadline') {
        const onchain = body.onchainMatchId ?? body.match?.onchainMatchId;
        return sendJson(res, 200, await submitVoidLiveAfterDeadline(custodyConfig(config), BigInt(String(onchain))));
      }
      if (req.url === '/internal/solana/verify-deposit') {
        const { rpc, programId } = await verifyRpcFor(config);
        const onchain = body.onchainMatchId ?? body.match?.onchainMatchId;
        const seatIdx = body.seatIndex ?? body.seat_index;
        return sendJson(res, 200, await verifyDepositTx(rpc, programId, {
          sig: requiredString(body.txSig ?? body.tx_sig ?? body.signature, 'txSig'),
          onchainMatchId: BigInt(String(onchain)),
          expectedPlayer: requiredString(body.wallet, 'wallet'),
          expectedSeatIndex: seatIdx === undefined ? undefined : numberArg(seatIdx, 'seatIndex'),
          allowlist: templateAllowlist(),
        }));
      }
      if (req.url === '/internal/solana/verify-create') {
        const { rpc, programId } = await verifyRpcFor(config);
        const onchain = body.onchainMatchId ?? body.match?.onchainMatchId;
        const seatIdx = body.seatIndex ?? body.seat_index;
        return sendJson(res, 200, await verifyCreateTx(rpc, programId, {
          sig: requiredString(body.txSig ?? body.tx_sig ?? body.signature, 'txSig'),
          onchainMatchId: BigInt(String(onchain)),
          expectedAuthority: requiredString(body.wallet, 'wallet'),
          expectedSeatIndex: seatIdx === undefined ? undefined : numberArg(seatIdx, 'seatIndex'),
          allowlist: templateAllowlist(),
        }));
      }
      if (req.url === '/internal/solana/enumerate-seats') {
        const { rpc, programId } = await verifyRpcFor(config);
        const onchain = body.onchainMatchId ?? body.match?.onchainMatchId;
        const pdas = deriveMatchPdas(programId, BigInt(String(onchain)));
        const seats = await enumerateSeatPdas(rpc, pdas.match);
        return sendJson(res, 200, { ok: true, matchPda: pdas.match.toBase58(), seats });
      }
      if (req.url === '/internal/solana/withdraw-fees') {
        const onchain = body.onchainMatchId ?? body.match?.onchainMatchId;
        const treasury = String(body.treasuryToken ?? body.treasury_token ?? process.env.TREASURY_TOKEN_ACCOUNT ?? '');
        if (!treasury) throw new HttpError(400, 'treasuryToken is required');
        return sendJson(res, 200, await submitWithdrawFees(
          custodyConfig(config),
          BigInt(String(onchain)),
          treasury,
        ));
      }
      if (req.url === '/internal/solana/submit-settlement') return sendJson(res, 200, await submitSettlement(config, body));
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
    signedPriceServerUrl: process.env.SIGNED_PRICE_SERVER_URL ?? 'http://127.0.0.1:8080',
    confirmationTimeoutMs: envInt('SETTLEMENT_CONFIRMATION_TIMEOUT_MS', 60_000),
    computeUnitPriceMicroLamports: envInt('SETTLEMENT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS', 100_000),
  };
}

async function resolvePyth(config: Config, body: any) {
  metrics.resolveTotal += 1;
  const symbol = requiredString(body.symbol, 'symbol').toUpperCase();
  const timestamp = Number(parseU64(body.scheduledEndTs ?? body.scheduled_end_ts, 'scheduledEndTs'));
  const url = new URL('/prices/at', config.signedPriceServerUrl);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('timestamp', String(timestamp));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(envInt('SIGNED_PRICE_HTTP_TIMEOUT_MS', 5_000)),
  });
  if (response.status === 404) return { available: false, reason: 'signed price unavailable' };
  if (!response.ok) throw new HttpError(424, `signed price server returned ${response.status}`);
  const bodyJson = await response.json();
  const signedPrice = requireObject(bodyJson.price ?? bodyJson, 'signed_price');
  validateSignedPriceResponse(signedPrice, symbol, timestamp, body.feedIdHex ?? body.feed_id_hex);
  const tokenFeedId = tokenFeedIdHex(field(signedPrice, 'token'));
  const price = {
    feed_id: tokenFeedId,
    price: requiredString(field(signedPrice, 'priceInWad', 'price_in_wad'), 'signed_price.price_in_wad'),
    publish_time: Math.floor(Number(parseU64(field(signedPrice, 'timestampMs', 'timestamp'), 'signed_price.timestamp')) / 1000),
    confidence: 0,
    exponent: -18,
  };
  return {
    available: true,
    price,
    signed_price: signedPrice,
    source_url: url.toString(),
  };
}

async function submitSettlement(config: Config, body: any) {
  metrics.submitSettlementTotal += 1;
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = await import('@solana/web3.js');
  const signer = Keypair.fromSecretKey(Uint8Array.from(readKeypair(config.signerKeypairPath)));
  const connection = new Connection(config.primaryRpcUrl, 'confirmed');
  const programId = new PublicKey(body.programId ?? config.programId);
  const bundle = requireObject(body.bundle, 'bundle');
  const signedPrice = requireObject(body.signedPrice ?? body.signed_price ?? bundle.signedPrice ?? bundle.signed_price, 'signed_price');
  const settlementBundle = { ...bundle, signed_price: signedPrice };
  const accounts = await deriveSyndicateAccounts(programId, requireObject(body.match, 'match'));
  const protocol = accounts.protocol;
  const match = accounts.match;
  const seats = accounts.seats;
  const settlementArgs = encodeSettleArgsFromBundle(settlementBundle);
  const submitSettlementIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: protocol, isSigner: false, isWritable: false },
      { pubkey: match, isSigner: false, isWritable: true },
      ...seats.map((seat) => ({ pubkey: seat, isSigner: false, isWritable: true })),
    ],
    data: Buffer.concat([discriminator('global:submit_settlement'), settlementArgs]),
  });
  const tx = new Transaction().add(submitSettlementIx);
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    throw new HttpError(422, `submit_settlement simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
  const serialized = tx.serialize();
  const txSig = await connection.sendRawTransaction(serialized, {
    skipPreflight: false,
    preflightCommitment: 'processed',
  });
  await withTimeout(connection.confirmTransaction({ signature: txSig, ...latest }, 'confirmed'), config.confirmationTimeoutMs, `confirmation timeout for ${txSig}`);
  if (config.secondaryRpcUrl) await verifyOnSecondary(config, txSig);
  return {
    tx_sig: txSig,
    txSig,
    signedPrice,
    computeUnits: sim.value.unitsConsumed ?? null,
    transactionSize: serialized.length,
    transactionCount: 1,
    mode: 'signed_price',
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

export async function deriveSyndicateAccounts(programId: any, matchContext: any) {
  const { PublicKey } = await import('@solana/web3.js');
  const onchainMatchId = parseU64(matchContext.onchainMatchId ?? matchContext.onchain_match_id, 'match.onchainMatchId');
  const matchSeed = Buffer.alloc(8);
  matchSeed.writeBigUInt64LE(onchainMatchId, 0);
  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], programId);
  const [match] = PublicKey.findProgramAddressSync([Buffer.from('match'), matchSeed], programId);
  const seatWallets = matchContext.seatWallets ?? matchContext.seat_wallets ?? [];
  if (!Array.isArray(seatWallets)) throw new HttpError(400, 'match.seatWallets must be an array');
  const seats = seatWallets.map((wallet: unknown) => {
    const player = new PublicKey(requiredString(wallet, 'match.seatWallets[]'));
    const [seat] = PublicKey.findProgramAddressSync([Buffer.from('seat'), match.toBuffer(), player.toBuffer()], programId);
    return seat;
  });
  return { protocol, match, seats };
}

export function encodeSettleArgsFromBundle(bundle: any): Buffer {
  const signedPrice = requireObject(bundle.signedPrice ?? bundle.signed_price, 'bundle.signed_price');
  const result = requireObject(bundle.result, 'bundle.result');
  const payouts = requireArray(bundle.payouts, 'bundle.payouts');
  // SettleArgs v1: signed_price, rake_collected, payouts (engine-indexed per-seat amounts).
  return Buffer.concat([
    addressBytes(field(signedPrice, 'token')),
    uint256Bytes(field(signedPrice, 'priceInWad', 'price_in_wad'), 'signed_price.price_in_wad'),
    u64(parseU64(field(signedPrice, 'timestampMs', 'timestamp'), 'signed_price.timestamp')),
    u8(numberField(signedPrice, 'v')),
    fixedHexBytes(field(signedPrice, 'r'), 32, 'signed_price.r'),
    fixedHexBytes(field(signedPrice, 's'), 32, 'signed_price.s'),
    u64(parseU64(field(result, 'rakeCollected', 'rake_collected'), 'result.rakeCollected')),
    vec(payouts.map((p) => Buffer.concat([
      u8(numberField(p, 'engineSeat', 'engine_seat')),
      u64(parseU64(field(p, 'amount'), 'payout.amount')),
    ]))),
  ]);
}

async function verifyOnSecondary(config: Config, txSig: string) {
  const { Connection } = await import('@solana/web3.js');
  const secondary = new Connection(config.secondaryRpcUrl, 'confirmed');
  const status = await secondary.getSignatureStatus(txSig, { searchTransactionHistory: true });
  if (!status.value) throw new HttpError(503, `secondary RPC did not observe signature ${txSig}`);
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

function numberArg(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new HttpError(400, `${name} must be an integer`);
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

function tokenFeedIdHex(value: unknown): string {
  return `0x${Buffer.concat([addressBytes(value), Buffer.alloc(12)]).toString('hex')}`;
}

function validateSignedPriceResponse(signedPrice: any, symbol: string, timestampSec: number, feedIdHex?: unknown) {
  const returnedSymbol = requiredString(field(signedPrice, 'symbol'), 'signed_price.symbol').toUpperCase();
  if (returnedSymbol !== symbol) throw new HttpError(422, 'signed price symbol mismatch');
  const timestampMs = Number(parseU64(field(signedPrice, 'timestampMs', 'timestamp'), 'signed_price.timestamp'));
  if (Math.floor(timestampMs / 1000) !== timestampSec) throw new HttpError(422, 'signed price timestamp mismatch');
  const price = parseIntegerBigInt(field(signedPrice, 'priceInWad', 'price_in_wad'), 'signed_price.price_in_wad');
  if (price <= 0n) throw new HttpError(422, 'signed price must be positive');
  if (feedIdHex !== undefined && normalizeFeedIdHex(feedIdHex) !== tokenFeedIdHex(field(signedPrice, 'token'))) {
    throw new HttpError(422, 'signed price token does not match feed id');
  }
}

function addressBytes(value: unknown): Buffer {
  return fixedHexBytes(value, 20, 'signed_price.token');
}

function fixedHexBytes(value: unknown, length: number, name: string): Buffer {
  const raw = requiredString(value, name).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(raw)) throw new HttpError(400, `${name} must be hex`);
  const out = Buffer.from(raw, 'hex');
  if (out.length !== length) throw new HttpError(400, `${name} must be ${length} bytes`);
  return out;
}

function uint256Bytes(value: unknown, name: string): Buffer {
  let parsed: bigint;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    parsed = BigInt(value);
  } else {
    parsed = parseIntegerBigInt(value, name);
  }
  if (parsed < 0n || parsed > 2n ** 256n - 1n) throw new HttpError(400, `${name} must fit uint256`);
  const out = Buffer.alloc(32);
  let cursor = parsed;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return out;
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

function u8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new HttpError(400, 'value must fit u8');
  return Buffer.from([value]);
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

/** A `finalized` Connection-backed verifier RPC + the resolved program id. */
async function verifyRpcFor(config: Config) {
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const connection = new Connection(config.primaryRpcUrl, 'finalized');
  const programId = new PublicKey(config.programId);
  return { rpc: connectionVerifyRpc(connection, programId), programId };
}

function statusFromError(err: unknown): number {
  if (err instanceof HttpError || err instanceof CustodyError) return err.status;
  return 500;
}
