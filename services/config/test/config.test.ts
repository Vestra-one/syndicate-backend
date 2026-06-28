import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultBtcUsdcTier,
  defaultEthUsdcTier,
  defaultSolUsdcTier,
  validateConfig,
  isValid,
  bindConfig,
  ConfigRegistry,
  MIN_START_BB,
  DEFAULT_GEOFENCE_BLOCKLIST,
  DEFAULT_ORACLE_DELAY_WINDOW_SEC,
  DEFAULT_ORACLE_UNAVAILABLE_MESSAGE,
  DEFAULT_SUPPORTED_FEEDS,
  ORACLE_ADAPTER_PYTH,
  SETTLEMENT_MODE_BOUNDED_EXACT_AFTER,
} from '../src/index.ts';

test('launch default tier is valid and ~100 BB', () => {
  const c = defaultBtcUsdcTier(100_000_000); // 100 USDC (micro)
  assert.deepEqual(validateConfig(c), []);
  assert.ok((c.buyIn * c.chipsPerUnit) / c.bigBlind >= MIN_START_BB);
  assert.equal(c.oracleAdapter, ORACLE_ADAPTER_PYTH);
  assert.equal(c.settlementMode, SETTLEMENT_MODE_BOUNDED_EXACT_AFTER);
  assert.equal(c.oracleDelayWindowSec, DEFAULT_ORACLE_DELAY_WINDOW_SEC);
  assert.equal(c.oracleUnavailableMessage, DEFAULT_ORACLE_UNAVAILABLE_MESSAGE);
  assert.deepEqual(c.supportedFeeds, [...DEFAULT_SUPPORTED_FEEDS]);
  assert.deepEqual(c.geofenceBlocklist, [...DEFAULT_GEOFENCE_BLOCKLIST]);
  assert.equal(c.allowDuplicateWalletPerMatch, false);
});

test('launch feed defaults include BTC ETH and SOL', () => {
  assert.equal(defaultBtcUsdcTier(100_000_000).priceFeedId, 'BTC/USD');
  assert.equal(defaultEthUsdcTier(100_000_000).priceFeedId, 'ETH/USD');
  assert.equal(defaultSolUsdcTier(100_000_000).priceFeedId, 'SOL/USD');
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

test('phase 0 oracle and geofence decisions are enforced', () => {
  const c = defaultBtcUsdcTier(100_000_000);

  assert.ok(validateConfig({ ...c, oracleAdapter: 'switchboard-on-demand' }).some((m) => m.includes('oracleAdapter')));
  assert.ok(validateConfig({ ...c, settlementMode: 'window-median' }).some((m) => m.includes('settlementMode')));
  assert.ok(validateConfig({ ...c, oracleDelayWindowSec: 0 }).some((m) => m.includes('oracleDelayWindowSec')));
  assert.ok(validateConfig({ ...c, oracleUnavailableMessage: 'oracle down' }).some((m) => m.includes('canonical Pyth')));
  assert.ok(validateConfig({ ...c, geofenceBlocklist: [] }).some((m) => m.includes('IN')));
  assert.ok(validateConfig({ ...c, allowDuplicateWalletPerMatch: true }).some((m) => m.includes('duplicate wallets')));
});

test('price feed must be in the configured supported feed list', () => {
  const c = defaultBtcUsdcTier(100_000_000);
  assert.ok(validateConfig({ ...c, priceFeedId: 'DOGE/USD' }).some((m) => m.includes('supportedFeeds')));
  assert.ok(validateConfig({ ...c, supportedFeeds: ['BTC/USD', 'BTC/USD'] }).some((m) => m.includes('unique')));
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
