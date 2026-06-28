import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const packageRoot = process.env.npm_package_json
  ? dirname(process.env.npm_package_json)
  : process.cwd();

patchFile(
  join(packageRoot, 'node_modules/@pythnetwork/solana-utils/dist/esm/jito.mjs'),
  'from "jito-ts/dist/sdk/block-engine/types";',
  'from "jito-ts/dist/sdk/block-engine/types.js";',
);
patchFile(
  join(packageRoot, 'node_modules/@pythnetwork/pyth-solana-receiver/dist/esm/vaa.mjs'),
  'from "@coral-xyz/anchor/dist/cjs/utils/bytes";',
  'from "@coral-xyz/anchor/dist/cjs/utils/bytes/index.js";',
);

function patchFile(target, before, after) {
  if (!existsSync(target)) {
    return;
  }

  const source = readFileSync(target, 'utf8');
  if (source.includes(after)) {
    return;
  }
  if (!source.includes(before)) {
    throw new Error(`Pyth ESM patch target changed: ${target}`);
  }

  writeFileSync(target, source.replace(before, after));
}
