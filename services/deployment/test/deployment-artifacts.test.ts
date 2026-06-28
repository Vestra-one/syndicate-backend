import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);

async function text(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

test('phase 8 localnet compose includes required durable infrastructure', async () => {
  const compose = await text('deploy/docker-compose.localnet.yml');
  for (const service of ['postgres:', 'redis:', 'nats:', 'minio:', 'prometheus:', 'grafana:']) {
    assert.match(compose, new RegExp(`\\n  ${service}`));
  }
  assert.match(compose, /nats:2\.10/);
  assert.match(compose, /postgres:16/);
  assert.match(compose, /--storage.tsdb.retention.time=15d/);
});

test('production app compose includes deployable application services', async () => {
  const compose = await text('deploy/docker-compose.app.yml');
  const dockerfile = await text('deploy/Dockerfile.node-service');
  for (const service of ['gateway:', 'matchmaking:', 'action-feed:', 'match-engine:', 'settlement-chain:', 'settlement-worker:']) {
    assert.match(compose, new RegExp(`\\n  ${service}`));
  }
  assert.match(compose, /Dockerfile\.node-service/);
  assert.match(compose, /Dockerfile\.rust-service/);
  assert.match(compose, /Dockerfile\.rust-worker/);
  assert.match(dockerfile, /npm ci --omit=dev --prefix "services\/\$\{SERVICE\}"/);
  assert.doesNotMatch(dockerfile, /RUN npm install\s+\\\s+ws@/);
});

test('phase 8 env template includes settlement and observability controls', async () => {
  const env = await text('docs/deployment/env.example');
  for (const key of [
    'DATABASE_URL',
    'NATS_URL',
    'SOLANA_RPC_URL_PRIMARY',
    'PYTH_API_KEY',
    'SYNDICATE_PROGRAM_ID',
    'SETTLEMENT_WORKER_MODE=production',
    'SETTLEMENT_CHAIN_URL',
    'SETTLEMENT_CHAIN_AUTH_TOKEN_FILE',
    'SETTLEMENT_SIGNER_KEYPAIR_PATH',
    'DEFAULT_ORACLE_DELAY_WINDOW_SEC=5',
    'DEFAULT_GEOFENCE_BLOCKLIST=IN',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
  ]) {
    assert.match(env, new RegExp(`(^|\\n)${key}`));
  }
});

test('phase 8 alerts page custody and oracle failures', async () => {
  const alerts = await text('deploy/prometheus/alerts.yml');
  for (const alert of ['VaultReconciliationDrift', 'SettlementVerificationMismatch', 'OracleExactAfterAvailabilityLow']) {
    assert.match(alerts, new RegExp(`alert: ${alert}`));
  }
  assert.match(alerts, /severity: page/);
  assert.match(alerts, /docs\/RUNBOOKS\.md/);
});

test('phase 8 deployment docs cover secrets, audits, and bug bounty', async () => {
  const secrets = await text('docs/deployment/SECRETS_AND_KEYS.md');
  const audit = await text('docs/deployment/AUDIT_AND_BUG_BOUNTY.md');
  assert.match(secrets, /No single personal wallet should control a mainnet authority role/);
  assert.match(secrets, /\/etc\/syndicate/);
  assert.match(audit, /Mainnet real-money launch is blocked/);
  assert.match(audit, /Bug Bounty/);
});

test('all-tests script only discovers first-party node tests after dependency install', async () => {
  const script = await text('scripts/test-all.sh');
  assert.match(script, /-path '\*\/node_modules' -prune/);
  assert.match(script, /\*\.test\.ts/);
  assert.match(script, /\*\.test\.mjs/);
  assert.match(script, /node --experimental-strip-types --test "\$\{node_tests\[@\]\}"/);
});

test('Pyth receiver services patch upstream ESM packaging during install', async () => {
  const patch = await text('scripts/patch-pyth-solana-utils-esm.mjs');
  const settlementChain = await text('services/settlement-chain/package.json');
  const devnetHarness = await text('services/devnet-harness/package.json');
  assert.match(patch, /jito-ts\/dist\/sdk\/block-engine\/types\.js/);
  assert.match(patch, /@coral-xyz\/anchor\/dist\/cjs\/utils\/bytes\/index\.js/);
  assert.match(settlementChain, /patch-pyth-solana-utils-esm\.mjs/);
  assert.match(devnetHarness, /patch-pyth-solana-utils-esm\.mjs/);
});

test('devnet and mainnet preflights require runtime settlement secrets and Pyth ids', async () => {
  const devnet = await text('scripts/deploy-devnet.sh');
  const mainnet = await text('scripts/deploy-mainnet.sh');
  for (const key of [
    'PYTH_HERMES_URL',
    'PYTH_RECEIVER_PROGRAM_ID',
    'PYTH_WORMHOLE_PROGRAM_ID',
    'PYTH_PUSH_ORACLE_PROGRAM_ID',
    'SETTLEMENT_CHAIN_AUTH_TOKEN_FILE',
    'SETTLEMENT_SIGNER_KEYPAIR_PATH',
  ]) {
    assert.match(devnet, new RegExp(`\\b${key}\\b`));
    assert.match(mainnet, new RegExp(`\\b${key}\\b`));
  }
  for (const key of ['DRAND_API', 'DRAND_CHAIN_HASH', 'DRAND_EXPECTED_SCHEME_ID']) {
    assert.match(mainnet, new RegExp(`\\b${key}\\b`));
  }
});
