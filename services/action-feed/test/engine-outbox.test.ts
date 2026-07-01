import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptEngineOutboxPayload } from '../src/engine-outbox.ts';

test('adaptEngineOutboxPayload maps match.started to a public round event', () => {
  const message = adaptEngineOutboxPayload(
    { kind: 'match.started', match_id: '3638667753449722', seq: 0, ts: 1_000 },
    '00000000-0000-4000-8000-000000000001',
  );
  assert.equal(message?.type, 'match-event');
  assert.equal(message?.event.raw.kind, 'round');
  assert.equal(message?.event.raw.matchId, '3638667753449722');
});

test('adaptEngineOutboxPayload prefers on-chain id when payload match_id is aggregate uuid', () => {
  const message = adaptEngineOutboxPayload(
    {
      kind: 'match.public.voided',
      match_id: '65f36fbe-49b1-47c0-b4e6-7c1e0fc7043b',
      settlement_price: 0,
      awards: [],
      voided: true,
      seq: 9_000_000_000,
      ts: 2_000,
    },
    'outbox-id',
    '31131962278711028',
  );
  assert.equal(message?.type, 'match-event');
  if (message?.event.raw.kind === 'settlement') {
    assert.equal(message.event.raw.matchId, '31131962278711028');
    assert.equal(message.event.raw.voided, true);
  }
});

test('adaptEngineOutboxPayload maps terminal settlement payloads', () => {
  const message = adaptEngineOutboxPayload({
    kind: 'match.public.settled',
    match_id: 'm1',
    settlement_price: 42_000,
    awards: [{ seat: 0, amount: 100 }],
    seq: 9_000_000_000,
    ts: 2_000,
  });
  assert.equal(message?.type, 'match-event');
  if (message?.event.raw.kind === 'settlement') {
    assert.equal(message.event.raw.settlementPrice, 42_000);
    assert.equal(message.event.raw.voided, false);
  }
});
