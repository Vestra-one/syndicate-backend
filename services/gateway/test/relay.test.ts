/**
 * Phase 07 — relay clock-sync, engine absolute-deadline forwarding (no fabrication),
 * and lobby room-push. Runs without `ws`/Redis: the subscriber is a duck-typed fake and
 * outbound network calls (unreachable hosts) are swallowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayHandler, ROOMS_CHANNEL } from '../src/relay.ts';

type SubHandler = (channel: string, payload: unknown) => void;

function fakeSubscriber() {
  let handler: SubHandler = () => {};
  const channels: string[] = [];
  const sub = {
    onMessage(h: SubHandler) {
      handler = h;
      return () => {};
    },
    async ensureSubscribed(matchId: string) {
      channels.push(`match:${matchId}`);
    },
    async ensureChannelSubscribed(channel: string) {
      channels.push(channel);
    },
    close() {},
  };
  return { sub, channels, emit: (channel: string, payload: unknown) => handler(channel, payload) };
}

function makeRelay(now: () => number) {
  const out: Array<{ wallet: string; msg: Record<string, unknown> }> = [];
  const { sub, channels, emit } = fakeSubscriber();
  const relay = createRelayHandler(
    {
      matchEngineUrl: 'http://127.0.0.1:1',
      matchmakingUrl: 'http://127.0.0.1:1',
      actionFeedUrl: 'http://127.0.0.1:1',
      configUrl: 'http://127.0.0.1:1',
      subscriber: sub as never,
      now,
    },
    (wallet, msg) => out.push({ wallet, msg: msg as Record<string, unknown> }),
  );
  return { relay, out, channels, emit };
}

test('pong and envelopes carry serverTime from the injected clock', async () => {
  const { relay, out } = makeRelay(() => 1234);
  await relay('w', { type: 'ping' });
  assert.equal(out.length, 1);
  assert.equal(out[0].msg.type, 'pong');
  assert.equal(out[0].msg.serverTime, 1234);
});

test('engine yourTurn absolute deadlines are forwarded verbatim; none are fabricated', async () => {
  const { relay, out, emit } = makeRelay(() => 5000);
  // Watch the match so the engine event fans out to this wallet.
  // (subscribe also hits the engine state endpoint, which is unreachable here and ignored.)
  await relay('w', { type: 'subscribe', matchId: 'M1' }).catch(() => {});
  out.length = 0;

  emit('M1', {
    type: 'yourTurn',
    toCall: 0,
    minRaiseTo: 4,
    yourTurnDeadline: 9999,
    sealEndsAt: 7000,
    bettingEndsAt: 8000,
    matchEndsAt: 12000,
  });
  const yt = out.find((o) => o.msg.type === 'yourTurn');
  assert.ok(yt, 'yourTurn forwarded');
  assert.equal(yt!.msg.yourTurnDeadline, 9999);
  assert.equal(yt!.msg.sealEndsAt, 7000);
  assert.equal(yt!.msg.bettingEndsAt, 8000);
  assert.equal(yt!.msg.matchEndsAt, 12000);
  assert.equal(yt!.msg.serverTime, 5000);
});

test('a yourTurn without an engine deadline is NOT given a synthesized one', async () => {
  const { relay, out, emit } = makeRelay(() => 5000);
  await relay('w', { type: 'subscribe', matchId: 'M2' }).catch(() => {});
  out.length = 0;
  emit('M2', { type: 'yourTurn', toCall: 2, minRaiseTo: 6 });
  const yt = out.find((o) => o.msg.type === 'yourTurn');
  assert.ok(yt);
  assert.equal('yourTurnDeadline' in yt!.msg, false, 'no fabricated deadline');
});

test('subscribeLobby subscribes to the rooms channel and pushes a lobbyList', async () => {
  const { relay, out, channels } = makeRelay(() => 42);
  await relay('w', { type: 'subscribeLobby' });
  assert.ok(channels.includes(ROOMS_CHANNEL), 'subscribed to rooms channel');
  const list = out.find((o) => o.msg.type === 'lobbyList');
  assert.ok(list, 'lobbyList pushed');
  assert.equal(list!.msg.serverTime, 42);
});

test('subscribeRoom registers the wallet and subscribes the rooms channel', async () => {
  const { relay, channels } = makeRelay(() => 1);
  await relay('w', { type: 'subscribeRoom', matchId: 'M1' });
  assert.ok(channels.includes(ROOMS_CHANNEL), 'subscribed to rooms channel for the handoff');
});

test("a watched room's 'started' upgrades only its watchers to the live match feed", async () => {
  const { relay, out, emit } = makeRelay(() => 99);
  // Alice watches the specific forming room; Bob only browses the global lobby.
  await relay('alice', { type: 'subscribeRoom', matchId: 'M1' });
  await relay('bob', { type: 'subscribeLobby' });
  out.length = 0;

  emit(ROOMS_CHANNEL, { kind: 'started', matchId: 'M1', version: 2 });

  // Alice is told to switch views; Bob (lobby-only) is not upgraded.
  const aliceStarted = out.find((o) => o.wallet === 'alice' && o.msg.type === 'matchStarted');
  assert.ok(aliceStarted, 'watcher receives matchStarted');
  assert.equal(aliceStarted!.msg.matchId, 'M1');
  assert.equal(out.some((o) => o.wallet === 'bob' && o.msg.type === 'matchStarted'), false, 'lobby-only browser not upgraded');

  // A subsequent engine event on the match channel now reaches Alice (she is in matchWatchers).
  out.length = 0;
  emit('M1', { type: 'matchState', state: { phase: 'LIVE', round: 1, pot: 0 } });
  const aliceState = out.find((o) => o.wallet === 'alice' && o.msg.type === 'matchState');
  assert.ok(aliceState, 'live match events flow to the upgraded watcher with no re-subscribe');
  assert.equal(out.some((o) => o.wallet === 'bob'), false, 'bob receives no match events');
});

test("a replayed 'started' is a no-op (idempotent handoff)", async () => {
  const { relay, out, emit } = makeRelay(() => 1);
  await relay('alice', { type: 'subscribeRoom', matchId: 'M1' });
  out.length = 0;
  emit(ROOMS_CHANNEL, { kind: 'started', matchId: 'M1', version: 2 });
  emit(ROOMS_CHANNEL, { kind: 'started', matchId: 'M1', version: 2 });
  const starts = out.filter((o) => o.msg.type === 'matchStarted');
  assert.equal(starts.length, 1, 'matchStarted pushed exactly once');
});

test('a rooms-channel mutation is pushed as roomsUpdated to lobby subscribers only', async () => {
  const { relay, out, emit } = makeRelay(() => 77);
  // Not subscribed yet → no push.
  emit(ROOMS_CHANNEL, { kind: 'upsert', roomCode: 'r1', seated: 1, version: 1 });
  assert.equal(out.filter((o) => o.msg.type === 'roomsUpdated').length, 0);

  await relay('w', { type: 'subscribeLobby' });
  out.length = 0;
  emit(ROOMS_CHANNEL, { kind: 'upsert', roomCode: 'r1', seated: 2, version: 2 });
  const upd = out.find((o) => o.msg.type === 'roomsUpdated');
  assert.ok(upd, 'roomsUpdated pushed to lobby subscriber');
  assert.equal((upd!.msg.update as { version: number }).version, 2);
  assert.equal(upd!.msg.serverTime, 77);
});
