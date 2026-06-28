import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../src/main.ts';

function testConfig() {
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
    confirmationTimeoutMs: 60_000,
    computeUnitPriceMicroLamports: 100_000,
    allowTwoStepFallback: true,
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
