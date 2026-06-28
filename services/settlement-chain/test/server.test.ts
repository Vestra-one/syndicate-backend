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
    hermesUrl: 'https://pyth.dourolabs.app/hermes',
    pythApiKey: 'pyth-secret',
    receiverProgramId: 'rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp',
    wormholeProgramId: 'HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL',
    pushOracleProgramId: 'pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou',
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
