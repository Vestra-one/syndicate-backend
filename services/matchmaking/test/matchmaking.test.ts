import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, evaluateFill, bucketFor, Room, DurableMatchmakingService, MemoryMatchmakingStore } from '../src/index.ts';
import { EnforcementRegistry, complianceAction } from '../../trust-safety/src/index.ts';

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

test('active trust-safety enforcement denies public table seating', () => {
  const registry = new EnforcementRegistry();
  const action = complianceAction({ wallet: 'blocked', country: 'IN', geofenceBlocklist: ['IN'], now: 10 });
  registry.applyCompliance(action!);
  const t = new Table(2, 5, { admissionGuard: registry });

  assert.deepEqual(t.requestSeat({ wallet: 'blocked', depositFinalized: true, finalityTs: 11 }), {
    ok: false,
    reason: 'trust-safety enforcement: geofence_block: country IN is geofenced',
  });
  assert.equal(t.seats.length, 0);
  assert.ok(t.requestSeat({ wallet: 'allowed', depositFinalized: true, finalityTs: 12 }).ok);
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

test('private rooms also honor active trust-safety enforcement', () => {
  const registry = new EnforcementRegistry();
  const action = complianceAction({ wallet: 'review', requireKyc: true, kycStatus: 'pending', geofenceBlocklist: ['IN'], now: 1 });
  registry.applyCompliance(action!);
  const r = new Room('room3', 'host', 2, 5, { admissionGuard: registry });

  const blocked = r.join({ wallet: 'review', depositFinalized: true, finalityTs: 2 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /kyc_required/);
  assert.equal(r.table.seats.length, 0);
});

test('durable matchmaking service persists table seats across service instances', async () => {
  const store = new MemoryMatchmakingStore();
  const s1 = new DurableMatchmakingService({ store, minPlayers: 2, maxPlayers: 5 });
  assert.deepEqual(await s1.requestSeat('t1', { wallet: 'a', depositFinalized: true, finalityTs: 10 }), {
    ok: true,
    seatIndex: 0,
  });

  const s2 = new DurableMatchmakingService({ store, minPlayers: 2, maxPlayers: 5 });
  assert.deepEqual(await s2.requestSeat('t1', { wallet: 'b', depositFinalized: true, finalityTs: 11 }), {
    ok: true,
    seatIndex: 1,
  });
  assert.deepEqual((await s2.loadTable('t1'))?.seats.map((s) => s.wallet), ['a', 'b']);
});
