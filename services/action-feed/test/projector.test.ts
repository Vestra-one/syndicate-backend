import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createProjectionState } from '../src/index.ts';
import { MemoryObjectStore } from '../src/object-store.ts';
import { InMemoryProjectionSource, NatsTcpPublisher, ProjectionWorker, type ProjectionMessage } from '../src/projector.ts';

function messages(): ProjectionMessage[] {
  return [
    {
      type: 'match-event',
      event: {
        id: 'e0',
        seq: 0,
        timelockOpen: false,
        raw: { kind: 'action', matchId: 'm-projector', wallet: 'wallet-hidden', seat: 0, action: 'call', amount: 25, feedPrice: 1000, pot: 50, ts: 10 },
      },
    },
    {
      type: 'match-event',
      event: {
        id: 'e1',
        seq: 1,
        timelockOpen: false,
        raw: { kind: 'seal', matchId: 'm-projector', wallet: 'wallet-hidden', ciphertext: 'secret', ts: 11 },
      },
    },
    {
      type: 'match-event',
      event: {
        id: 'e2',
        seq: 2,
        timelockOpen: true,
        raw: { kind: 'settlement', matchId: 'm-projector', settlementPrice: 1001, awards: [{ seat: 0, amount: 50 }], ts: 30 },
      },
    },
  ];
}

test('projection worker consumes outbox messages, uploads replay bundle, and acks', async () => {
  const source = new InMemoryProjectionSource(messages());
  const objectStore = new MemoryObjectStore();
  const state = createProjectionState('worker');
  const persistedReplays: string[] = [];
  let persistedCheckpoint = -1;
  const worker = new ProjectionWorker({
    state,
    source,
    objectStore,
    batchSize: 10,
    sink: {
      async persistReplay(history, bundle, objectUri) {
        persistedReplays.push(`${history.matchId}:${bundle.events.length}:${objectUri}`);
      },
      async persistTerminalHistory() {},
      async persistCheckpoint(checkpoint) {
        persistedCheckpoint = checkpoint.lastSeq;
      },
    },
  });

  assert.equal(await worker.runOnce(), 3);
  assert.equal(source.acked.length, 3);
  assert.equal(state.checkpoint.lastSeq, 2);
  assert.equal(state.matchHistory.get('m-projector')?.status, 'settled');
  const bundleUri = state.matchHistory.get('m-projector')?.replayBundleUri;
  assert.ok(bundleUri?.startsWith('memory://replays/m-projector/'));
  assert.deepEqual(persistedReplays, [`m-projector:2:${bundleUri}`]);
  assert.equal(persistedCheckpoint, 2);
  assert.equal(JSON.stringify(state.replayEvents).includes('wallet-hidden'), false);
  assert.equal(JSON.stringify(state.replayEvents).includes('secret'), false);
});

test('projection worker fails and requeues a message when publishing fails', async () => {
  const source = new InMemoryProjectionSource([messages()[0]]);
  let attempts = 0;
  const worker = new ProjectionWorker({
    state: createProjectionState('worker-fail'),
    source,
    objectStore: new MemoryObjectStore(),
    publisher: {
      async publish() {
        attempts += 1;
        if (attempts === 1) throw new Error('nats down');
      },
    },
  });

  await assert.rejects(() => worker.runOnce(), /nats down/);
  assert.equal(source.acked.length, 0);
  assert.equal(source.failed.length, 1);
  assert.equal(await worker.runOnce(), 1);
  assert.equal(source.acked.length, 1);
});

test('NATS TCP publisher emits a public-event PUB frame', async () => {
  const received = new Promise<string>((resolve) => {
    const server = createServer((socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('\r\n')) {
          server.close();
          resolve(data);
        }
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      assert.equal(typeof address, 'object');
      const publisher = new NatsTcpPublisher(`nats://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`, 'events.public');
      await publisher.publish({ kind: 'round', matchId: 'm', round: 2, ts: 1 });
    });
  });

  const frame = await received;
  assert.match(frame, /CONNECT/);
  assert.match(frame, /PUB events\.public/);
  assert.match(frame, /"matchId":"m"/);
});

test('postgres outbox poll ignores settlement aggregate rows', async () => {
  const { readFileSync } = await import('node:fs');
  const body = readFileSync(new URL('../src/projector.ts', import.meta.url), 'utf8');
  assert.match(body, /aggregate_type = 'match'/);
});
