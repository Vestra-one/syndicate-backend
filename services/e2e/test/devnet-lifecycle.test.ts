/**
 * Phase 11 — End-to-end devnet integration gate.
 *
 * Drives the full v1 player-created lifecycle against a deployed devnet program and asserts the
 * vault SPL-token balance settles to exactly zero, plus one void path. This is the integration
 * gate that surfaces drift unit tests miss (account ordering, field encodings, conservation).
 *
 * The signing client lives in `../src/devnet-driver.mjs` — it owns the wallet key material, builds
 * the real v1 instructions, and (after rotating the protocol `price_signer` to an e2e-controlled
 * key) produces its own EIP-191 signed settlement price, so the full settlement path runs without
 * the external signed-price-server.
 *
 * In v1 the HTTP services (matchmaking / orchestrator / settlement-chain) only verify client-
 * reported txhashes and keep a registry — they are NOT in the custody path. The on-chain lifecycle
 * the driver exercises IS the capital-safety gate, so it is the authoritative assertion here. If a
 * local fleet is up, registry reporting can be layered on top, but the gate does not require it.
 *
 * It is **env-gated** and skips cleanly unless the operator opts in with `SYNDICATE_E2E_DEVNET=1`
 * (see services/e2e/README.md). It never runs in CI by default because it spends devnet SOL and
 * depends on external liveness (RPC). Treat a failure here as a signal to fix the OWNING phase,
 * not to patch around in e2e.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevnetGate } from '../src/devnet-driver.mjs';

const GATE_TIMEOUT_MS = 5 * 60 * 1000; // devnet confirmations + seal/fill windows

test('devnet lifecycle gate: happy path settles and void path refunds; both drain the vault to 0', { timeout: GATE_TIMEOUT_MS }, async (t) => {
  if (process.env.SYNDICATE_E2E_DEVNET !== '1') {
    t.skip('SYNDICATE_E2E_DEVNET!=1 — devnet integration gate not requested');
    return;
  }

  // The driver loads the operator (admin) keypair, the player keypairs, deploys a fresh chips
  // mint, rotates price_signer, and runs both lifecycles. Missing key material throws a clear
  // error rather than running a partial match. Diagnostics stream through t.diagnostic.
  const result = await runDevnetGate(process.env, (m: string) => t.diagnostic(m));

  // Happy path: terminal Settled, vault fully drained by player claims (rake/entry_fee 0).
  assert.equal(result.happy.status, 3, 'happy path match must be Settled');
  assert.equal(result.happy.vaultBal, '0', 'happy path vault must drain to 0 after claims');

  // Void path: terminal Void, vault fully drained by the refund.
  assert.equal(result.voided.status, 4, 'void path match must be Void');
  assert.equal(result.voided.vaultBal, '0', 'void path vault must drain to 0 after refund');

  t.diagnostic(`happy match ${result.happy.matchPda} vault ${result.happy.vaultPda} → 0`);
  t.diagnostic(`void  match ${result.voided.matchPda} vault ${result.voided.vaultPda} → 0`);
});
