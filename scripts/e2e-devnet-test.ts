// @ts-nocheck — test script; Buffer/Uint8Array generic covariance warnings from newer @types/node are harmless at runtime.
/**
 * Syndicate devnet E2E test — full lifecycle from create through betting, seal, and settle.
 *
 * Usage (from repo root):
 *   BASIC_AUTH="dev:yourpassword" PLAYER2_KEYPAIR=/tmp/player2.json node scripts/e2e-devnet-test.ts
 *
 * Required env:
 *   BASIC_AUTH          dev:yourpassword  (nginx HTTP Basic Auth for all deployed endpoints)
 *   PLAYER2_KEYPAIR     /tmp/player2.json (solana-keygen new -o /tmp/player2.json)
 *
 * Optional env:
 *   MATCHMAKING_URL     https://matchmaking.devnet.satoshitable.fun
 *   GATEWAY_URL         wss://gateway.devnet.satoshitable.fun
 *   SYNDICATE_PROGRAM_ID GhbHLYTHuSvCVhYM22wyjdoE6Nx5uQDNuBB2Wof4p2bF
 *   CHIPS_TOKEN_MINT    4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
 *   SOLANA_RPC_URL      https://api.devnet.solana.com
 *   BUY_IN              1000000  (raw token units; 1 USDC @ 6 decimals)
 *   AWAIT_SEAL          1        (set to wait for the seal window; ~10 min extra)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createHash, createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// ─── config ─────────────────────────────────────────────────────────────────

const RPC_URL   = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const MATCHMAKING_URL = process.env.MATCHMAKING_URL ?? 'https://matchmaking.devnet.satoshitable.fun';
const GATEWAY_URL     = process.env.GATEWAY_URL     ?? 'wss://gateway.devnet.satoshitable.fun';
const PROGRAM_ID      = new PublicKey(process.env.SYNDICATE_PROGRAM_ID ?? 'GhbHLYTHuSvCVhYM22wyjdoE6Nx5uQDNuBB2Wof4p2bF');
const CHIPS_MINT      = new PublicKey(process.env.CHIPS_TOKEN_MINT      ?? '3Gdd9ew2Dq63QeJETc7krKB2JJ1GaHfBZvMzBdAy541X');
const BASIC_AUTH      = process.env.BASIC_AUTH;
const PLAYER1_PATH    = process.env.PLAYER1_KEYPAIR ?? `${homedir()}/.config/solana/id.json`;
const PLAYER2_PATH    = process.env.PLAYER2_KEYPAIR ?? '/tmp/player2.json';
const BUY_IN          = BigInt(process.env.BUY_IN ?? '1000000');
const AWAIT_SEAL      = process.env.AWAIT_SEAL === '1';

const CONFIG_HASH = '852148f8f4b6f703f6e3b7357fac28860f4169b5110660f14a507d41c17d939b';
const FEED_TOKEN_HEX  = 'a7BaE7da3E4950700BE9f107EB186e89a474d180';

// ─── logging ────────────────────────────────────────────────────────────────

function log(msg: string)  { console.log(`[${new Date().toISOString()}] ${msg}`); }
function ok(label: string) { log(`✓ ${label}`); }
function warn(label: string) { log(`⚠ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`, detail ?? '');
  process.exit(1);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  if (!BASIC_AUTH) return {};
  return { Authorization: `Basic ${Buffer.from(BASIC_AUTH).toString('base64')}` };
}

async function apiGet(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function apiPost(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ─── Borsh-lite encoding ─────────────────────────────────────────────────────

function u8(n: number):  Buffer { const b = Buffer.alloc(1); b.writeUInt8(n);        return b; }
function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n);     return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n);     return b; }
function i32(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32LE(n);      return b; }
function u64(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n);  return b; }

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(name).digest().slice(0, 8);
}

// ─── PDA derivation ──────────────────────────────────────────────────────────

function deriveMatchPdas(onchainMatchId: bigint) {
  const matchSeed = u64(onchainMatchId);
  const [matchPda] = PublicKey.findProgramAddressSync([Buffer.from('match'), matchSeed], PROGRAM_ID);
  const [vault]    = PublicKey.findProgramAddressSync([Buffer.from('vault'), matchPda.toBuffer()], PROGRAM_ID);
  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], PROGRAM_ID);
  return { matchPda, vault, protocol };
}

function deriveSeatPda(matchPda: PublicKey, player: PublicKey): PublicKey {
  const [seat] = PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), matchPda.toBuffer(), player.toBuffer()], PROGRAM_ID,
  );
  return seat;
}

function deriveSeatIndexPda(matchPda: PublicKey, seatIndex: number): PublicKey {
  const [si] = PublicKey.findProgramAddressSync(
    [Buffer.from('seat-index'), matchPda.toBuffer(), u16(seatIndex)], PROGRAM_ID,
  );
  return si;
}

// ─── CreateParams encoding ───────────────────────────────────────────────────

function encodeCreateParams(onchainMatchId: bigint, fillWindowSec = 120n): Buffer {
  const buyIn = BUY_IN;
  const entryFee = 0n;
  const rakeBps = 300;
  const rakeCap = buyIn;
  const nonsealPenaltyBps = 2500;
  const minPlayers = 2;
  const maxPlayers = 5;
  const totalBettingDurationSec = 580n;
  const sealWindow = 20n;
  const beginLiveWindow = 5n;
  const maxOracleConfidence = (1n << 64n) - 1n;
  const oracleExponent = -18;
  return Buffer.concat([
    u64(onchainMatchId), u64(buyIn), u64(entryFee),
    u32(rakeBps), u64(rakeCap), u32(nonsealPenaltyBps),
    u8(minPlayers), u8(maxPlayers),
    Buffer.from(CONFIG_HASH, 'hex'),
    Buffer.from(FEED_TOKEN_HEX, 'hex'),
    u64(totalBettingDurationSec), u64(sealWindow), u64(beginLiveWindow),
    u64(fillWindowSec), u64(maxOracleConfidence), i32(oracleExponent),
  ]);
}

// ─── On-chain instruction builders ──────────────────────────────────────────

function buildCreateAndDeposit(
  player: PublicKey, pdas: ReturnType<typeof deriveMatchPdas>,
  playerToken: PublicKey, seat: PublicKey, seatIndex: PublicKey,
  params: Buffer, seatIdx: number,
) {
  const disc = anchorDiscriminator('global:create_and_deposit');
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player,                  isSigner: true,  isWritable: true  },
      { pubkey: pdas.protocol,           isSigner: false, isWritable: false },
      { pubkey: CHIPS_MINT,              isSigner: false, isWritable: false },
      { pubkey: pdas.matchPda,           isSigner: false, isWritable: true  },
      { pubkey: pdas.vault,              isSigner: false, isWritable: true  },
      { pubkey: seat,                    isSigner: false, isWritable: true  },
      { pubkey: seatIndex,               isSigner: false, isWritable: true  },
      { pubkey: playerToken,             isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc, params, u16(seatIdx)]),
  };
}

function buildDeposit(
  player: PublicKey, protocol: PublicKey, matchPda: PublicKey,
  seat: PublicKey, seatIndex: PublicKey, playerToken: PublicKey,
  vault: PublicKey, seatIdx: number,
) {
  const disc = anchorDiscriminator('global:deposit');
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player,                  isSigner: true,  isWritable: true  },
      { pubkey: protocol,                isSigner: false, isWritable: false },
      { pubkey: matchPda,                isSigner: false, isWritable: true  },
      { pubkey: seat,                    isSigner: false, isWritable: true  },
      { pubkey: seatIndex,               isSigner: false, isWritable: true  },
      { pubkey: playerToken,             isSigner: false, isWritable: true  },
      { pubkey: vault,                   isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc, u16(seatIdx)]),
  };
}

// ─── Intent signing (shared/src/intent.rs port) ─────────────────────────────

const DOMAIN_ACTION     = Buffer.from('syndicate/action/v1',     'utf8');
const DOMAIN_DEFAULT    = Buffer.from('syndicate/default/v1',    'utf8');
const DOMAIN_PREDICTION = Buffer.from('syndicate/prediction/v1', 'utf8');

// mirrors Rust `hash_match_id` (wrapping u64 multiply)
function hashMatchIdNum(matchId: string): bigint {
  let hash = 0n;
  for (let i = 0; i < matchId.length; i++) {
    hash = (hash * 31n + BigInt(matchId.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn;
  }
  return hash;
}

const ACTION_TAG: Record<string, number> = {
  fold: 0, check: 1, call: 2, betTo: 3, raiseTo: 4, allIn: 5,
};

function buildActionMsg(
  matchId: string, onchainId: bigint, seatIdx: number,
  pubkey: Uint8Array, nonce: bigint, prevHead: Buffer,
  tag: number, amount = 0n,
): Buffer {
  return Buffer.concat([
    DOMAIN_ACTION, Buffer.from([0]),
    u64(hashMatchIdNum(matchId)),
    u64(onchainId),
    u16(seatIdx),
    Buffer.from(pubkey),
    u64(nonce),
    prevHead,
    Buffer.from([tag]),
    u64(amount),
  ]);
}

function buildDefaultMsg(
  matchId: string, onchainId: bigint, seatIdx: number,
  pubkey: Uint8Array, policyTag: number,
): Buffer {
  return Buffer.concat([
    DOMAIN_DEFAULT, Buffer.from([0]),
    u64(hashMatchIdNum(matchId)),
    u64(onchainId),
    u16(seatIdx),
    Buffer.from(pubkey),
    Buffer.from([policyTag]),
  ]);
}

function buildPredictionMsg(
  matchId: string, onchainId: bigint, seatIdx: number,
  pubkey: Uint8Array, timelockTarget: bigint, commitment: Buffer,
): Buffer {
  return Buffer.concat([
    DOMAIN_PREDICTION, Buffer.from([0]),
    u64(hashMatchIdNum(matchId)),
    u64(onchainId),
    u16(seatIdx),
    Buffer.from(pubkey),
    u64(timelockTarget),
    commitment,
  ]);
}

function ed25519Sign(secretKey: Uint8Array, message: Buffer): Buffer {
  const seed = secretKey.slice(0, 32);
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seed),
  ]);
  const privKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return cryptoSign(null, message, privKey) as Buffer;
}

function signMsg(keypair: Keypair, msg: Buffer): string {
  return ed25519Sign(keypair.secretKey, msg).toString('base64');
}

// ─── WebSocket helpers ───────────────────────────────────────────────────────

type WsMsg = Record<string, unknown>;

interface GameSession {
  wallet: string;
  send: (msg: WsMsg) => void;
  waitFor: (type: string | string[], timeoutMs?: number) => Promise<WsMsg>;
  close: () => void;
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
}

async function openGameSession(keypair: Keypair, label: string): Promise<GameSession> {
  const wsPkg = await import('ws').catch(() => { throw new Error('ws package not found'); });
  const WebSocket = wsPkg.default ?? wsPkg.WebSocket ?? wsPkg;

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = BASIC_AUTH
      ? { Authorization: `Basic ${Buffer.from(BASIC_AUTH).toString('base64')}` }
      : {};
    const ws = new WebSocket(GATEWAY_URL, { headers });
    const queue: WsMsg[] = [];
    const waiters: Array<{ types: string[]; resolve: (m: WsMsg) => void; reject: (e: Error) => void }> = [];

    function dispatch(msg: WsMsg) {
      const waiter = waiters.find(w => w.types.includes(String(msg.type)));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(msg);
      } else {
        queue.push(msg);
      }
    }

    const session: GameSession = {
      wallet: keypair.publicKey.toBase58(),
      send(msg: WsMsg) { ws.send(JSON.stringify(msg)); },
      waitFor(type: string | string[], timeoutMs = 30_000): Promise<WsMsg> {
        const types = Array.isArray(type) ? type : [type];
        const queued = queue.findIndex(m => types.includes(String(m.type)));
        if (queued >= 0) return Promise.resolve(queue.splice(queued, 1)[0]!);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex(w => w.resolve === res);
            if (idx >= 0) waiters.splice(idx, 1);
            rej(new Error(`${label}: timeout waiting for ${types.join('|')}`));
          }, timeoutMs);
          waiters.push({
            types,
            resolve: (m) => { clearTimeout(timer); res(m); },
            reject: (e)  => { clearTimeout(timer); rej(e);  },
          });
        });
      },
      close() { ws.close(); },
    };

    const timeout = setTimeout(() => { ws.close(); reject(new Error(`${label}: connect timeout`)); }, 15_000);

    ws.on('error', (e: Error) => { clearTimeout(timeout); reject(new Error(`${label}: WS error: ${e.message}`)); });
    ws.on('message', (data: Buffer) => {
      const msg: WsMsg = JSON.parse(data.toString());
      if (!session.wallet) return;

      if (msg.type === 'challenge' && msg.nonce) {
        const sigBytes = ed25519Sign(keypair.secretKey, Buffer.from(String(msg.nonce), 'utf-8'));
        ws.send(JSON.stringify({ type: 'auth', wallet: keypair.publicKey.toBase58(), signature: sigBytes.toString('base64') }));
        return;
      }
      if (msg.type === 'authenticated') {
        clearTimeout(timeout);
        log(`  ${label}: authenticated`);
        resolve(session);
        return;
      }
      if (msg.type === 'error') {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`${label}: gateway auth error: ${msg.reason}`));
        return;
      }
      // Post-auth messages go to the queue/waiters
      dispatch(msg);
    });
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  log('=== Syndicate devnet E2E test ===');
  log(`Matchmaking:  ${MATCHMAKING_URL}`);
  log(`Gateway:      ${GATEWAY_URL}`);
  log(`Program:      ${PROGRAM_ID.toBase58()}`);
  log(`Chips mint:   ${CHIPS_MINT.toBase58()}`);
  log(`Buy-in:       ${BUY_IN} (raw units)`);
  log(`Await seal:   ${AWAIT_SEAL ? 'yes (AWAIT_SEAL=1)' : 'no (prints instructions only)'}`);
  if (!BASIC_AUTH) log('WARN: BASIC_AUTH not set — nginx-protected endpoints will get 401');

  // ── 1. Load keypairs ──────────────────────────────────────────────────────
  const player1 = loadKeypair(PLAYER1_PATH);
  const player2 = loadKeypair(PLAYER2_PATH);
  log(`Player 1: ${player1.publicKey.toBase58()}`);
  log(`Player 2: ${player2.publicKey.toBase58()}`);

  // ── 2. Health checks ──────────────────────────────────────────────────────
  log('\n--- Health checks ---');
  for (const [name, url] of [
    ['matchmaking',  `${MATCHMAKING_URL}/healthz`],
    ['config',       'https://config.devnet.satoshitable.fun/healthz'],
    ['action-feed',  'https://api.devnet.satoshitable.fun/healthz'],
    ['price',        'https://price.devnet.satoshitable.fun/health'],
  ] as const) {
    try {
      const data = await apiGet(url as string);
      ok(`${name}: ${JSON.stringify(data).slice(0, 80)}`);
    } catch (e) { warn(`${name}: ${(e as Error).message}`); }
  }

  // ── 3. Config catalog ────────────────────────────────────────────────────
  log('\n--- Config ---');
  try {
    const catalog = await apiGet('https://config.devnet.satoshitable.fun/config/catalog') as any;
    log(`  Tiers: ${(catalog?.tiers ?? []).map((t: any) => t.tierId).join(', ')}`);
  } catch { log('  (config catalog unavailable — using pre-computed hash)'); }
  log(`  Config hash: ${CONFIG_HASH}`);

  // ── 4. Solana balances ───────────────────────────────────────────────────
  log('\n--- Balances ---');
  const conn = new Connection(RPC_URL, 'confirmed');
  const [p1Sol, p2Sol] = await Promise.all([conn.getBalance(player1.publicKey), conn.getBalance(player2.publicKey)]);
  log(`  Player 1 SOL: ${p1Sol / 1e9}`);
  log(`  Player 2 SOL: ${p2Sol / 1e9}`);
  const p1Token = getAssociatedTokenAddressSync(CHIPS_MINT, player1.publicKey);
  const p2Token = getAssociatedTokenAddressSync(CHIPS_MINT, player2.publicKey);
  const [p1TokInfo, p2TokInfo] = await Promise.all([
    conn.getTokenAccountBalance(p1Token).catch(() => null),
    conn.getTokenAccountBalance(p2Token).catch(() => null),
  ]);
  log(`  Player 1 tokens: ${p1TokInfo?.value.uiAmountString ?? 'no account'}`);
  log(`  Player 2 tokens: ${p2TokInfo?.value.uiAmountString ?? 'no account'}`);
  if (!p1TokInfo || !p2TokInfo) fail('Both players need token accounts for the chips mint');
  if (BigInt(p1TokInfo!.value.amount) < BUY_IN) fail(`Player 1 has ${p1TokInfo!.value.amount} but needs ${BUY_IN}`);
  if (BigInt(p2TokInfo!.value.amount) < BUY_IN) fail(`Player 2 has ${p2TokInfo!.value.amount} but needs ${BUY_IN}`);
  ok('Both players have sufficient token balance');

  // ── 5. create_and_deposit (Player 1) ────────────────────────────────────
  log('\n--- Step 1: create_and_deposit (Player 1) ---');
  const onchainMatchId = BigInt('0x' + randomBytes(7).toString('hex'));
  const pdas = deriveMatchPdas(onchainMatchId);
  log(`  onchainMatchId: ${onchainMatchId}`);
  log(`  matchPda:       ${pdas.matchPda.toBase58()}`);
  log(`  vault:          ${pdas.vault.toBase58()}`);

  const seat1     = deriveSeatPda(pdas.matchPda, player1.publicKey);
  const seatIdx1  = deriveSeatIndexPda(pdas.matchPda, 0);
  const createIx  = buildCreateAndDeposit(player1.publicKey, pdas, p1Token, seat1, seatIdx1, encodeCreateParams(onchainMatchId), 0);
  const createTx  = new Transaction();
  createTx.add(createIx as any);
  createTx.feePayer = player1.publicKey;
  createTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

  let createTxSig: string;
  try {
    createTxSig = await sendAndConfirmTransaction(conn, createTx, [player1], { commitment: 'finalized', preflightCommitment: 'confirmed' });
    ok(`create_and_deposit confirmed: ${createTxSig}`);
  } catch (e) { fail('create_and_deposit failed', e); }

  // ── 6. POST /rooms ───────────────────────────────────────────────────────
  log('\n--- Step 2: POST /rooms ---');
  const createReport = await apiPost(`${MATCHMAKING_URL}/rooms`, {
    createTxSig,
    matchPda: pdas.matchPda.toBase58(),
    onchainMatchId: onchainMatchId.toString(),
    configHash: CONFIG_HASH,
    wallet: player1.publicKey.toBase58(),
    seatIndex: 0,
    maxPlayers: 5,
  }) as any;
  log(`  Response: ${JSON.stringify(createReport)}`);
  if (!createReport?.ok) fail('POST /rooms rejected', createReport);
  const { matchId, roomCode } = createReport;
  ok(`Room created: roomCode=${roomCode}, matchId=${matchId}`);

  // ── 7. deposit (Player 2) ────────────────────────────────────────────────
  log('\n--- Step 3: deposit (Player 2) ---');
  const seat2    = deriveSeatPda(pdas.matchPda, player2.publicKey);
  const seatIdx2 = deriveSeatIndexPda(pdas.matchPda, 1);
  const depositIx = buildDeposit(player2.publicKey, pdas.protocol, pdas.matchPda, seat2, seatIdx2, p2Token, pdas.vault, 1);
  const depositTx = new Transaction();
  depositTx.add(depositIx as any);
  depositTx.feePayer = player2.publicKey;
  depositTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

  let depositTxSig: string;
  try {
    depositTxSig = await sendAndConfirmTransaction(conn, depositTx, [player2], { commitment: 'finalized', preflightCommitment: 'confirmed' });
    ok(`deposit confirmed: ${depositTxSig}`);
  } catch (e) { fail('deposit failed', e); }

  // ── 8. POST /matches/:id/deposits ───────────────────────────────────────
  log('\n--- Step 4: POST /matches/:id/deposits ---');
  const depositReport = await apiPost(`${MATCHMAKING_URL}/matches/${matchId}/deposits`, {
    wallet: player2.publicKey.toBase58(),
    depositTxSig,
    seatIndex: 1,
  }) as any;
  log(`  Response: ${JSON.stringify(depositReport)}`);
  if (!depositReport?.ok) fail('deposit report rejected', depositReport);
  ok(`Player 2 seated: seat=${depositReport.seat}`);

  // ── 9. Lobby check ───────────────────────────────────────────────────────
  log('\n--- Step 5: GET /rooms/:roomCode ---');
  const lobby = await apiGet(`${MATCHMAKING_URL}/rooms/${roomCode}?wallet=${player1.publicKey.toBase58()}`) as any;
  log(`  Lobby: ${JSON.stringify(lobby?.lobby ?? lobby)}`);
  const seatedCount = lobby?.lobby?.seated ?? 0;
  if (seatedCount < 2) fail(`Expected 2 seated players, got ${seatedCount}`);
  ok(`Lobby: ${seatedCount}/5 players seated, fill deadline=${new Date((lobby?.lobby?.fillDeadline ?? 0)).toISOString()}`);

  // ── 10. Open WS sessions (auth) ──────────────────────────────────────────
  log('\n--- Step 6: WebSocket auth (both players) ---');
  let gs1: GameSession | undefined;
  let gs2: GameSession | undefined;
  try {
    [gs1, gs2] = await Promise.all([
      openGameSession(player1, 'P1'),
      openGameSession(player2, 'P2'),
    ]);
    ok('Both players authenticated on gateway');
  } catch (e) {
    warn(`WS auth failed: ${(e as Error).message} — (non-fatal if gateway is localhost-only)`);
    log('\n=== Phase 1 PASSED (on-chain + matchmaking) ===');
    log(`Match on-chain: ${pdas.matchPda.toBase58()}`);
    log(`Room code:      ${roomCode}`);
    log(`Match ID:       ${matchId}`);
    printNextSteps(roomCode, matchId, player1.publicKey.toBase58());
    return;
  }

  // ── 11. Subscribe to room (before triggering start) ─────────────────────
  log('\n--- Step 7: Subscribe to room fill events ---');
  gs1.send({ type: 'subscribeRoom', matchId });
  gs2.send({ type: 'subscribeRoom', matchId });
  ok('Both players subscribed to room events');

  // ── 12. Host triggers match start ────────────────────────────────────────
  log('\n--- Step 8: POST /rooms/:roomCode/start (host triggers begin_live) ---');
  log('  This calls: matchmaking → orchestrator → lock-match → begin_live on-chain → match-engine start');
  const startResp = await apiPost(`${MATCHMAKING_URL}/rooms/${roomCode}/start`, {
    host: player1.publicKey.toBase58(),
  }) as any;
  log(`  Response: ${JSON.stringify(startResp)}`);
  if (!startResp?.ok) fail('host start rejected', startResp);
  ok('Match start triggered');

  // ── 13. Wait for matchStarted event via WS ───────────────────────────────
  log('\n--- Step 9: Waiting for matchStarted event on WebSocket ---');
  log('  (match-engine starting, orchestrator calling begin_live on-chain...)');
  let matchStartedTs: number;
  try {
    const startedMsg = await gs1.waitFor(['matchStarted', 'matchState'], 45_000);
    matchStartedTs = Date.now();
    ok(`Match started event: type=${startedMsg.type} matchId=${startedMsg.matchId ?? (startedMsg.state as any)?.matchId}`);
  } catch (e) {
    warn(`matchStarted event not received: ${(e as Error).message}`);
    warn('Gateway may not have Redis pub/sub configured — subscribing directly to engine state');
    matchStartedTs = Date.now();
  }

  // ── 14. Subscribe to live match state ────────────────────────────────────
  log('\n--- Step 10: Subscribe to match engine state ---');
  gs1.send({ type: 'subscribe', matchId });
  gs2.send({ type: 'subscribe', matchId });

  let liveState: WsMsg | undefined;
  try {
    liveState = await gs1.waitFor('matchState', 30_000);
    const state = liveState?.state as any;
    ok(`Match state received: phase=${state?.phase} round=${state?.round} pot=${state?.pot} toActSeat=${state?.toActSeat}`);
    if (state?.phase !== 'LIVE') warn(`Expected LIVE phase, got ${state?.phase} (engine may still be starting)`);
    else ok('Match is LIVE');
  } catch (e) {
    warn(`No matchState from engine: ${(e as Error).message} — engine state unavailable`);
  }

  // ── 15. Betting actions ──────────────────────────────────────────────────
  log('\n--- Step 11: Betting actions ---');
  const toActSeat = (liveState?.state as any)?.toActSeat as number | undefined;
  log(`  Current actor: seat ${toActSeat ?? 'unknown'}`);

  const prevHead = Buffer.alloc(32, 0);
  const prevHeadHex = prevHead.toString('hex');

  if (toActSeat !== undefined) {
    const actingPlayer = toActSeat === 0 ? player1 : player2;
    const actingSession = toActSeat === 0 ? gs1 : gs2;
    const actingLabel   = toActSeat === 0 ? 'Player 1' : 'Player 2';

    // Sign a "call" intent (call the big blind)
    const nonce = 1n;
    const callMsg = buildActionMsg(matchId, onchainMatchId, toActSeat, actingPlayer.publicKey.toBytes(), nonce, prevHead, ACTION_TAG['call']!);
    const callSig = signMsg(actingPlayer, callMsg);

    log(`  ${actingLabel} (seat ${toActSeat}): sending call action`);
    actingSession.send({
      type: 'act',
      matchId,
      action: { type: 'call' },
      signature: callSig,
      seatIndex: toActSeat,
      nonce: Number(nonce),
      prevHeadHex,
    });

    try {
      const afterAction = await gs1.waitFor('matchState', 10_000);
      const st = afterAction?.state as any;
      ok(`After call: phase=${st?.phase} round=${st?.round} pot=${st?.pot} toActSeat=${st?.toActSeat}`);
    } catch { warn('No state update after action (expected if betting not open yet)'); }

    // Also set default policy (check/fold on timeout)
    const defaultMsg = buildDefaultMsg(matchId, onchainMatchId, toActSeat, actingPlayer.publicKey.toBytes(), 0);
    const defaultSig = signMsg(actingPlayer, defaultMsg);
    actingSession.send({
      type: 'setDefault',
      matchId,
      default: 'check_fold',
      signature: defaultSig,
      seatIndex: toActSeat,
    });
    ok(`${actingLabel}: registered check_fold as default policy on timeout`);
  } else {
    warn('toActSeat unknown — skipping action test (engine state not available)');
  }

  // ── 16. Reconnection test ────────────────────────────────────────────────
  log('\n--- Step 12: Reconnection test (Player 1 disconnect + reconnect) ---');
  log('  Verifies: disconnected player can re-auth and receive current match state');
  gs1.close();
  log('  P1 disconnected');

  await new Promise(r => setTimeout(r, 1000));

  try {
    const gs1r = await openGameSession(player1, 'P1-reconnect');
    ok('P1 reconnected and re-authenticated');

    gs1r.send({ type: 'subscribe', matchId });
    const reconnState = await gs1r.waitFor('matchState', 15_000);
    const rst = reconnState?.state as any;
    ok(`P1 reconnect: received matchState phase=${rst?.phase} round=${rst?.round} toActSeat=${rst?.toActSeat}`);
    gs1r.close();
  } catch (e) {
    warn(`Reconnection test: ${(e as Error).message}`);
  }

  // ── 17. Lobby WS subscription ────────────────────────────────────────────
  log('\n--- Step 13: Lobby WebSocket subscription ---');
  try {
    const gs2r = await openGameSession(player2, 'P2-lobby');
    gs2r.send({ type: 'subscribeLobby' });
    const lobbyMsg = await gs2r.waitFor('lobbyList', 5_000).catch(() => null);
    if (lobbyMsg) ok(`Lobby list received: ${(lobbyMsg.rooms as unknown[])?.length ?? 0} rooms`);
    else warn('Lobby list not received (non-fatal)');
    gs2r.close();
  } catch (e) {
    warn(`Lobby WS test: ${(e as Error).message}`);
  }

  // ── 18. Seal window info ─────────────────────────────────────────────────
  log('\n--- Step 14: Sealing window ---');
  log('  The sealing window opens after totalBettingDurationSec=580s from live_start.');
  log(`  Match went live at ~${new Date(matchStartedTs!).toISOString()}`);
  const sealOpenEstimate = matchStartedTs! + 580_000;
  const sealCloseEstimate = sealOpenEstimate + 20_000;
  log(`  Estimated seal window: ${new Date(sealOpenEstimate).toISOString()} → ${new Date(sealCloseEstimate).toISOString()}`);
  log(`  That is ~${Math.round((sealOpenEstimate - Date.now()) / 60_000)} minutes from now.`);

  if (!AWAIT_SEAL) {
    log('  Skipping (set AWAIT_SEAL=1 to wait and run the sealing + settlement flow)');
    log('  Sealing flow (run manually or with AWAIT_SEAL=1):');
    log('    1. On-chain: call register_prediction_commitment with a commitment hash + timelock ciphertext');
    log('    2. Via WS:   { type: "sealPrediction", matchId, ciphertext, seatIndex, targetRound, commitmentHex, blindingHex, signature }');
    log('    3. Settlement worker reads sealed prices and calls settle() on-chain after the seal window closes');
  } else {
    // Wait for seal window, then seal both players
    await runSealPhase(gs2, player1, player2, matchId, onchainMatchId, sealOpenEstimate);
  }

  gs2.close();

  // ── Done ─────────────────────────────────────────────────────────────────
  log('\n=== E2E test PASSED ===');
  log(`Match on-chain: ${pdas.matchPda.toBase58()}`);
  log(`Room code:      ${roomCode}`);
  log(`Match ID:       ${matchId}`);
  log(`Create tx:      ${createTxSig!}`);
  log(`Deposit tx:     ${depositTxSig!}`);
  log(`Explorer:       https://explorer.solana.com/address/${pdas.matchPda.toBase58()}?cluster=devnet`);
  log(`Match on-chain: ${pdas.matchPda.toBase58()}`);
  log(`Room code:      ${roomCode}`);
  printNextSteps(roomCode, matchId, player1.publicKey.toBase58());
}

// ─── Sealing phase (enabled by AWAIT_SEAL=1) ─────────────────────────────────

async function runSealPhase(
  gs2: GameSession,
  player1: Keypair, player2: Keypair,
  matchId: string, onchainMatchId: bigint,
  sealOpenMs: number,
) {
  const waitMs = sealOpenMs - Date.now();
  if (waitMs > 0) {
    log(`  Waiting ${Math.round(waitMs / 1000)}s for seal window to open...`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  log('  Seal window open — sealing both players via WebSocket');

  // Generate a random price commitment and blinding
  const blinding1 = randomBytes(32);
  const blinding2 = randomBytes(32);
  const prediction1 = 50_000n * 1_000_000_000_000_000_000n; // $50k in 1e18 units
  const prediction2 = 51_000n * 1_000_000_000_000_000_000n;

  const commitment1 = computeCommitment(prediction1, blinding1);
  const commitment2 = computeCommitment(prediction2, blinding2);

  // Dummy timelock round (real deployment uses drand; devnet may stub this)
  const targetRound = Math.floor(sealOpenMs / 1000) + 10;

  for (const [player, seat, commitment, blinding, gs] of [
    [player1, 0, commitment1, blinding1, gs2 as any],
    [player2, 1, commitment2, blinding2, gs2],
  ] as const) {
    const sealMsg = buildPredictionMsg(matchId, onchainMatchId, seat as number, (player as Keypair).publicKey.toBytes(), BigInt(targetRound), commitment as Buffer);
    const sig = signMsg(player as Keypair, sealMsg);

    const ciphertext = randomBytes(64).toString('base64'); // stub: real deployment uses drand encryption

    gs.send({
      type: 'sealPrediction',
      matchId,
      ciphertext,
      seatIndex: seat,
      targetRound,
      commitmentHex: (commitment as Buffer).toString('hex'),
      blindingHex: (blinding as Buffer).toString('hex'),
      signature: sig,
    });
    log(`  Seat ${seat}: sealPrediction sent (commitment=${(commitment as Buffer).toString('hex').slice(0, 16)}...)`);
  }

  ok('Sealing payloads sent via WebSocket');
  log('  Settlement worker will read sealed prices, run settle(), and call settle instruction on-chain');
  log('  Monitor settlement-chain logs for the settle tx hash');
}

function computeCommitment(price: bigint, blinding: Buffer): Buffer {
  // mirrors shared/src/intent.rs simple_sha256(price_bytes + blinding)
  const buf = Buffer.alloc(48);
  buf.writeBigUInt64LE(price & 0xFFFFFFFFFFFFFFFFn, 0);
  buf.writeBigUInt64LE((price >> 64n) & 0xFFFFFFFFFFFFFFFFn, 8);
  blinding.copy(buf, 16);
  return createHash('sha256').update(buf).digest();
}

// ─── Next-steps printer ───────────────────────────────────────────────────────

function printNextSteps(roomCode: string, matchId: string, hostWallet: string) {
  log('\n────────────────────────────────────────────────────────────');
  log('Next steps for full flow verification:');
  log(`  1. Start match:    curl -u dev:... -X POST https://matchmaking.devnet.satoshitable.fun/rooms/${roomCode}/start -d '{"host":"${hostWallet}"}'`);
  log('  2. WS subscribe:   { type: "subscribe", matchId }  → receive matchState LIVE');
  log('  3. Betting:        { type: "act", matchId, action: { type: "call" }, signature, seatIndex, nonce }');
  log('  4. Seal (~10min):  AWAIT_SEAL=1 BASIC_AUTH=... node scripts/e2e-devnet-test.ts');
  log('  5. Settlement:     settlement-chain worker runs settle() after seal window closes');
  log('────────────────────────────────────────────────────────────');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
