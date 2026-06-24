import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectEvent, containsSecret, rankLiveGames, sortGames, type RawEvent, type LiveGame } from '../src/index.ts';

test('seals and intents are NEVER projected (no secret leak)', () => {
  const seal: RawEvent = { kind: 'seal', matchId: 'm', wallet: 'w', ciphertext: 'deadbeef', ts: 1 };
  const intent: RawEvent = { kind: 'intent', matchId: 'm', wallet: 'w', presigned: 'check-fold', ts: 1 };
  assert.equal(projectEvent(seal, false), null);
  assert.equal(projectEvent(seal, true), null);
  assert.equal(projectEvent(intent, true), null);
});

test('prediction is hidden before the time-lock opens, shown after', () => {
  const reveal: RawEvent = { kind: 'reveal', matchId: 'm', seat: 2, prediction: 105000, ts: 9 };
  assert.equal(projectEvent(reveal, false), null);
  const open = projectEvent(reveal, true);
  assert.ok(open && open.kind === 'reveal' && open.prediction === 105000);
});

test('projected action is pseudonymous (no wallet) and leaks no secret', () => {
  const a: RawEvent = { kind: 'action', matchId: 'm', wallet: 'walletXYZ', seat: 1, action: 'raise', amount: 50, feedPrice: 100000, pot: 120, ts: 3 };
  const pub = projectEvent(a, false);
  assert.ok(pub && pub.kind === 'action');
  assert.equal(containsSecret(pub), false);
  assert.ok(!JSON.stringify(pub).includes('walletXYZ'));
});

test('raw secret events do contain secrets (guard sanity)', () => {
  assert.equal(containsSecret({ kind: 'seal', ciphertext: 'x' }), true);
});

const games: LiveGame[] = [
  { matchId: 'a', spectators: 5, actionsPerMin: 10, potSize: 500, buyIn: 100, feed: 'SOL/USD', startedAt: 30 },
  { matchId: 'b', spectators: 50, actionsPerMin: 2, potSize: 50, buyIn: 25, feed: 'BTC/USD', startedAt: 10 },
  { matchId: 'c', spectators: 1, actionsPerMin: 1, potSize: 9000, buyIn: 1000, feed: 'ETH/USD', startedAt: 20 },
];

test('dashboard ranks by popularity (spectators-weighted)', () => {
  const ranked = rankLiveGames(games).map((g) => g.matchId);
  assert.deepEqual(ranked, ['b', 'a', 'c']); // b: 502, a: 60, c: 11
});

test('dashboard sorts by potSize and gameTime', () => {
  assert.deepEqual(sortGames(games, 'potSize').map((g) => g.matchId), ['c', 'a', 'b']);
  assert.deepEqual(sortGames(games, 'gameTime').map((g) => g.matchId), ['b', 'c', 'a']);
});
