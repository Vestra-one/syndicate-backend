import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultBtcUsdcTier,
  validateConfig,
  isValid,
  bindConfig,
  ConfigRegistry,
  MIN_START_BB,
} from '../src/index.ts';

test('launch default tier is valid and ~100 BB', () => {
  const c = defaultBtcUsdcTier(100_000_000); // 100 USDC (micro)
  assert.deepEqual(validateConfig(c), []);
  assert.ok((c.buyIn * c.chipsPerUnit) / c.bigBlind >= MIN_START_BB);
});

test('shallow stack is rejected', () => {
  const c = defaultBtcUsdcTier(100_000_000);
  c.bigBlind = c.buyIn; // 1 BB stack
  assert.ok(!isValid(c));
  assert.ok(validateConfig(c).some((m) => m.includes('too shallow')));
});

test('round durations must match round count', () => {
  const c = defaultBtcUsdcTier(100_000_000);
  c.roundCount = 3;
  c.roundDurationsSec = [240, 180]; // only 2
  assert.ok(validateConfig(c).some((m) => m.includes('roundDurations length')));
});

test('settlement window cannot exceed match duration', () => {
  const c = defaultBtcUsdcTier(100_000_000);
  c.settlementWindowSec = 10_000;
  assert.ok(validateConfig(c).some((m) => m.includes('settlementWindow exceeds')));
});

test('bind hash is deterministic and order-independent, changes with content', () => {
  const c = defaultBtcUsdcTier(100_000_000);
  const h1 = bindConfig(c).hash;
  const h2 = bindConfig({ ...c }).hash; // different object, same content
  assert.equal(h1, h2);
  const h3 = bindConfig({ ...c, rakeBps: 301 }).hash;
  assert.notEqual(h1, h3);
});

test('binding an invalid config throws', () => {
  const c = defaultBtcUsdcTier(100_000_000);
  c.maxPlayers = 9;
  assert.throws(() => bindConfig(c));
});

test('registry publishes, gets, binds; rejects invalid + unknown', () => {
  const reg = new ConfigRegistry();
  reg.publish('btc-100', defaultBtcUsdcTier(100_000_000));
  assert.ok(reg.get('btc-100'));
  assert.ok(reg.bind('btc-100').hash.length === 64);
  assert.throws(() => reg.bind('nope'));
  const bad = defaultBtcUsdcTier(100_000_000);
  bad.minPlayers = 1;
  assert.throws(() => reg.publish('bad', bad));
});
