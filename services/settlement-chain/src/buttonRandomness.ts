/**
 * Server-attested CSPRNG for dealer button assignment (v1).
 * Seed is unpredictable to clients; recorded on-chain via set_button_seed.
 */

import { createHash, randomBytes } from 'node:crypto';

const ZERO_SEED = Buffer.alloc(32, 0);

export function generateButtonSeed(onchainMatchId: bigint, matchPda: string): {
  vrfSeed: Buffer;
  vrfProofHash: Buffer;
} {
  const vrfSeed = randomBytes(32);
  const vrfProofHash = createHash('sha256')
    .update(vrfSeed)
    .update(matchPda)
    .update(onchainMatchId.toString())
    .digest();
  return { vrfSeed, vrfProofHash };
}

export function deriveButton(vrfSeed: Buffer, playerCount: number): number {
  if (playerCount <= 0) {
    throw new Error('playerCount must be positive');
  }
  return Number(vrfSeed.readBigUInt64LE(0) % BigInt(playerCount));
}

export function isZeroSeed(seed: Buffer): boolean {
  return seed.length === 32 && seed.equals(ZERO_SEED);
}

export function parseOptionalSeedHex(hex: string | undefined): Buffer | undefined {
  if (hex === undefined || hex === null || String(hex).trim() === '') return undefined;
  const seed = Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
  if (seed.length !== 32) {
    throw new Error('vrf seed must be 32 bytes');
  }
  return seed;
}

export function parseOptionalProofHex(hex: string | undefined): Buffer | undefined {
  if (hex === undefined || hex === null || String(hex).trim() === '') return undefined;
  const proof = Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
  if (proof.length !== 32) {
    throw new Error('vrf proof hash must be 32 bytes');
  }
  return proof;
}
