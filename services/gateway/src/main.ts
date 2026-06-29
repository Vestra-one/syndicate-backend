import { pathToFileURL } from 'node:url';
import { GatewayServer } from './server.ts';
import { Ed25519Verifier } from './verifier.ts';
import { RedisClient } from './redis.ts';
import { MatchSubscriber } from './matchSubscriber.ts';
import { createRelayHandler } from './relay.ts';
import {
  MemoryRateLimiter,
  RedisChallengeStore,
  RedisRateLimiter,
  RedisSessionStore,
  type RateLimiter,
} from './state.ts';

export async function startGatewayFromEnv(): Promise<GatewayServer> {
  const port = parsePort(process.env.GATEWAY_PORT ?? process.env.PORT ?? '8081');
  const host = process.env.GATEWAY_HOST ?? '127.0.0.1';
  const blocklist = (process.env.DEFAULT_GEOFENCE_BLOCKLIST ?? 'IN')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const redis = process.env.REDIS_URL ? new RedisClient(process.env.REDIS_URL) : undefined;
  const windowSec = parsePositiveInt(process.env.GATEWAY_RATE_LIMIT_WINDOW_SEC ?? '60');
  const maxRequests = parsePositiveInt(process.env.GATEWAY_RATE_LIMIT_MAX ?? '120');
  const rateLimiter: RateLimiter = redis
    ? new RedisRateLimiter(redis, maxRequests, windowSec)
    : new MemoryRateLimiter(maxRequests, windowSec * 1000);

  const relayDeps = {
    matchEngineUrl: process.env.MATCH_ENGINE_URL ?? 'http://127.0.0.1:8083',
    matchmakingUrl: process.env.MATCHMAKING_URL ?? 'http://127.0.0.1:8082',
    actionFeedUrl: process.env.ACTION_FEED_URL ?? 'http://127.0.0.1:8080',
    configUrl: process.env.CONFIG_URL ?? 'http://127.0.0.1:8084',
    authToken: process.env.ORCHESTRATOR_AUTH_TOKEN,
    subscriber: process.env.REDIS_URL ? new MatchSubscriber(process.env.REDIS_URL) : undefined,
    now: () => Date.now(),
  };

  let server!: GatewayServer;
  const relay = createRelayHandler(relayDeps, (wallet, msg) => server.sendToWallet(wallet, msg));

  server = new GatewayServer({
    port,
    host,
    verifier: new Ed25519Verifier(),
    blocklist,
    countryOf: (req) => countryFromHeaders(req.headers),
    challengeStore: redis ? new RedisChallengeStore(redis) : undefined,
    sessionStore: redis ? new RedisSessionStore(redis) : undefined,
    rateLimiter,
    metricsPort: process.env.GATEWAY_METRICS_PORT ? parsePort(process.env.GATEWAY_METRICS_PORT) : undefined,
    metricsHost: process.env.GATEWAY_METRICS_HOST ?? host,
    onMessage: (wallet, msg) => relay(wallet, msg as Record<string, unknown>),
  });
  await server.ready;
  if (server.metricsReady) await server.metricsReady;
  console.log(`gateway listening on ws://${host}:${server.port}`);
  return server;
}

function countryFromHeaders(headers: NodeJS.Dict<string | string[]>): string {
  const raw = headers['cf-ipcountry'] ?? headers['x-vercel-ip-country'] ?? headers['x-syndicate-country'] ?? 'ZZ';
  return Array.isArray(raw) ? raw[0] : raw;
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
  const server = await startGatewayFromEnv();
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
