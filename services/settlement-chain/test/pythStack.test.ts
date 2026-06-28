import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PYTH_HERMES_URL,
  ON_CHAIN_ACCEPTED_RECEIVER_OWNERS,
  PYTH_HERMES_CORE_URL,
  PYTH_HERMES_UPGRADED_URL,
  PYTH_STACK_MANIFEST,
  resolvePythStackFromEnv,
} from '../src/pythStack.ts';

test('pyth-stack manifest matches Pyth Core contract addresses', () => {
  assert.equal(PYTH_HERMES_CORE_URL, 'https://hermes.pyth.network');
  assert.equal(PYTH_HERMES_UPGRADED_URL, 'https://pyth.dourolabs.app/hermes');
  assert.equal(PYTH_STACK_MANIFEST.stacks.legacy.receiverProgramId, 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
  assert.equal(PYTH_STACK_MANIFEST.stacks.upgraded.receiverProgramId, 'rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp');
  assert.deepEqual(ON_CHAIN_ACCEPTED_RECEIVER_OWNERS, [
    'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',
    'rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp',
  ]);
});

test('legacy stack defaults to Pyth Core Hermes + current receiver programs', () => {
  const stack = resolvePythStackFromEnv({});
  assert.equal(stack.stack, 'legacy');
  assert.equal(stack.hermesUrl, PYTH_HERMES_CORE_URL);
  assert.equal(stack.receiverProgramId, PYTH_STACK_MANIFEST.stacks.legacy.receiverProgramId);
});

test('upgraded stack switches Hermes and on-chain program ids together', () => {
  const stack = resolvePythStackFromEnv({ PYTH_RECEIVER_STACK: 'upgraded' });
  assert.equal(stack.stack, 'upgraded');
  assert.equal(stack.hermesUrl, PYTH_HERMES_UPGRADED_URL);
  assert.equal(stack.receiverProgramId, PYTH_STACK_MANIFEST.stacks.upgraded.receiverProgramId);
  assert.equal(stack.wormholeProgramId, PYTH_STACK_MANIFEST.stacks.upgraded.wormholeProgramId);
});

test('explicit env overrides beat stack preset', () => {
  const stack = resolvePythStackFromEnv({
    PYTH_RECEIVER_STACK: 'legacy',
    PYTH_HERMES_URL: 'https://custom.example/hermes',
    PYTH_RECEIVER_PROGRAM_ID: '11111111111111111111111111111111',
  });
  assert.equal(stack.hermesUrl, 'https://custom.example/hermes');
  assert.equal(stack.receiverProgramId, '11111111111111111111111111111111');
});

test('default Hermes export points at Pyth Core', () => {
  assert.equal(DEFAULT_PYTH_HERMES_URL, PYTH_HERMES_CORE_URL);
});
