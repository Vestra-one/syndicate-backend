import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, evaluateFill, bucketFor, Room } from '../src/index.ts';

test('no seat without finalized deposit (anti-spam gate)', () => {
  const t = new Table(2, 5);
  assert.deepEqual(t.requestSeat({ wallet: 'a', depositFinalized: false, finalityTs: 1 }), {
    ok: false,
    reason: 'deposit not finalized',
  });
  assert.equal(t.seats.length, 0);
});

test('full table and duplicates are rejected', () => {
  const t = new Table(2, 2);
  assert.ok(t.requestSeat({ wallet: 'a', depositFinalized: true, finalityTs: 1 }).ok);
  assert.ok(t.requestSeat({ wallet: 'b', depositFinalized: true, finalityTs: 2 }).ok);
  assert.deepEqual(t.requestSeat({ wallet: 'c', depositFinalized: true, finalityTs: 3 }), {
    ok: false,
    reason: 'table full',
  });
  const dup = t.requestSeat({ wallet: 'a', depositFinalized: true, finalityTs: 4 });
  assert.equal(dup.ok, false);
});

test('seat races resolve by deposit-finality order', () => {
  const t = new Table(2, 5);
  t.requestSeat({ wallet: 'late', depositFinalized: true, finalityTs: 100 });
  t.requestSeat({ wallet: 'early', depositFinalized: true, finalityTs: 10 });
  assert.equal(t.seats[0].wallet, 'early');
  assert.equal(t.seats[1].wallet, 'late');
});

test('fill window: start / void / wait', () => {
  const t = new Table(2, 5);
  assert.deepEqual(evaluateFill(t, true, false), { action: 'start' }); // full
  assert.deepEqual(evaluateFill(t, false, true), { action: 'void', reason: 'not enough players' });
  assert.deepEqual(evaluateFill(t, false, false), { action: 'wait' });
  t.requestSeat({ wallet: 'a', depositFinalized: true, finalityTs: 1 });
  t.requestSeat({ wallet: 'b', depositFinalized: true, finalityTs: 2 });
  assert.deepEqual(evaluateFill(t, false, true), { action: 'start' }); // deadline + quorum
});

test('rating buckets', () => {
  assert.equal(bucketFor(900), 'bronze');
  assert.equal(bucketFor(1200), 'silver');
  assert.equal(bucketFor(1800), 'gold');
  assert.equal(bucketFor(2500), 'elite');
});

test('private room: join, host cancel auth, host disconnect', () => {
  const r = new Room('room1', 'host', 2, 5);
  assert.ok(r.join({ wallet: 'p1', depositFinalized: true, finalityTs: 1 }).ok);
  assert.equal(r.hostCancel('intruder'), false); // only host can cancel
  // disconnect with only 1 player → void
  r.hostDisconnect();
  assert.equal(r.status, 'void');

  const r2 = new Room('room2', 'host', 2, 5);
  r2.join({ wallet: 'p1', depositFinalized: true, finalityTs: 1 });
  r2.join({ wallet: 'p2', depositFinalized: true, finalityTs: 2 });
  r2.hostDisconnect();
  assert.equal(r2.status, 'started'); // quorum → auto-start
});
