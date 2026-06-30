import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConfigCatalog,
  buildMatchConfig,
  bindConfig,
  getTierById,
  getTierForFeed,
  practiceModeConfig,
  validateConfig,
  BUY_IN_MIN,
  BUY_IN_MAX,
  FILL_WINDOW_MIN_SEC,
  FILL_WINDOW_MAX_SEC,
} from '../src/index.ts';

test('catalog exposes a standard ranged tier plus practice', () => {
  const catalog = buildConfigCatalog();
  assert.equal(catalog.tiers.length, 2);
  assert.equal(catalog.practiceTierId, 'tier-practice');
  const standard = catalog.tiers.find((t) => t.tierId === 'tier-standard');
  assert.ok(standard && !standard.practiceMode);
  assert.equal(standard.buyInMin, BUY_IN_MIN);
  assert.equal(standard.buyInMax, BUY_IN_MAX);
  assert.equal(standard.fillWindowMinSec, FILL_WINDOW_MIN_SEC);
  assert.equal(standard.fillWindowMaxSec, FILL_WINDOW_MAX_SEC);
  assert.ok(catalog.tiers.some((t) => t.tierId === 'tier-practice' && t.practiceMode));
});

test('practice mode requires zero buy-in', () => {
  const c = practiceModeConfig();
  assert.equal(c.buyIn, 0);
  assert.equal(c.practiceMode, true);
  assert.deepEqual(validateConfig(c), []);
});

test('getTierForFeed binds feed into config', () => {
  const tier = getTierForFeed('tier-standard', 'ETH/USD');
  assert.ok(tier);
  assert.equal(tier.config.priceFeedId, 'ETH/USD');
});

test('config_hash is stable across buy-in / fill-window for the same feed', () => {
  const a = buildMatchConfig('BTC/USD', BUY_IN_MIN, FILL_WINDOW_MIN_SEC);
  const b = buildMatchConfig('BTC/USD', 37_000_000, 110);
  const c = buildMatchConfig('BTC/USD', BUY_IN_MAX, FILL_WINDOW_MAX_SEC);
  assert.equal(bindConfig(a).hash, bindConfig(b).hash);
  assert.equal(bindConfig(a).hash, bindConfig(c).hash);
});

test('config_hash differs across feeds', () => {
  const btc = bindConfig(buildMatchConfig('BTC/USD', BUY_IN_MIN, 60)).hash;
  const eth = bindConfig(buildMatchConfig('ETH/USD', BUY_IN_MIN, 60)).hash;
  assert.notEqual(btc, eth);
});

test('buildMatchConfig derives blinds from the chosen buy-in', () => {
  const c = buildMatchConfig('BTC/USD', 100_000_000, 120);
  assert.equal(c.buyIn, 100_000_000);
  assert.equal(c.bigBlind, 1_000_000); // floor(buyIn / 100)
  assert.equal(c.smallBlind, 500_000);
  assert.equal(c.rakeCap, 100_000_000);
  assert.deepEqual(validateConfig(c), []);
});

test('validateConfig rejects out-of-range buy-in and fill-window', () => {
  const tooLow = buildMatchConfig('BTC/USD', BUY_IN_MIN - 1, 120);
  assert.ok(validateConfig(tooLow).some((m) => m.includes('buyIn')));
  const tooHigh = buildMatchConfig('BTC/USD', BUY_IN_MAX + 1, 120);
  assert.ok(validateConfig(tooHigh).some((m) => m.includes('buyIn')));
  const fillTooShort = buildMatchConfig('BTC/USD', BUY_IN_MIN, FILL_WINDOW_MIN_SEC - 1);
  assert.ok(validateConfig(fillTooShort).some((m) => m.includes('fillWindowSec')));
  const fillTooLong = buildMatchConfig('BTC/USD', BUY_IN_MIN, FILL_WINDOW_MAX_SEC + 1);
  assert.ok(validateConfig(fillTooLong).some((m) => m.includes('fillWindowSec')));
});

test('getTierById resolves standard and practice', () => {
  assert.ok(getTierById('tier-standard'));
  assert.ok(getTierById('tier-practice'));
  assert.equal(getTierById('tier-low'), undefined);
});
