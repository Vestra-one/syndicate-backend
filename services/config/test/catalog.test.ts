import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConfigCatalog,
  getTierById,
  getTierForFeed,
  practiceModeConfig,
  validateConfig,
} from '../src/index.ts';

test('catalog exposes 3 tiers plus practice', () => {
  const catalog = buildConfigCatalog();
  assert.equal(catalog.tiers.length, 4);
  assert.equal(catalog.practiceTierId, 'tier-practice');
  assert.ok(catalog.tiers.some((t) => t.tierId === 'tier-low' && !t.practiceMode));
  assert.ok(catalog.tiers.some((t) => t.tierId === 'tier-practice' && t.practiceMode));
});

test('practice mode requires zero buy-in', () => {
  const c = practiceModeConfig();
  assert.equal(c.buyIn, 0);
  assert.equal(c.practiceMode, true);
  assert.deepEqual(validateConfig(c), []);
});

test('tiers include fillWindowSec', () => {
  const tier = getTierById('tier-mid');
  assert.ok(tier);
  assert.ok(tier.fillWindowSec > 0);
  assert.equal(tier.config.fillWindowSec, tier.fillWindowSec);
});

test('getTierForFeed binds feed into config', () => {
  const tier = getTierForFeed('tier-low', 'ETH/USD');
  assert.ok(tier);
  assert.equal(tier.config.priceFeedId, 'ETH/USD');
});
