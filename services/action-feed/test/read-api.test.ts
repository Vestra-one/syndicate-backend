import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import {
  applyProfileEvent,
  applySequencedEvent,
  createProjectionState,
  type PublicEvent,
} from '../src/index.ts';
import { MemoryObjectStore } from '../src/object-store.ts';
import { ActionFeedReadServer, makeWebSocketKey } from '../src/server.ts';

function seededState() {
  const state = createProjectionState('api');
  applySequencedEvent(state, {
    id: 'e0',
    seq: 0,
    timelockOpen: false,
    raw: { kind: 'action', matchId: 'm-api', wallet: 'hidden-wallet', seat: 0, action: 'call', amount: 25, feedPrice: 1000, pot: 50, ts: 10 },
  });
  applySequencedEvent(state, {
    id: 'e1',
    seq: 1,
    timelockOpen: true,
    raw: { kind: 'settlement', matchId: 'm-api', settlementPrice: 1001, awards: [{ seat: 0, amount: 50 }], ts: 30 },
  });
  applySequencedEvent(state, {
    id: 'e2',
    seq: 2,
    timelockOpen: false,
    raw: { kind: 'action', matchId: 'm-old', wallet: 'older-hidden-wallet', seat: 1, action: 'betTo', amount: 10, feedPrice: 900, pot: 20, ts: 5 },
  });
  applySequencedEvent(state, {
    id: 'e3',
    seq: 3,
    timelockOpen: true,
    raw: { kind: 'settlement', matchId: 'm-old', settlementPrice: 901, awards: [{ seat: 1, amount: 20 }], ts: 8 },
  });
  applySequencedEvent(state, {
    id: 'e4',
    seq: 4,
    timelockOpen: false,
    raw: { kind: 'action', matchId: 'm-live', wallet: 'live-hidden-wallet', seat: 2, action: 'check', amount: 0, feedPrice: 1100, pot: 0, ts: 40 },
  });
  applyProfileEvent(state, {
    userId: 'u-api',
    publicHandle: 'alpha',
    matchId: 'm-api',
    seat: 0,
    buyIn: 25,
    payout: 50,
    folded: false,
    showdown: true,
    won: true,
    achievements: 1,
    ts: 30,
  });
  return state;
}

test('HTTP read API serves active/history/replay/profile/leaderboard with replay object upload', async () => {
  const objectStore = new MemoryObjectStore();
  const server = new ActionFeedReadServer({ state: seededState(), objectStore });
  await server.ready;

  const base = `http://127.0.0.1:${server.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);

  const history = await (await fetch(`${base}/matches/m-api/history`)).json();
  assert.equal(history.match.status, 'settled');
  assert.equal(JSON.stringify(history).includes('hidden-wallet'), false);

  const historyPage = await (await fetch(`${base}/matches/history?limit=1`)).json();
  assert.equal(historyPage.matches.length, 1);
  assert.equal(historyPage.matches[0].matchId, 'm-api');
  assert.equal(historyPage.matches.some((m: { matchId: string }) => m.matchId === 'm-live'), false);
  assert.equal(JSON.stringify(historyPage).includes('hidden-wallet'), false);
  assert.equal(typeof historyPage.nextCursor, 'string');

  const olderPage = await (await fetch(`${base}/matches/history?cursor=${encodeURIComponent(historyPage.nextCursor)}`)).json();
  assert.equal(olderPage.matches[0].matchId, 'm-old');
  assert.equal(olderPage.nextCursor, undefined);

  const allPage = await (await fetch(`${base}/matches/history?status=all`)).json();
  assert.equal(allPage.matches[0].matchId, 'm-live');

  const actions = await (await fetch(`${base}/matches/m-api/actions`)).json();
  assert.deepEqual(actions.events.map((e: { kind: string }) => e.kind), ['action', 'settlement']);
  assert.equal(JSON.stringify(actions).includes('hidden-wallet'), false);

  const replay = await (await fetch(`${base}/matches/m-api/replay`)).json();
  assert.ok(replay.bundle.objectUri.startsWith('memory://'));
  assert.equal(replay.bundle.events.length, 2);
  assert.equal(JSON.stringify(replay).includes('hidden-wallet'), false);

  const stored = await objectStore.getJson<{ matchId: string }>(`replays/m-api/${replay.bundle.contentHash}.json`);
  assert.equal(stored.matchId, 'm-api');

  const restartedState = createProjectionState('api-restarted');
  restartedState.matchHistory.set('m-api', { ...history.match, replayBundleUri: replay.bundle.objectUri });
  const restartedServer = new ActionFeedReadServer({ state: restartedState, objectStore });
  await restartedServer.ready;
  const restartedBase = `http://127.0.0.1:${restartedServer.port}`;
  const restoredActions = await (await fetch(`${restartedBase}/matches/m-api/actions`)).json();
  assert.deepEqual(restoredActions.events.map((e: { kind: string }) => e.kind), ['action', 'settlement']);
  await restartedServer.close();

  const profile = await (await fetch(`${base}/profiles/u-api`)).json();
  assert.equal(profile.profile.publicHandle, 'alpha');

  const board = await (await fetch(`${base}/leaderboard`)).json();
  assert.equal(board.entries[0].publicHandle, 'alpha');

  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /syndicate_action_feed_http_requests_total/);
  assert.match(metrics, /syndicate_action_feed_live_games/);

  await server.close();
});

test('WebSocket read API broadcasts public events by match subscription', async () => {
  const server = new ActionFeedReadServer({ state: seededState() });
  await server.ready;

  const socket = connect(server.port, '127.0.0.1');
  let didBroadcast = false;
  const received = new Promise<PublicEvent>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, 5000);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const split = buffer.indexOf('\r\n\r\n');
        if (split === -1) return;
        const header = buffer.subarray(0, split).toString('utf8');
        assert.match(header, /101 Switching Protocols/);
        buffer = buffer.subarray(split + 4);
        upgraded = true;
        if (!didBroadcast) {
          didBroadcast = true;
          server.broadcastPublicEvent({ kind: 'round', matchId: 'other', round: 2, ts: 1 });
          server.broadcastPublicEvent({ kind: 'round', matchId: 'm-api', round: 2, ts: 2 });
        }
      }
      const message = readTextFrame(buffer);
      if (message) {
        clearTimeout(timer);
        resolve(JSON.parse(message).event);
      }
    });
    socket.on('error', reject);
  });

  socket.write([
    'GET /ws?matchId=m-api HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${makeWebSocketKey()}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n'));

  const event = await received;
  assert.deepEqual(event, { kind: 'round', matchId: 'm-api', round: 2, ts: 2 });
  assert.equal(JSON.stringify(event).includes('wallet'), false);

  socket.destroy();
  await server.close();
});

function readTextFrame(buffer: Buffer): string | null {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return buffer.subarray(offset, offset + length).toString('utf8');
}
