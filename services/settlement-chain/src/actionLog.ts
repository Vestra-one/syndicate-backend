/**
 * Anchor instruction discriminator helper.
 */

import { createHash } from 'node:crypto';

export function anchorDiscriminator(preimage: string): Buffer {
  return createHash('sha256').update(preimage).digest().subarray(0, 8);
}
