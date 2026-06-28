/**
 * E2E lifecycle smoke tests (library-level; full fleet via docker-compose).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStartPolicy } from '../../matchmaking/src/start-policy.ts';
import { buildConfigCatalog } from '../../config/src/index.ts';

test('practice tier in catalog skips custody', () => {
  const catalog = buildConfigCatalog();
  const practice = catalog.tiers.find((t) => t.practiceMode);
  assert.ok(practice);
  assert.equal(practice.config.buyIn, 0);
});

test('private room host start path', () => {
  const policy = evaluateStartPolicy({
    mode: 'private_host',
    seated: 2,
    minPlayers: 2,
    maxPlayers: 5,
    fillDeadlineReached: false,
    hostStartRequested: true,
  });
  assert.equal(policy.action, 'start');
});

test('public queue dissolve below min at deadline', () => {
  const policy = evaluateStartPolicy({
    mode: 'public_formation',
    seated: 1,
    minPlayers: 2,
    maxPlayers: 5,
    fillDeadlineReached: true,
  });
  assert.equal(policy.action, 'void');
});
