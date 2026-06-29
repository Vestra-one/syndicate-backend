import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHermesTimestampUrl,
  extractHermesCandidates,
  redactSecrets,
  selectEarliestValidPythUpdate,
} from '../src/pyth.ts';

const feed = `0x${'07'.repeat(32)}`;

test('Hermes timestamp URL uses ids array and never includes API key', () => {
  const url = buildHermesTimestampUrl('https://pyth.dourolabs.app/hermes', 1715000000, feed);
  assert.match(url, /\/v2\/updates\/price\/1715000000/);
  assert.match(url, /encoding=hex/);
  assert.match(url, /parsed=true/);
  assert.doesNotMatch(url, /secret-api-key/);
});

test('exact timestamp candidate wins', () => {
  const response = (publishTime: number, conf = '10', expo = -8) => ({
    binary: { encoding: 'hex', data: ['01020304'] },
    parsed: [{ id: feed, price: { price: '100000', conf, expo, publish_time: publishTime } }],
  });
  const candidates = [
    ...extractHermesCandidates(response(1002), 1002),
    ...extractHermesCandidates(response(1000), 1000),
    ...extractHermesCandidates(response(999), 999),
  ];
  const selected = selectEarliestValidPythUpdate(candidates, {
    feedIdHex: feed,
    scheduledEndTs: 1000,
    maxConfidence: 50,
    expectedExponent: -8,
  });
  assert.equal(selected?.publishTime, 1000);
});

test('invalid feed exponent confidence and timestamp are rejected', () => {
  const good = extractHermesCandidates({
    binary: { encoding: 'hex', data: ['01020304'] },
    parsed: [
      { id: `0x${'08'.repeat(32)}`, price: { price: '1', conf: '10', expo: -8, publish_time: 1000 } },
      { id: feed, price: { price: '1', conf: '10', expo: -9, publish_time: 1000 } },
      { id: feed, price: { price: '1', conf: '51', expo: -8, publish_time: 1000 } },
      { id: feed, price: { price: '1', conf: '10', expo: -8, publish_time: 1006 } },
    ],
  }, 1000);
  const selected = selectEarliestValidPythUpdate(good, {
    feedIdHex: feed,
    scheduledEndTs: 1000,
    maxConfidence: 50,
    expectedExponent: -8,
  });
  assert.equal(selected, null);
});

test('redaction removes secrets and keypair byte arrays', () => {
  const raw = 'token=secret-token api=pyth-secret key=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64]';
  const redacted = redactSecrets(raw, ['secret-token', 'pyth-secret']);
  assert.doesNotMatch(redacted, /secret-token|pyth-secret/);
  assert.match(redacted, /\[REDACTED_KEYPAIR\]/);
});
