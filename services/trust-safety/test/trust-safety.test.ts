import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipDumpScore, botTimingScore, sybilClusters, decide, type HandResult } from '../src/index.ts';

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
