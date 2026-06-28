import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PYTH_HERMES_URL,
  buildHermesTimestampUrl,
  extractHermesCandidates,
  fetchEarliestValidPythUpdate,
  normalizeFeedIdHex,
  pythAuditReceipt,
  redactedHermesConfig,
  selectEarliestValidPythUpdate,
} from '../src/pyth.mjs';

const FEED = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
const OTHER_FEED = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const RULES = {
  feedIdHex: FEED,
  scheduledEndTs: 1_000,
  oracleDelayWindowSec: 5,
  maxConfidence: 50n,
  expectedExponent: -8,
};

test('Hermes timestamp URL construction uses v2 timestamp endpoint', () => {
  const url = buildHermesTimestampUrl(DEFAULT_PYTH_HERMES_URL, 1_715_000_000, FEED);
  assert.equal(
    url,
    'https://hermes.pyth.network/v2/updates/price/1715000000?ids%5B%5D=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace&encoding=hex&parsed=true',
  );
});

test('API key redaction never exposes the secret', () => {
  const redacted = redactedHermesConfig({
    hermesUrl: DEFAULT_PYTH_HERMES_URL,
    apiKey: 'super-secret-pyth-key',
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(redacted.apiKeyConfigured, true);
  assert.equal(serialized.includes('super-secret-pyth-key'), false);
});

test('earliest valid update selection ignores later valid candidates', () => {
  const selected = selectEarliestValidPythUpdate([
    candidate({ publishTime: 1_004, price: 104n }),
    candidate({ publishTime: 1_001, price: 101n }),
    candidate({ publishTime: 1_002, price: 102n }),
  ], RULES);
  assert.equal(selected.price, 101n);
  assert.equal(selected.publishTime, 1_001);
});

test('invalid Pyth candidates are rejected by feed, exponent, confidence, and window', () => {
  assert.equal(selectEarliestValidPythUpdate([candidate({ feedIdHex: OTHER_FEED })], RULES), null);
  assert.equal(selectEarliestValidPythUpdate([candidate({ exponent: -9 })], RULES), null);
  assert.equal(selectEarliestValidPythUpdate([candidate({ confidence: 51n })], RULES), null);
  assert.equal(selectEarliestValidPythUpdate([candidate({ publishTime: 999 })], RULES), null);
  assert.equal(selectEarliestValidPythUpdate([candidate({ publishTime: 1_006 })], RULES), null);
});

test('Hermes extraction converts hex binary updates to base64 receiver input', () => {
  const [candidateFromHermes] = extractHermesCandidates({
    binary: { encoding: 'hex', data: ['01020304'] },
    parsed: [{
      id: FEED,
      price: { price: '100000', conf: '12', expo: -8, publish_time: 1_000 },
    }],
  }, 1_000);
  assert.equal(candidateFromHermes.price, 100_000n);
  assert.equal(candidateFromHermes.confidence, 12n);
  assert.equal(candidateFromHermes.priceUpdateData[0], 'AQIDBA==');
  assert.match(candidateFromHermes.hermesResponseHash, /^[0-9a-f]{64}$/);
  assert.match(candidateFromHermes.binaryUpdateHash, /^[0-9a-f]{64}$/);
});

test('fetcher scans the exact-after window and selects first valid publish_time', async () => {
  const requests = [];
  const client = {
    async getPriceUpdatesAtTimestamp(ts, ids, options) {
      requests.push({ ts, ids, options });
      return {
        binary: { encoding: 'hex', data: ['0102'] },
        parsed: [{
          id: FEED,
          price: {
            price: String(100_000 + ts),
            conf: '10',
            expo: -8,
            publish_time: ts === 1_000 ? 999 : ts,
          },
        }],
      };
    },
  };
  const selected = await fetchEarliestValidPythUpdate({ client, ...RULES });
  assert.equal(selected.publishTime, 1_001);
  assert.equal(selected.price, 101_001n);
  assert.equal(requests.length, 6);
  assert.deepEqual(requests[0], {
    ts: 1_000,
    ids: [normalizeFeedIdHex(FEED)],
    options: { encoding: 'hex', parsed: true },
  });
});

test('audit receipt records two-step settlement mode and all signatures', () => {
  const receipt = pythAuditReceipt({
    matchId: 42n,
    idempotencyKey: 'match:42',
    selected: candidate({ publishTime: 1_001, price: 101n }),
    priceUpdateAccount: 'price-update-account',
    settlementTxSignature: 'settle-sig',
    settlementTxSignatures: ['post-sig', 'settle-sig'],
    settlementMode: 'two_step',
    receiverProgramId: 'receiver',
    wormholeProgramId: 'wormhole',
    pushOracleProgramId: 'push',
  });
  assert.equal(receipt.settlementMode, 'two_step');
  assert.equal(receipt.atomicSettlementTxSignature, 'settle-sig');
  assert.deepEqual(receipt.settlementTxSignatures, ['post-sig', 'settle-sig']);
});

function candidate(overrides = {}) {
  return {
    feedIdHex: normalizeFeedIdHex(overrides.feedIdHex ?? FEED),
    price: overrides.price ?? 100_000n,
    confidence: overrides.confidence ?? 10n,
    exponent: overrides.exponent ?? -8,
    publishTime: overrides.publishTime ?? 1_000,
    requestedTimestamp: overrides.requestedTimestamp ?? 1_000,
    binaryDataHex: overrides.binaryDataHex ?? ['0102'],
    priceUpdateData: overrides.priceUpdateData ?? ['AQI='],
    hermesResponseHash: '00'.repeat(32),
    binaryUpdateHash: '11'.repeat(32),
    hermesUrl: DEFAULT_PYTH_HERMES_URL,
  };
}
