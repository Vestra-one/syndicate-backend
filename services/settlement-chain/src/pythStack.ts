/**
 * Canonical Pyth Core integration presets.
 *
 * Two independent axes (per Pyth docs):
 * 1. Hermes endpoint — where price updates are fetched (`core` vs `upgraded`).
 * 2. Solana receiver stack — which on-chain programs post/consume updates (`legacy` vs `upgraded`).
 *
 * Devnet today: `PYTH_RECEIVER_STACK=legacy` + `PYTH_HERMES_URL` core (default).
 * Mainnet cutover: set `PYTH_RECEIVER_STACK=upgraded` (Hermes + program IDs switch together).
 *
 * Explicit `PYTH_*_PROGRAM_ID` / `PYTH_HERMES_URL` env vars always override the preset.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PythStackName = 'legacy' | 'upgraded';

export type ResolvedPythStack = {
  stack: PythStackName;
  hermesUrl: string;
  receiverProgramId: string;
  wormholeProgramId: string;
  pushOracleProgramId: string;
};

type StackPreset = {
  description: string;
  hermes: 'core' | 'upgraded';
  receiverProgramId: string;
  wormholeProgramId: string;
  pushOracleProgramId: string;
};

type PythStackManifest = {
  hermes: Record<'core' | 'upgraded', string>;
  stacks: Record<PythStackName, StackPreset>;
  onChainAcceptedReceiverOwners: string[];
};

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../pyth-stack.json');
export const PYTH_STACK_MANIFEST: PythStackManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

export const PYTH_HERMES_CORE_URL = PYTH_STACK_MANIFEST.hermes.core;
export const PYTH_HERMES_UPGRADED_URL = PYTH_STACK_MANIFEST.hermes.upgraded;

/** Default Hermes for new deployments: Pyth Core public endpoint. */
export const DEFAULT_PYTH_HERMES_URL = PYTH_HERMES_CORE_URL;

export const ON_CHAIN_ACCEPTED_RECEIVER_OWNERS = Object.freeze(
  PYTH_STACK_MANIFEST.onChainAcceptedReceiverOwners.slice(),
);

function normalizeStackName(raw: string | undefined): PythStackName {
  const value = (raw ?? 'legacy').trim().toLowerCase();
  if (value === 'legacy' || value === 'current' || value === 'core') return 'legacy';
  if (value === 'upgraded' || value === 'pro' || value === 'pro-compatible') return 'upgraded';
  throw new Error(`PYTH_RECEIVER_STACK must be legacy or upgraded (got ${raw})`);
}

function pick(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function resolvePythStackFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedPythStack {
  const stack = normalizeStackName(pick(env, 'PYTH_RECEIVER_STACK', 'SYNDICATE_PYTH_RECEIVER_STACK'));
  const preset = PYTH_STACK_MANIFEST.stacks[stack];
  const hermesKey = preset.hermes;
  return {
    stack,
    hermesUrl: pick(env, 'PYTH_HERMES_URL') ?? PYTH_STACK_MANIFEST.hermes[hermesKey],
    receiverProgramId: pick(env, 'PYTH_RECEIVER_PROGRAM_ID') ?? preset.receiverProgramId,
    wormholeProgramId: pick(env, 'PYTH_WORMHOLE_PROGRAM_ID') ?? preset.wormholeProgramId,
    pushOracleProgramId: pick(env, 'PYTH_PUSH_ORACLE_PROGRAM_ID') ?? preset.pushOracleProgramId,
  };
}
