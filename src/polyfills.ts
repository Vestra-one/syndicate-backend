// Global Buffer shim. Solana web3.js, Anchor, bs58, and tlock-js all reach for
// the Node `Buffer` global at runtime. Vite's dev server (esbuild pre-bundle)
// happens to expose it, but the production Rollup build does not — so tx paths
// throw "Buffer is not defined" only in the deployed app. Assign it globally.
//
// This module MUST be the first import in main.tsx: ES modules evaluate imports
// depth-first in source order, so importing it first guarantees `globalThis.Buffer`
// is set before any Solana dependency's module body runs.
import { Buffer } from 'buffer'

if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}
