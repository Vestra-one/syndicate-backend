import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { RedisClient } from '../../gateway/src/redis.ts';
import { EnforcementRegistry } from '../../trust-safety/src/index.ts';
import { MemoryMatchmakingStore } from './index.ts';
import { RedisMatchmakingStore } from './redis-store.ts';
import { MatchmakingRuntime } from './formation.ts';
import { createOrchestratorClient } from './orchestrator-client.ts';
import { DeadlineWorker } from './deadline-worker.ts';

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
  const runtime = new MatchmakingRuntime({
    store,
    redis,
    orchestrator,
    rpcUrl: process.env.SOLANA_RPC_URL,
    programId: process.env.PROGRAM_ID,
    admissionGuard: {
      canJoinTable: (wallet, now) => enforcement.canJoinTable(wallet, now),
    },
  });
  const deadlineWorker = redis ? new DeadlineWorker(redis, store, orchestrator) : undefined;
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

      if (req.method === 'POST' && url.pathname === '/rooms') {
        const body = await readJson(req);
        const out = await runtime.createRoom({
          host: String(body.host),
          tierId: String(body.tierId ?? 'tier-low'),
          feedId: String(body.feedId ?? 'BTC/USD'),
          token: String(body.token ?? 'USDC'),
          maxPlayers: Number(body.maxPlayers ?? 5),
        });
        return json(res, 201, out);
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
        const out = await runtime.joinQueue({
          tierId: String(body.tierId ?? 'tier-low'),
          feedId: String(body.feedId ?? 'BTC/USD'),
          token: String(body.token ?? 'USDC'),
          wallet: String(body.wallet),
          rating: body.rating === undefined ? undefined : Number(body.rating),
        });
        return json(res, 200, out);
      }

      if (req.method === 'GET' && url.pathname === '/queue/status') {
        const status = await runtime.queueStatus(
          url.searchParams.get('tier') ?? 'tier-low',
          url.searchParams.get('feed') ?? 'BTC/USD',
          url.searchParams.get('token') ?? 'USDC',
          Number(url.searchParams.get('rating') ?? '1000'),
        );
        return json(res, 200, { status });
      }

      const depositMatch = url.pathname.match(/^\/matches\/([^/]+)\/deposits$/);
      if (req.method === 'POST' && depositMatch) {
        const body = await readJson(req);
        const result = await runtime.verifyDeposit({
          matchId: decodeURIComponent(depositMatch[1]),
          wallet: String(body.wallet),
          txSignature: String(body.txSignature),
          seatIndex: body.seatIndex === undefined ? undefined : Number(body.seatIndex),
          tierId: body.tierId === undefined ? undefined : String(body.tierId),
          feedId: body.feedId === undefined ? undefined : String(body.feedId),
        });
        return json(res, result.ok ? 200 : 409, result);
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
