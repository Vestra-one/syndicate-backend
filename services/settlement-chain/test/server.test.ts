import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from '../src/main.ts';

function testConfig(overrides: Record<string, unknown> = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    authToken: 'internal-token',
    signerKeypairPath: '/tmp/nonexistent-settlement-keypair.json',
    signerPubkey: 'signer-pubkey',
    primaryRpcUrl: 'http://127.0.0.1:8899',
    programId: '11111111111111111111111111111111',
    chipsTokenMint: '',
    hermesUrl: 'https://hermes.pyth.network',
    pythApiKey: 'pyth-secret',
    receiverProgramId: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',
    wormholeProgramId: 'HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ',
    pushOracleProgramId: 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT',
    pythStack: 'legacy',
    signedPriceServerUrl: 'http://127.0.0.1:8080',
    confirmationTimeoutMs: 60_000,
    computeUnitPriceMicroLamports: 100_000,
    allowTwoStepFallback: true,
    ...overrides,
  };
}

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  const server = createServer(testConfig());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('health is public and does not leak secrets', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /signer-pubkey/);
    assert.doesNotMatch(body, /internal-token|pyth-secret/);
  });
});

test('internal endpoints reject missing and bad auth tokens', async () => {
  await withServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/internal/pyth/resolve`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 401);
    const bad = await fetch(`${baseUrl}/internal/pyth/resolve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: '{}',
    });
    assert.equal(bad.status, 401);
  });
});

test('metrics endpoint is scrapeable without auth', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /settlement_chain_errors_total/);
  });
});

test('signed price resolve fetches exact scheduled second', async () => {
  let observedUrl = '';
  const signedServer = createHttpServer((req, res) => {
    observedUrl = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      price: {
        token: '0xa7BaE7da3E4950700BE9f107EB186e89a474d180',
        symbol: 'BTCUSD',
        price_in_wad: '1000000000000000000000',
        timestamp: 1715000000123,
        v: 27,
        r: `0x${'11'.repeat(32)}`,
        s: `0x${'22'.repeat(32)}`,
        signed_at: 1715000000124,
      },
    }));
  });
  signedServer.listen(0, '127.0.0.1');
  await once(signedServer, 'listening');
  const signedAddress = signedServer.address();
  assert.equal(typeof signedAddress, 'object');
  const config = testConfig({ signedPriceServerUrl: `http://127.0.0.1:${signedAddress!.port}` });
  const server = createServer(config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');

  try {
    const res = await fetch(`http://127.0.0.1:${address!.port}/internal/pyth/resolve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer internal-token' },
      body: JSON.stringify({
        symbol: 'BTCUSD',
        feedIdHex: `0xa7bae7da3e4950700be9f107eb186e89a474d180${'00'.repeat(12)}`,
        scheduledEndTs: 1715000000,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.price.publish_time, 1715000000);
    assert.match(observedUrl, /symbol=BTCUSD/);
    assert.match(observedUrl, /timestamp=1715000000/);
  } finally {
    server.close();
    signedServer.close();
    await Promise.all([once(server, 'close'), once(signedServer, 'close')]);
  }
});
