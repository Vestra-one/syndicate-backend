import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { GatewayServer } from '../src/server.ts';
import type { SignatureVerifier } from '../src/index.ts';

// Mock verifier for the handshake flow: signature "valid" iff it equals `sig:<message>`.
const mock: SignatureVerifier = { verify: (_w, message, signature) => signature === `sig:${message}` };

test('ws server: challenge → auth → authenticated → broadcast', async () => {
  const relayed: [string, unknown][] = [];
  const server = new GatewayServer({ verifier: mock, onMessage: (w, m) => relayed.push([w, m]) });
  await server.ready;

  await new Promise<void>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    client.on('message', (raw: unknown) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'challenge') {
        client.send(JSON.stringify({ type: 'auth', wallet: 'walletA', signature: `sig:${msg.nonce}` }));
      } else if (msg.type === 'authenticated') {
        assert.equal(msg.wallet, 'walletA');
        server.broadcast({ type: 'tick', price: 100 });
      } else if (msg.type === 'tick') {
        assert.equal(msg.price, 100);
        clearTimeout(timer);
        client.close();
        resolve();
      }
    });
    client.on('error', reject);
  });

  await server.close();
});

test('ws server: bad signature is rejected and the socket closed', async () => {
  const server = new GatewayServer({ verifier: mock });
  await server.ready;

  await new Promise<void>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    let gotError = false;
    client.on('message', (raw: unknown) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'challenge') {
        client.send(JSON.stringify({ type: 'auth', wallet: 'walletA', signature: 'wrong' }));
      } else if (msg.type === 'error') {
        assert.equal(msg.reason, 'bad signature');
        gotError = true;
      }
    });
    client.on('close', () => {
      clearTimeout(timer);
      assert.ok(gotError, 'should have received an error before close');
      resolve();
    });
    client.on('error', () => {});
  });

  await server.close();
});

test('ws server: challenge nonce is one-time use', async () => {
  const server = new GatewayServer({ verifier: mock });
  await server.ready;
  let nonce = '';

  await new Promise<void>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    client.on('message', (raw: unknown) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'challenge') {
        nonce = msg.nonce;
        client.send(JSON.stringify({ type: 'auth', wallet: 'walletA', signature: `sig:${msg.nonce}` }));
      } else if (msg.type === 'authenticated') {
        clearTimeout(timer);
        client.close();
        resolve();
      }
    });
    client.on('error', reject);
  });

  await new Promise<void>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    let rejected = false;
    client.on('message', (raw: unknown) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'challenge') {
        client.send(JSON.stringify({ type: 'auth', wallet: 'walletA', signature: `sig:${nonce}` }));
      } else if (msg.type === 'error') {
        rejected = true;
      }
    });
    client.on('close', () => {
      clearTimeout(timer);
      assert.ok(rejected, 'replayed nonce must be rejected');
      resolve();
    });
    client.on('error', () => {});
  });

  await server.close();
});

test('ws server: geofenced connection is blocked', async () => {
  const server = new GatewayServer({ verifier: mock, blocklist: ['XX'], countryOf: () => 'XX' });
  await server.ready;

  await new Promise<void>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    let blocked = false;
    client.on('message', (raw: unknown) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'error' && msg.reason === 'geo-blocked') blocked = true;
    });
    client.on('close', () => {
      clearTimeout(timer);
      assert.ok(blocked, 'geo-blocked error expected');
      resolve();
    });
    client.on('error', () => {});
  });

  await server.close();
});

test('gateway exposes health and prometheus metrics', async () => {
  const server = new GatewayServer({ verifier: mock });
  await server.ready;
  const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
  assert.equal(health.status, 200);
  const metrics = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text();
  assert.match(metrics, /syndicate_gateway_connections_total/);
  await server.close();
});
