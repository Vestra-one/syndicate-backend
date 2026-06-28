import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProfileEvent,
  applySequencedEvent,
  containsSecret,
  createProjectionState,
  leaderboard,
  projectEvent,
  rankLiveGames,
  replayBundle,
  sortGames,
  type LiveGame,
  type RawEvent,
} from '../src/index.ts';

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

test('read-model projection builds live games, history, replay and checkpoints', () => {
  const state = createProjectionState('live_games');
  applySequencedEvent(state, {
    id: 'e0',
    seq: 0,
    timelockOpen: false,
    raw: { kind: 'action', matchId: 'm1', wallet: 'w1', seat: 0, action: 'call', amount: 20, feedPrice: 1000, pot: 40, ts: 10 },
  });
  applySequencedEvent(state, {
    id: 'e1',
    seq: 1,
    timelockOpen: false,
    raw: { kind: 'seal', matchId: 'm1', wallet: 'w1', ciphertext: 'secret', ts: 11 },
  });
  applySequencedEvent(state, {
    id: 'e2',
    seq: 2,
    timelockOpen: true,
    raw: { kind: 'settlement', matchId: 'm1', settlementPrice: 1005, awards: [{ seat: 0, amount: 40 }], ts: 30 },
  });

  assert.equal(state.checkpoint.lastSeq, 2);
  assert.equal(state.liveGames.has('m1'), false);
  assert.equal(state.matchHistory.get('m1')?.status, 'settled');
  assert.equal(state.matchHistory.get('m1')?.summary.awardTotal, 40);
  assert.equal(state.replayEvents.get('m1')?.length, 2); // seal was dropped
  assert.equal(containsSecret(state.replayEvents.get('m1')), false);
});

test('replay bundle is deterministic and redacted', () => {
  const state = createProjectionState('replay');
  applySequencedEvent(state, {
    id: 'e0',
    seq: 0,
    timelockOpen: false,
    raw: { kind: 'action', matchId: 'm2', wallet: 'wallet-hidden', seat: 1, action: 'raise', amount: 50, feedPrice: 2000, pot: 75, ts: 20 },
  });
  applySequencedEvent(state, {
    id: 'e1',
    seq: 1,
    timelockOpen: true,
    raw: { kind: 'reveal', matchId: 'm2', seat: 1, prediction: 1999, ts: 25 },
  });
  const bundle = replayBundle('m2', state.replayEvents.get('m2') ?? []);
  const again = replayBundle('m2', [...(state.replayEvents.get('m2') ?? [])].reverse());
  assert.equal(bundle.contentHash, again.contentHash);
  assert.equal(bundle.events.length, 2);
  assert.equal(containsSecret(bundle), false);
});

test('profile stats and leaderboard stay pseudonymous', () => {
  const state = createProjectionState('profiles');
  applyProfileEvent(state, {
    userId: 'u1',
    publicHandle: 'alpha',
    matchId: 'm1',
    seat: 0,
    buyIn: 100,
    payout: 180,
    folded: false,
    showdown: true,
    won: true,
    achievements: 1,
    ts: 10,
  });
  applyProfileEvent(state, {
    userId: 'u2',
    publicHandle: 'beta',
    matchId: 'm1',
    seat: 1,
    buyIn: 100,
    payout: 0,
    folded: true,
    showdown: false,
    won: false,
    ts: 10,
  });
  const board = leaderboard(state.profileStats.values());
  assert.deepEqual(board.map((e) => e.handle), ['alpha', 'beta']);
  assert.equal(JSON.stringify(board).includes('wallet'), false);
  assert.equal(state.profileStats.get('u1')?.matchesWon, 1);
  assert.equal(state.profileStats.get('u2')?.foldCount, 1);
});
