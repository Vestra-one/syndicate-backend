import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { RedisClient } from '../../gateway/src/redis.ts';
import { EnforcementRegistry } from '../../trust-safety/src/index.ts';
import { MemoryMatchmakingStore } from './index.ts';
import { RedisMatchmakingStore } from './redis-store.ts';
import { MatchmakingRuntime } from './formation.ts';
import { createOrchestratorClient } from './orchestrator-client.ts';
import { DeadlineWorker } from './deadline-worker.ts';
import { createChainVerifier } from './chain-verify.ts';
import { createHttpPersistence, NOOP_PERSISTENCE } from './persistence.ts';

export async function startMatchmakingFromEnv(): Promise<{ close(): Promise<void>; port: number }> {
  const port = parsePort(process.env.MATCHMAKING_PORT ?? process.env.PORT ?? '8082');
  const host = process.env.MATCHMAKING_HOST ?? '127.0.0.1';
  const redis = process.env.REDIS_URL ? new RedisClient(process.env.REDIS_URL) : undefined;
  const store = redis ? new RedisMatchmakingStore(redis) : new MemoryMatchmakingStore();
  const orchestrator = createOrchestratorClient(
    process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:8086',
    process.env.ORCHESTRATOR_AUTH_TOKEN,
    { stub: process.env.SYNDICATE_ORCHESTRATOR_STUB === '1' },
  );
  const enforcement = new EnforcementRegistry();
  // Authoritative on-chain verification lives in settlement-chain (Phase 02); matchmaking
  // delegates over HTTP so it stays zero-dependency and the predicate never forks.
  const verifyBaseUrl = process.env.SETTLEMENT_CHAIN_URL ?? 'http://127.0.0.1:8085';
  const chainVerifier = createChainVerifier(verifyBaseUrl, readAuthToken('SETTLEMENT_CHAIN_AUTH_TOKEN', 'SETTLEMENT_CHAIN_AUTH_TOKEN_FILE'));
  // Postgres match-row writer (Phase 05) via settlement-worker.
  const persistence = process.env.MATCH_PERSISTENCE_URL
    ? createHttpPersistence(
        process.env.MATCH_PERSISTENCE_URL,
        readAuthToken('MATCH_PERSISTENCE_AUTH_TOKEN', 'MATCH_PERSISTENCE_AUTH_TOKEN_FILE')
          || readAuthToken('SETTLEMENT_CHAIN_AUTH_TOKEN', 'SETTLEMENT_CHAIN_AUTH_TOKEN_FILE'),
      )
    : NOOP_PERSISTENCE;
  const runtime = new MatchmakingRuntime({
    store,
    redis,
    orchestrator,
    chainVerifier,
    persistence,
    walletRoomCap: process.env.WALLET_ROOM_CAP ? Number(process.env.WALLET_ROOM_CAP) : undefined,
    admissionGuard: {
      canJoinTable: (wallet, now) => enforcement.canJoinTable(wallet, now),
    },
  });
  const deadlineWorker = redis ? new DeadlineWorker(redis, store, orchestrator, runtime) : undefined;
  deadlineWorker?.start();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end('syndicate_matchmaking_up 1\n');
        return;
      }

      // Lobby feed served from the registry (UX-only). Filter by feed/template/buyIn.
      if (req.method === 'GET' && url.pathname === '/rooms') {
        const rooms = await runtime.listRooms({
          feed: url.searchParams.get('feed') ?? undefined,
          template: url.searchParams.get('template') ?? undefined,
          buyIn: url.searchParams.has('buyIn') ? Number(url.searchParams.get('buyIn')) : undefined,
        });
        return json(res, 200, { rooms });
      }

      // Host create report: the host already ran create_and_deposit on-chain and reports the
      // txhash. Matchmaking verifies it (settlement-chain) — it never creates matches itself.
      if (req.method === 'POST' && url.pathname === '/rooms') {
        const body = await readJson(req);
        const out = await runtime.createRoom({
          createTxSig: String(body.createTxSig ?? body.txSignature ?? body.txSig),
          matchPda: String(body.matchPda),
          onchainMatchId: String(body.onchainMatchId),
          configHash: String(body.configHash),
          wallet: String(body.wallet ?? body.host),
          seatIndex: body.seatIndex === undefined ? undefined : Number(body.seatIndex),
          maxPlayers: body.maxPlayers === undefined ? undefined : Number(body.maxPlayers),
        });
        return json(res, out.ok ? 201 : 409, out);
      }

      const roomGet = url.pathname.match(/^\/rooms\/([^/]+)$/);
      if (req.method === 'GET' && roomGet) {
        const lobby = await runtime.roomLobby(decodeURIComponent(roomGet[1]), url.searchParams.get('wallet') ?? undefined);
        return json(res, 200, { lobby });
      }

      const roomStart = url.pathname.match(/^\/rooms\/([^/]+)\/start$/);
      if (req.method === 'POST' && roomStart) {
        const body = await readJson(req);
        const result = await runtime.hostStart(decodeURIComponent(roomStart[1]), String(body.host));
        return json(res, result.ok ? 200 : 409, result);
      }

      const roomJoin = url.pathname.match(/^\/rooms\/([^/]+)\/join$/);
      if (req.method === 'POST' && roomJoin) {
        const rec = await runtime.loadRoom(decodeURIComponent(roomJoin[1]));
        if (!rec) return json(res, 404, { error: 'room not found' });
        return json(res, 200, { matchId: rec.matchId });
      }

      if (req.method === 'POST' && url.pathname === '/queue/join') {
        const body = await readJson(req);
        try {
          const out = await runtime.joinQueue({
            tierId: String(body.tierId ?? 'tier-standard'),
            feedId: String(body.feedId ?? 'BTC/USD'),
            token: String(body.token ?? 'USDC'),
            wallet: String(body.wallet),
            rating: body.rating === undefined ? undefined : Number(body.rating),
            buyIn: body.buyIn === undefined ? undefined : Number(body.buyIn),
            fillWindowSec: body.fillWindowSec === undefined ? undefined : Number(body.fillWindowSec),
          });
          return json(res, 200, out);
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
      }

      if (req.method === 'GET' && url.pathname === '/queue/status') {
        const status = await runtime.queueStatus(
          url.searchParams.get('tier') ?? 'tier-standard',
          url.searchParams.get('feed') ?? 'BTC/USD',
          url.searchParams.get('token') ?? 'USDC',
          Number(url.searchParams.get('rating') ?? '1000'),
          url.searchParams.has('buyIn') ? Number(url.searchParams.get('buyIn')) : undefined,
          url.searchParams.has('fillWindowSec') ? Number(url.searchParams.get('fillWindowSec')) : undefined,
        );
        return json(res, 200, { status });
      }

      const depositMatch = url.pathname.match(/^\/matches\/([^/]+)\/deposits$/);
      if (req.method === 'POST' && depositMatch) {
        const body = await readJson(req);
        const result = await runtime.verifyDeposit({
          matchId: decodeURIComponent(depositMatch[1]),
          wallet: String(body.wallet),
          txSignature: String(body.depositTxSig ?? body.txSignature ?? body.txSig),
          seatIndex: body.seatIndex === undefined ? undefined : Number(body.seatIndex),
          tierId: body.tierId === undefined ? undefined : String(body.tierId),
          feedId: body.feedId === undefined ? undefined : String(body.feedId),
        });
        return json(res, result.ok ? 200 : 409, result);
      }

      const termsMatch = url.pathname.match(/^\/matches\/([^/]+)\/terms$/);
      if (req.method === 'GET' && termsMatch) {
        const terms = await runtime.matchTerms(decodeURIComponent(termsMatch[1]));
        if (!terms) return json(res, 404, { error: 'terms not found' });
        return json(res, 200, { terms });
      }

      res.writeHead(404);
      res.end();
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  console.log(`matchmaking listening on http://${host}:${port}`);
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      deadlineWorker?.stop();
      server.close(() => resolve());
    }),
  };
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parsePort(raw: string): number {
  return parsePositiveInt(raw, 'port');
}

function readAuthToken(envName: string, fileEnvName: string): string | undefined {
  const direct = process.env[envName];
  if (direct) return direct;
  const file = process.env[fileEnvName];
  if (!file) return undefined;
  return readFileSync(file, 'utf8').trim();
}

function parsePositiveInt(raw: string, label = 'positive integer'): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65_535) throw new Error(`invalid ${label}: ${raw}`);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startMatchmakingFromEnv();
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
