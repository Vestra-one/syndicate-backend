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

test('adaptEngineOutboxPayload maps terminal settlement payloads', () => {
  const message = adaptEngineOutboxPayload({
    kind: 'match.public.settled',
    match_id: 'm1',
    settlement_price: 42_000,
    awards: [{ seat: 0, amount: 1_000_000 }],
    seq: 99,
    ts: 2_000,
  });
  assert.equal(message?.event.raw.kind, 'settlement');
  if (message?.event.raw.kind === 'settlement') {
    assert.equal(message.event.raw.settlementPrice, 42_000);
    assert.equal(message.event.raw.voided, false);
  }
});

test('adaptEngineOutboxPayload passes through canonical projection envelopes', () => {
  const input = {
    type: 'match-event',
    event: {
      id: 'e1',
      seq: 1,
      timelockOpen: false,
      raw: { kind: 'round', matchId: 'm1', round: 2, ts: 3 },
    },
  };
  assert.deepEqual(adaptEngineOutboxPayload(input), input);
});
