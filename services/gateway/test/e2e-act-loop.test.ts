/**
 * E2E: gateway WS act → match-engine → Redis pub/sub → gateway fan-out.
 * Requires Redis (e.g. deploy/docker-compose.localnet.yml) and a built match-engine binary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { connect, createServer as createNetServer } from 'node:net';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { GatewayServer } from '../src/server.ts';
import { MatchSubscriber } from '../src/matchSubscriber.ts';
import { createRelayHandler } from '../src/relay.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const WALLETS = ['walletA', 'walletB', 'walletC'] as const;

async function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function redisPing(): Promise<boolean> {
  const url = new URL(REDIS_URL);
  return tcpReachable(url.hostname || '127.0.0.1', Number.parseInt(url.port || '6379', 10));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitForHttpOk(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

const execFileAsync = promisify(execFile);

async function engineBinPath(): Promise<string> {
  const { stdout } = await execFileAsync(
    'cargo',
    ['metadata', '--format-version', '1', '--no-deps'],
    { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 },
  );
  const meta = JSON.parse(stdout) as { target_directory: string };
  return path.join(meta.target_directory, 'debug/syndicate-match-engine');
}

async function buildMatchEngine(): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'cargo',
      ['build', '-p', 'syndicate-engine', '--bin', 'syndicate-match-engine'],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`cargo build exit ${code}`))));
  });
  const bin = await engineBinPath();
  await access(bin, fsConstants.R_OK);
  return bin;
}

function startMatchEngine(port: number, engineBin: string, extraEnv: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...extraEnv };
  delete env.DATABASE_URL;
  return spawn(engineBin, [], {
    cwd: REPO_ROOT,
    env: {
      ...env,
      MATCH_ENGINE_HOST: '127.0.0.1',
      MATCH_ENGINE_PORT: String(port),
      REDIS_URL,
      SYNDICATE_ALLOW_DEV_SIGNATURES: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function startMatch(engineUrl: string, matchId: string): Promise<{ toActSeat: number }> {
  const res = await fetch(`${engineUrl}/internal/matches/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      matchId,
      onchainMatchId: 42,
      button: 0,
      smallBlind: 1,
      bigBlind: 2,
      roundCount: 3,
      actionTimeoutMs: 25_000,
      players: [
        { seatIndex: 0, stack: 100, sealSeq: 0, wallet: WALLETS[0] },
        { seatIndex: 1, stack: 100, sealSeq: 1, wallet: WALLETS[1] },
        { seatIndex: 2, stack: 100, sealSeq: 2, wallet: WALLETS[2] },
      ],
    }),
  });
  assert.equal(res.status, 200, await res.text());

  const stateRes = await fetch(`${engineUrl}/internal/matches/${encodeURIComponent(matchId)}/state`);
  assert.equal(stateRes.status, 200);
  const state = await stateRes.json() as { phase?: string; toActSeat?: number | null; to_act_seat?: number | null };
  assert.match(String(state.phase ?? ''), /LIVE/i);
  const toActSeat = state.toActSeat ?? state.to_act_seat;
  assert.ok(toActSeat !== null && toActSeat !== undefined, 'engine should designate a seat to act');
  return { toActSeat: Number(toActSeat) };
}

async function runActLoopE2E(engineUrl: string, matchId: string, toActSeat: number): Promise<unknown[]> {
  const relayed: unknown[] = [];
  const actingWallet = WALLETS[toActSeat] ?? WALLETS[0];
  const mockVerifier = { verify: () => true };

  let gateway!: GatewayServer;
  const subscriber = new MatchSubscriber(REDIS_URL);
  const relay = createRelayHandler(
    {
      matchEngineUrl: engineUrl,
      matchmakingUrl: 'http://127.0.0.1:1',
      actionFeedUrl: 'http://127.0.0.1:1',
      configUrl: 'http://127.0.0.1:1',
      subscriber,
    },
    (wallet, msg) => {
      relayed.push(msg);
      gateway.sendToWallet(wallet, msg);
    },
  );

  gateway = new GatewayServer({ verifier: mockVerifier, onMessage: relay });
  await gateway.ready;

  try {
    await new Promise<void>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
      const timer = setTimeout(() => reject(new Error('websocket timeout waiting for post-act fan-out')), 25_000);
      let sawSubscribeState = false;
      let sawPostActEvent = false;

    client.on('message', (raw) => {
      void (async () => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        if (msg.type === 'challenge') {
          client.send(JSON.stringify({ type: 'auth', wallet: actingWallet, signature: 'ok' }));
          return;
        }
        if (msg.type === 'authenticated') {
          client.send(JSON.stringify({ type: 'subscribe', matchId }));
          return;
        }
        if (msg.type === 'matchState') {
          if (!sawSubscribeState) {
            sawSubscribeState = true;
            client.send(JSON.stringify({
              type: 'act',
              matchId,
              seatIndex: toActSeat,
              nonce: 1,
              signature: 'sig-e2e-1',
              action: { type: 'call' },
            }));
            return;
          }
          sawPostActEvent = true;
        }
        if (msg.type === 'yourTurn') {
          sawPostActEvent = true;
        }
        if (sawPostActEvent) {
          clearTimeout(timer);
          await new Promise((r) => setTimeout(r, 100));
          client.close();
          resolve();
        }
      })().catch(reject);
    });
      client.on('error', reject);
    });
  } finally {
    subscriber.close();
    await gateway.close();
  }

  return relayed;
}

test('E2E demo: act → engine → Redis → gateway fan-out', async (t) => {
  if (!(await redisPing())) {
    t.skip(`Redis not reachable at ${REDIS_URL} — start deploy/docker-compose.localnet.yml`);
    return;
  }

  const engineBin = await buildMatchEngine();
  const enginePort = await freePort();
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  const engineProc = startMatchEngine(enginePort, engineBin);
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 200));
    engineProc.kill('SIGTERM');
  });

  engineProc.stderr.on('data', (chunk) => {
    const line = String(chunk);
    if (/fatal|error/i.test(line)) console.error('[match-engine]', line);
  });

  await waitForHttpOk(`${engineUrl}/healthz`);

  const matchId = `e2e-demo-${Date.now()}`;
  const { toActSeat } = await startMatch(engineUrl, matchId);
  const relayed = await runActLoopE2E(engineUrl, matchId, toActSeat);

  const dupRes = await fetch(`${engineUrl}/internal/matches/${encodeURIComponent(matchId)}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      wallet: WALLETS[toActSeat],
      action: { type: 'call' },
      signature: 'sig-e2e-dup',
      seatIndex: toActSeat,
      nonce: 1,
    }),
  });
  assert.equal(dupRes.status, 409, 'replay of same nonce should be rejected');

  const matchStates = relayed.filter(
    (m) => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'matchState',
  );
  const yourTurns = relayed.filter(
    (m) => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'yourTurn',
  );
  assert.ok(matchStates.length >= 2, `expected subscribe + post-act matchState, got ${JSON.stringify(relayed)}`);
  assert.ok(yourTurns.length >= 1 || matchStates.length >= 2, 'expected yourTurn or updated matchState from Redis');
});

test('E2E postgres: act → engine → Redis → gateway (when DATABASE_URL reachable)', async (t) => {
  if (!(await redisPing())) {
    t.skip(`Redis not reachable at ${REDIS_URL}`);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL
    ?? 'postgres://syndicate:syndicate@127.0.0.1:5432/syndicate_local';
  const pgUrl = new URL(databaseUrl.replace(/^postgres:/, 'http:'));
  if (!(await tcpReachable(pgUrl.hostname, Number.parseInt(pgUrl.port || '5432', 10)))) {
    t.skip(`Postgres not reachable at ${databaseUrl}`);
    return;
  }

  const engineBin = await buildMatchEngine();
  const enginePort = await freePort();
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  const engineProc = startMatchEngine(enginePort, engineBin, {
    DATABASE_URL: databaseUrl,
    MATCH_ENGINE_POSTGRES_LEASES: 'false',
    MATCH_ENGINE_NODE_ID: 'e2e-engine',
  });
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 200));
    engineProc.kill('SIGTERM');
  });

  await waitForHttpOk(`${engineUrl}/healthz`);

  const matchId = `e2e-pg-${Date.now()}`;
  const { toActSeat } = await startMatch(engineUrl, matchId);
  const relayed = await runActLoopE2E(engineUrl, matchId, toActSeat);

  const matchStates = relayed.filter(
    (m) => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'matchState',
  );
  assert.ok(matchStates.length >= 2, `postgres path: expected Redis fan-out, got ${JSON.stringify(relayed)}`);
});
