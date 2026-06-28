import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnforcementRegistry,
  assessWalletRisk,
  botTimingScore,
  chipDumpScore,
  coSeatingPairs,
  complianceAction,
  decide,
  sybilClusters,
  type HandResult,
} from '../src/index.ts';

test('chip-dump score is high for consistent dumping', () => {
  const hist: HandResult[] = [
    { winner: 'B', net: { A: -50, B: 50 } },
    { winner: 'B', net: { A: -40, B: 40 } },
    { winner: 'B', net: { A: -30, B: 30 } },
    { winner: 'A', net: { A: 20, B: -20 } },
  ];
  assert.equal(chipDumpScore(hist, 'A', 'B'), 0.75);
});

test('bot timing: uniform intervals flag, varied do not', () => {
  assert.equal(botTimingScore([1000, 1000, 1000, 1000]), 1); // zero variance
  assert.equal(botTimingScore([200, 1500, 800, 3000]), 0); // human-like spread
});

test('sybil clusters group shared device + funder', () => {
  const clusters = sybilClusters([
    { wallet: 'w1', deviceId: 'd1', funder: 'f1' },
    { wallet: 'w2', deviceId: 'd1', funder: 'f1' },
    { wallet: 'w3', deviceId: 'd2', funder: 'f2' },
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].sort(), ['w1', 'w2']);
});

test('enforcement decision thresholds', () => {
  assert.equal(decide({ chipDump: 0.1, bot: 0, sybilSize: 1 }), 'allow');
  assert.equal(decide({ chipDump: 0.65, bot: 0, sybilSize: 1 }), 'flag');
  assert.equal(decide({ chipDump: 0, bot: 1, sybilSize: 1 }), 'flag'); // bot
  assert.equal(decide({ chipDump: 0.9, bot: 0, sybilSize: 1 }), 'ban');
  assert.equal(decide({ chipDump: 0, bot: 0, sybilSize: 3 }), 'ban'); // big sybil ring
});

test('co-seating monitor is explainable by shared matches', () => {
  const pairs = coSeatingPairs([
    { matchId: 'm1', wallet: 'a', ts: 1 },
    { matchId: 'm1', wallet: 'b', ts: 1 },
    { matchId: 'm2', wallet: 'a', ts: 2 },
    { matchId: 'm2', wallet: 'b', ts: 2 },
    { matchId: 'm3', wallet: 'a', ts: 3 },
    { matchId: 'm3', wallet: 'b', ts: 3 },
    { matchId: 'm3', wallet: 'c', ts: 3 },
  ]);
  assert.deepEqual(pairs[0], { wallets: ['a', 'b'], sharedMatches: ['m1', 'm2', 'm3'], score: 3 });
});

test('flagged wallet cannot keep joining while active enforcement exists', () => {
  const assessment = assessWalletRisk({
    wallet: 'A',
    hands: [
      { winner: 'B', net: { A: -50, B: 50 } },
      { winner: 'B', net: { A: -40, B: 40 } },
      { winner: 'B', net: { A: -30, B: 30 } },
    ],
    suspectedCounterparties: ['B'],
    now: 100,
  });
  assert.equal(assessment.decision, 'ban');
  assert.match(assessment.explanation.join(' '), /chip_dumping/);

  const registry = new EnforcementRegistry();
  const action = registry.applyAssessment(assessment, 100);
  assert.equal(action?.type, 'ban');
  assert.equal(registry.canJoinTable('A', 101).allowed, false);
});

test('active seat-deny can escalate to ban when stronger evidence arrives', () => {
  const registry = new EnforcementRegistry();
  const flagged = assessWalletRisk({
    wallet: 'A',
    hands: [
      { winner: 'B', net: { A: -50, B: 50 } },
      { winner: 'B', net: { A: -40, B: 40 } },
      { winner: 'A', net: { A: 30, B: -30 } },
    ],
    suspectedCounterparties: ['B'],
    now: 100,
  });
  assert.equal(flagged.decision, 'flag');
  assert.equal(registry.applyAssessment(flagged, 100)?.type, 'seat_deny');

  const banned = assessWalletRisk({
    wallet: 'A',
    hands: [
      { winner: 'B', net: { A: -50, B: 50 } },
      { winner: 'B', net: { A: -40, B: 40 } },
      { winner: 'B', net: { A: -30, B: 30 } },
    ],
    suspectedCounterparties: ['B'],
    now: 101,
  });
  assert.equal(banned.decision, 'ban');
  assert.equal(registry.applyAssessment(banned, 101)?.type, 'ban');
  assert.deepEqual(
    registry
      .activeActions('A', 102)
      .map((a) => a.type)
      .sort(),
    ['ban', 'seat_deny'],
  );
});

test('appeal records can lift an active enforcement action', () => {
  const registry = new EnforcementRegistry();
  const assessment = assessWalletRisk({ wallet: 'bot', actionIntervalsMs: [1000, 1000, 1000], now: 1 });
  const action = registry.applyAssessment(assessment, 1);
  assert.ok(action);
  const appeal = registry.submitAppeal(action!.actionId, 'shared device in office', 2);
  registry.resolveAppeal(appeal.appealId, true, 'reviewer-1', 'false positive', 3);
  assert.equal(registry.canJoinTable('bot', 4).allowed, true);
  assert.equal(registry.listAppeals('bot')[0].status, 'accepted');
});

test('geofence and KYC hooks create pre-seat enforcement actions', () => {
  const registry = new EnforcementRegistry();
  const geo = complianceAction({ wallet: 'w-in', country: 'IN', geofenceBlocklist: ['IN'], now: 10 });
  assert.equal(geo?.type, 'geofence_block');
  registry.applyCompliance(geo!);
  assert.equal(registry.canJoinTable('w-in', 11).allowed, false);

  const kyc = complianceAction({ wallet: 'w-kyc', geofenceBlocklist: ['IN'], requireKyc: true, kycStatus: 'pending', now: 12 });
  assert.equal(kyc?.type, 'kyc_required');
  registry.applyCompliance(kyc!);
  assert.equal(registry.canJoinTable('w-kyc', 13).allowed, false);
  assert.equal(complianceAction({ wallet: 'ok', geofenceBlocklist: ['IN'], requireKyc: true, kycStatus: 'verified' }), null);
});
