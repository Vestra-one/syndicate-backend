import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStartPolicy } from '../src/start-policy.ts';

test('private host start at min', () => {
  const r = evaluateStartPolicy({
    mode: 'private_host',
    seated: 2,
    minPlayers: 2,
    maxPlayers: 5,
    fillDeadlineReached: false,
    hostStartRequested: true,
  });
  assert.equal(r.action, 'start');
  assert.equal(r.trigger, 'host');
});

test('private host does not auto-start at min without host', () => {
  const r = evaluateStartPolicy({
    mode: 'private_host',
    seated: 3,
    minPlayers: 2,
    maxPlayers: 5,
    fillDeadlineReached: true,
    hostStartRequested: false,
  });
  assert.equal(r.action, 'wait');
});

test('private void when underfill at deadline', () => {
  const r = evaluateStartPolicy({
    mode: 'private_host',
    seated: 1,
    minPlayers: 2,
    maxPlayers: 5,
    fillDeadlineReached: true,
  });
  assert.equal(r.action, 'void');
});

test('public max fill starts immediately', () => {
  const r = evaluateStartPolicy({
    mode: 'public_formation',
    seated: 5,
    minPlayers: 2,
    maxPlayers: 5,
    fillDeadlineReached: false,
  });
  assert.equal(r.action, 'start');
  assert.equal(r.trigger, 'max_fill');
});

test('public deadline start with available', () => {
  const r = evaluateStartPolicy({
    mode: 'public_formation',
    seated: 3,
    minPlayers: 2,
    maxPlayers: 5,
    fillDeadlineReached: true,
  });
  assert.equal(r.action, 'start');
  assert.equal(r.trigger, 'fill_deadline');
});

test('public deadline dissolve below min', () => {
  const r = evaluateStartPolicy({
    mode: 'public_formation',
    seated: 1,
    minPlayers: 2,
    maxPlayers: 5,
    fillDeadlineReached: true,
  });
  assert.equal(r.action, 'void');
});
