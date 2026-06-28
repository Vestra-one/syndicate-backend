/**
 * Canonical Pyth Core integration presets (shared manifest with settlement-chain).
 * @see services/settlement-chain/pyth-stack.json
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../../settlement-chain/pyth-stack.json');
export const PYTH_STACK_MANIFEST = JSON.parse(readFileSync(manifestPath, 'utf8'));

export const PYTH_HERMES_CORE_URL = PYTH_STACK_MANIFEST.hermes.core;
export const PYTH_HERMES_UPGRADED_URL = PYTH_STACK_MANIFEST.hermes.upgraded;
export const DEFAULT_PYTH_HERMES_URL = PYTH_HERMES_CORE_URL;

function normalizeStackName(raw) {
  const value = (raw ?? 'legacy').trim().toLowerCase();
  if (value === 'legacy' || value === 'current' || value === 'core') return 'legacy';
  if (value === 'upgraded' || value === 'pro' || value === 'pro-compatible') return 'upgraded';
  throw new Error(`PYTH_RECEIVER_STACK must be legacy or upgraded (got ${raw})`);
}

function pick(env, ...keys) {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function envPubkey(name, env = process.env) {
  const value = pick(env, name);
  return value ? new PublicKey(value) : undefined;
}

export function resolvePythStackFromEnv(env = process.env) {
  const stack = normalizeStackName(pick(env, 'PYTH_RECEIVER_STACK', 'SYNDICATE_PYTH_RECEIVER_STACK'));
  const preset = PYTH_STACK_MANIFEST.stacks[stack];
  const hermesKey = preset.hermes;
  return {
    stack,
    hermesUrl: pick(env, 'PYTH_HERMES_URL') ?? PYTH_STACK_MANIFEST.hermes[hermesKey],
    receiverProgramId: envPubkey('PYTH_RECEIVER_PROGRAM_ID', env)
      ?? new PublicKey(preset.receiverProgramId),
    wormholeProgramId: envPubkey('PYTH_WORMHOLE_PROGRAM_ID', env)
      ?? new PublicKey(preset.wormholeProgramId),
    pushOracleProgramId: envPubkey('PYTH_PUSH_ORACLE_PROGRAM_ID', env)
      ?? new PublicKey(preset.pushOracleProgramId),
  };
}
