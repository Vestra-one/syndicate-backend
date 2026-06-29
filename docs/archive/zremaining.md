1. ~~The on-chain program has never been compiled or run.~~ **Partially closed (devnet, 2026-06-28):** Program compiles on Solana toolchain; upgraded on devnet (`FR4tq…`, dual Pyth receiver owners). Devnet harness exercises full lifecycle: create → deposit → lock → seal → action log → Pyth post → `submit_settlement` → `claim`. Refund path also verified.

   **Still open:** litesvm coverage for `submit_settlement` / `claim` / fee withdrawal; golden parity through the program binary; local `cargo build-sbf` requires unsetting sandbox `CARGO_TARGET_DIR` so artifacts land in `services/programs/target/`.
2. ~~VRF is operator-attested, not real randomness.~~ **Closed (v1):** settlement-chain now generates CSPRNG button seeds (`buttonRandomness.ts`); seeds are unpredictable to clients and recorded on-chain. Trust model is **server-attested** (not decentralized oracle VRF). Upgrade to Switchboard/ORAO on-chain verification is a future enhancement if button fairness becomes a hard requirement.

3. ~~Integration not exercised end-to-end.~~ **Closed (v1 localnet):** E2E harness `services/gateway/test/e2e-act-loop.test.ts` drives WS `act` → match-engine `/internal/matches/*/actions` → Redis `match:{id}` → gateway `MatchSubscriber` → WS fan-out. Verified against live Redis + Postgres (2026-06-28).

   **Bugs fixed during E2E:**
   - Demo mode used a fresh `InMemoryLeaseCoordinator` per action → all acts returned `409 LeaseMismatch`. Fixed: shared `memory_leases` on `EngineServerState`, acquired on demo match start.
   - Demo mode did not publish `matchState`/`yourTurn` to Redis after actions (coordinator path did). Fixed: demo apply path now publishes like coordinator path.
   - `SYNDICATE_ALLOW_DEV_SIGNATURES=1` allows `sig-*` intents for localnet E2E without wallet keys.

   **Still not E2E-tested (out of scope for this loop):**
   - Full match through seal → settlement → worker → on-chain (devnet harness covers on-chain half; worker/backend path not wired).
   - Docker app stack with stale match-engine image (rebuild `deploy/docker-compose.app.yml match-engine` before staging).
   - Matchmaking → orchestrator → custody deposit → begin_live → gateway (upstream of engine).
   - Timeout defaults / `setDefault` / `sealPrediction` over the same Redis loop.
   - Production ed25519 intent signatures (dev bypass only in test/localnet).

4. Operational gates (explicitly out of code scope, still required):

External audit + bug bounty
Multisig/key ceremony, mainnet program-key generation (declare_id! still placeholder)
Treasury funding
Real IDL emission (committed file is a placeholder)
Staging run of kill switches




Remaining from step 1
These execute successfully via MatchHarness::Krist::new():

initialize_protocol
create_match
deposit (×3)
lock
set_button_seed
begin_live
Still not exercised in litesvm (devnet harness covers these on-chain)
Point 1 litesvm gap remains. Devnet harness (2026-06-28) verified on devnet:

init_action_log, register_prediction_commitment, append_player_action, finalize_action_log
submit_settlement (legacy Pyth receiver + Pyth Core Hermes)
claim

Still not exercised in litesvm:
Golden parity through the program (only shared-core today)
The two full_lifecycle.rs tests are placeholders — they assert match_key != default and don't drive settlement or fee withdrawal.

Bottom line: SEALING → Live works in litesvm; settlement → claim works on devnet via the lifecycle harness. Next: litesvm helpers for submit_settlement through claim/withdraw_fees and golden parity through the program `.so`.