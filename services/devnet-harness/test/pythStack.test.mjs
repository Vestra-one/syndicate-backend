import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PYTH_HERMES_URL,
  PYTH_STACK_MANIFEST,
  resolvePythStackFromEnv,
} from '../src/pythStack.mjs';

test('devnet harness shares settlement-chain pyth-stack manifest', () => {
  assert.equal(PYTH_STACK_MANIFEST.stacks.legacy.receiverProgramId, 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
  assert.equal(DEFAULT_PYTH_HERMES_URL, 'https://hermes.pyth.network');
});

test('SYNDICATE_PYTH_RECEIVER_STACK alias resolves upgraded stack', () => {
  const stack = resolvePythStackFromEnv({ SYNDICATE_PYTH_RECEIVER_STACK: 'pro' });
  assert.equal(stack.stack, 'upgraded');
  assert.equal(stack.hermesUrl, PYTH_STACK_MANIFEST.hermes.upgraded);
});
