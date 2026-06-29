# Syndicate Backend — v1 Completion Checklist

**The single check-book to feature-complete the backend and mark it deployment-ready.**
Source of truth = code (verified by full-service survey 2026-06-29). No mocks, no stubs, no
missing implementation allowed for v1. Supersedes `docs/archive/remaining.md` (stale: predates
the action-log removal and Pyth→signed-price switch).

Legend: ✅ done & verified · 🟡 partial · ⬜ not started · 🔴 blocker (breaks the critical path)

---

## 0. Reality check — what is already DONE (do not redo)

- ✅ **On-chain program** (`services/programs`) — all 6 finalization tasks complete; `cargo check` clean. Signed-price oracle, no action-log, backend-native button, `create_and_deposit`, two-sided void coverage, generalized conservation.
- ✅ **Settlement core** (`services/shared`) — `dead_money` + generalized conservation; `settle()` canonical.
- ✅ **Worker + settlement** (`services/worker`, `services/settlement`) — signed-price fetch, drand timelock decrypt, per-seat payout via `shared::settle()`, idempotent attempt store + retry + dead-letter + void fallback, `dead_money` threaded DB→bundle. Substantially production-ready.
- ✅ **Timelock** (`services/timelock`) — real drand tlock encrypt/decrypt, quicknet pinned (genesis 1692803367, period 3), 60s grace→VOID outage path.
- ✅ **Match-engine + engine-core** — multi-street, force-resolve, observation windows, 9 passing tests.
- ✅ **Config templates** (`services/config`) — observation windows, seal/begin-live windows, nonseal penalty, tight oracle tolerance, allowlist.
- ✅ **Store core** — `dead_money_chips` + full settlement context query wired.
- ✅ **`declare_id!` alignment** — `Gwzr…` consistent across keypair / harness / `lib.rs`. (Old blocker resolved.)

---

## 1. 🔴 CRITICAL PATH — make `lock → begin_live → settle` executable end-to-end

This chain is currently **broken in three places**. Until fixed, no match can go Live or settle on devnet.

### 1a. settlement-chain client — fix/add lifecycle builders
File: [services/settlement-chain/src/custody.ts](services/settlement-chain/src/custody.ts), [src/main.ts](services/settlement-chain/src/main.ts)

- 🔴 `buildBeginLiveInstruction` — **BROKEN**: append `button_randomness: [u8;32]` to ix data (matches on-chain `BeginLiveArgs`); add **all seat PDAs** as writable `remaining_accounts`. Without this, `begin_live` always fails.
- ⬜ Add `buildDepositInstruction(seat_index: u16)` — accounts: player, protocol, match, seat, seat_index, player_token, vault, token_program, system_program.
- ⬜ Add `buildCreateAndDepositInstruction(params, seat_index)` — the atomic player create+seat path.
- ⬜ Add `buildRegisterPredictionCommitmentInstruction({ commitment[32], timelock_target u64 })` — accounts: player (signer), match, seat. (Usually player-signed client-side, but keep a consistent builder.)
- ⬜ Add `buildVoidBeforeStartInstruction` — permissionless; match PDA only.
- ⬜ Add `buildVoidLiveAfterDeadlineInstruction` — permissionless; match PDA only.
- ⬜ **Remove dead code**: `buildSetButtonSeedInstruction`, `submitSetButtonSeed`, `SetButtonSeedInput`, the `/internal/solana/set-button-seed` route in `main.ts`, and `readMatchPlayerCount` + the stale `MATCH_ACCOUNT_PLAYER_COUNT_OFFSET = 235` in [src/matchAccount.ts](services/settlement-chain/src/matchAccount.ts) (offset is wrong post-reorder; only used by the dead button-seed path).
- ⬜ Wire `/internal/solana/begin-live` route to (a) generate/accept `button_randomness`, (b) enumerate seat PDAs.
- ⬜ Add a **seat-PDA enumeration** helper: `getProgramAccounts(programId, memcmp { offset: 8, bytes: matchKey })` returning the authoritative seat set for `begin_live` (§2).
- ⬜ Add a **deposit/create verification** helper: `getTransaction(sig, 'finalized')` + `getAccountInfo` on the match/seat PDA, deserialize and validate (status, seat fields, `config_hash` allowlist). Consumed by matchmaking (§3).
- ⬜ Tests for every new builder (deposit, create_and_deposit, register_prediction_commitment, both voids, begin_live-with-seats) + the verification/enumeration helpers.

### 1b. Orchestrator — slim to the v2 start-policy
File: [services/match-orchestrator/src/main.rs](services/match-orchestrator/src/main.rs)

- 🔴 **Remove the `set-button-seed` step** (lines ~253–296) — it calls an instruction that no longer exists on-chain; the start-policy currently cannot complete.
- ⬜ `begin_live` step: generate CSPRNG `button_randomness`, enumerate the match's seat PDAs, pass both through settlement-chain.
- ⬜ Pass `liveStartTs` (from `begin_live` on-chain result), `roundDurationsSec[]`, `observationWindowsSec[]` into the engine `start` body (engine already accepts them; orchestrator omits them today).
- ⬜ Remove `/internal/formations/bootstrap` (operator-create path; v2 is player-created).
- ⬜ Keep `/internal/start-policy`; final sequence = `lock → begin_live(randomness+seats) → engine start`.

### 1c. Fresh IDL + devnet deploy
Files: [services/programs/target/idl/syndicate_program.json](services/programs/target/idl/syndicate_program.json), [services/programs/Anchor.toml](services/programs/Anchor.toml)

- 🔴 **Regenerate the IDL** — committed IDL is stale (still lists `append_player_action`, `append_timeout_action`, `action_log` accounts; missing `void_before_start`/`void_live_after_deadline`/`create_and_deposit`). Run `cargo build-sbf --tools-version v1.53` and commit the fresh `target/idl/syndicate_program.json`.
- ⬜ Fresh devnet deploy of the new layout (greenfield, no migration).
- ⬜ End-to-end smoke on devnet: `create_and_deposit → deposit(joiners) → lock → register_prediction_commitment → begin_live → submit_settlement → claim`.

---

## 2. NO indexer — RPC txhash verification + backend-owned registry  🟢 (architecture locked)

**Decision (v1, locked):** there is **no indexer service** and no chain subscription. The backend
maintains its own open-rooms registry, populated from **client-reported txhashes verified via RPC**.
The chain remains the verification authority; the registry is a convenience/UX projection only.
Capital safety never depends on the registry (see note below).

- ⬜ **Deposit/create verification (RPC):** add a verifier (likely in `settlement-chain` or `matchmaking`) that, given a client-reported tx signature, calls `getTransaction` / `getAccountInfo` at **`finalized`** commitment, deserializes the `MatchAccount`/`SeatAccount`, and asserts: tx succeeded; the seat PDA exists with the expected `player`/`seat_index`/`buy_in`; the match is `Filling`; `config_hash ∈ GET /config/templates` allowlist.
- ⬜ **Backend registry writes (the projection the indexer would have done, now inline):**
  - On verified **create** → insert the match row + open-room entry (Postgres + Redis).
  - On verified **deposit** → increment the registry seat count for that room.
  - On **`begin_live`** (orchestrator-driven) → write `live_start_ts` + `scheduled_end_ts` (from the on-chain result) to Postgres for the worker/timelock.
  - On **settle/void** (worker-driven) → mark terminal.
- ⬜ **Authoritative seat set comes from chain, not the registry:** at `lock`→`begin_live`, the orchestrator enumerates seat PDAs via `getProgramAccounts(memcmp on SeatAccount.match_key)` so `begin_live`'s `remaining_accounts.len() == player_count` always holds even for an unreported deposit. (See §1b.)
- ⬜ **Allowlist gate + anti-spam** live at registration time: reject non-allowlisted `config_hash`; enforce the per-wallet active-unfilled-room cap (§3); rank down new/single-occupant rooms in `GET /rooms`.
- ⬜ *(Optional, not required for capital safety)* a lightweight periodic `getProgramAccounts`-by-discriminator sweep to reconcile the registry against chain (catch stalled/abandoned rooms for lobby hygiene). Cron, not a stream.

> **Capital-safety note:** the registry being stale or missing a room cannot strand funds or
> corrupt settlement — every terminal path (`begin_live` seat enumeration, settle, all void/refund
> routes) reads authoritative state from chain. The registry only affects what the lobby shows.

---

## 3. Matchmaking — registry + start-trigger (player-created rooms)
Files: [services/matchmaking/src/formation.ts](services/matchmaking/src/formation.ts), [main.ts](services/matchmaking/src/main.ts), [deadline-worker.ts](services/matchmaking/src/deadline-worker.ts)

- ⬜ Remove the operator-create bootstrap (`bootstrapFormation` → `create-match`) and the `createRoom`/`joinQueue` create flows. Matchmaking no longer creates matches.
- ⬜ Add `POST /rooms` (host reports **create txhash**) and a join/deposit report endpoint (joiner reports **deposit txhash**) — each verifies via the §1a RPC helper at `finalized`, then writes the backend registry (§2). Reject non-allowlisted `config_hash`.
- ⬜ Serve `GET /rooms?feed=&template=&buyIn=` from the **backend registry** (§2); `join` returns match PDA + next free seat index for the client to sign a deposit.
- ⬜ Add per-wallet active-unfilled-room cap (anti-spam), enforced at create/join registration.
- 🟡 Fill-deadline worker exists (auto-start at max, host-start ≥min, auto-void at `fill_deadline_ts`) — keep; re-point at the registry, keep `triggerStartPolicy` → orchestrator.
- ⬜ Fix bug: `formation.ts:~395` references undefined `record` in `verifyDeposit()` (this is exactly the seam where RPC verification now plugs in).

---

## 4. Gateway — clock-sync + discovery
File: [services/gateway/src/relay.ts](services/gateway/src/relay.ts), [server.ts](services/gateway/src/server.ts)

- ⬜ Include `serverTime` in pong/envelopes; **remove the synthesized `Date.now()+25000`** deadline (`relay.ts:~178`).
- ⬜ Forward engine **absolute** deadlines: `sealEndsAt`, `bettingEndsAt`/`streetEndsAt`, `matchEndsAt`, `yourTurnDeadline`.
- ⬜ Add `roomsUpdated`/`lobbyList` push fed by the **matchmaking registry** (§2/§3) on verified create/deposit mutations (today lobby is pull-only); keep action-feed `/active-games` for spectating.

---

## 5. Client / frontend integration + protocol surface
Files: [docs/frontend/protocol.ts](docs/frontend/protocol.ts), [docs/frontend/INTEGRATION_GUIDE.md](docs/frontend/INTEGRATION_GUIDE.md)

- ⬜ `protocol.ts` still models a **Pyth** oracle adapter (`oracleAdapter:'pyth'`, `PythOracleProofView`) — replace with the signed-price view (token/price_in_wad/timestamp/v/r/s). Update `INTEGRATION_GUIDE.md`.
- ⬜ Client: build+sign atomic `create_and_deposit` (host) / `deposit` (joiner) from `GET /config/templates`; **explicit seal signature** during Sealing — tlock-encrypt the prediction to `timelock_target`, store ciphertext off-chain, sign `register_prediction_commitment` (one wallet popup, no session key); subscribe for clock-synced countdowns.
- ⬜ Confirm the off-chain ciphertext store the worker's timelock decrypt reads from is populated by the client seal path (end-to-end seal→decrypt).

---

## 6. Store schema — columns the backend registry/worker write
File: [services/store/migrations/](services/store/migrations), [src/postgres.rs](services/store/src/postgres.rs)

> Written **inline by the backend** at each transition it touches (matchmaking on verified
> create/deposit; orchestrator on `begin_live`; worker on settle/void) — §2. The settlement flow
> itself is complete without these; they back the registry + lobby read-models.

- ⬜ Add match columns: `live_start_ts`, `lock_ts`, `seal_deadline_ts`, `fill_deadline_ts`, `sealed_count`, `nonseal_penalty_bps`, `void_kind`, `room_status` (Filling/Sealing/Live/Settled/Void for the lobby) (+ seat-level `engine_seat`/`penalty`/seal commitment if read-models need them).
- ⬜ Config columns if surfaced to read models: `seal_window_sec`, `observation_windows_sec`, `total_betting_duration_sec`.

---

## 7. litesvm funds-exit × state matrix (pre-audit gate)
File: [services/programs/litesvm-tests/](services/programs/litesvm-tests)

- 🟡 Harness (`tests/common/mod.rs`) already drives current signatures (`lock` no-arg, current `CreateParams`, `declare_id` aligned). Good.
- ⬜ Build the `.so` (`cargo build-sbf --tools-version v1.53`) and **un-ignore** the two `#[ignore]` tests in `full_lifecycle.rs`.
- ⬜ Write the exhaustive matrix asserting **the vault drains to exactly zero** for every row:
  - Filling never reaches min by `fill_deadline_ts` → `void_before_start` → full refund.
  - Sealing `< min` sealed → `begin_live` → UnderMinSealed VOID → sealers refund + penalty-pool share; non-sealers `deposit − penalty`.
  - Stuck Sealing past grace → `void_before_start` → full refund.
  - Live → `submit_settlement` → `claim` (incl. leftover-stack payout + non-sealer `claim`).
  - Live, settlement never lands → `void_live_after_deadline` (Emergency) → full refund.
  - Emergency `void` during Live → full refund, penalties waived.
  - Settled `claim` idempotency (double-claim guarded).
- ⬜ Golden parity through the program `.so` (not just shared-core).
- ⬜ Multi-street fairness: assert auto-check only when `to_call==0`.

---

## 8. Cleanup (correctness-neutral, do before audit)

- ⬜ **settlement / worker**: remove dead Pyth scaffolding — `PythUpdateClient`, `fetch_and_post_first_valid_pyth_update`, `HermesHttpPythClient`, `MockPythClient` (worker uses only the signed-price `PythResolveClient` path). Optionally rename the `pyth`-named symbols/route (`resolve_pyth`, `/internal/pyth/resolve`) to `signed_price` to stop misleading future readers.
- ⬜ Reconcile the timelock grace constant: worker `timelock_open.rs` hardcodes 30s vs on-chain `SEAL_VOID_GRACE_SEC = 60` / `SETTLE_VOID_GRACE_SEC = 300` — make it derive from config so off-chain VOID never races the on-chain permissionless void.
- ⬜ settlement-chain: prune `pyth.ts`/`pythStack.ts` if the signed-price server fully replaces them (the `/internal/pyth/resolve` route now proxies the signed-price server).
- ⬜ Regenerate or mark-deprecated the stale canon docs (`04/05/06/08_*`) that still describe Switchboard/median-60s/session-keys so an auditor isn't misled.

---

## 9. Operational gates (pre-mainnet — out of code scope, list for completeness)

- ⬜ External security audit of program + settlement core; bug bounty.
- ⬜ Multisig / hardware custody for production role keys; key ceremony; mainnet program-key generation.
- ⬜ Verify role keys are distinct (`config_admin`/`settlement_admin`/`emergency_void_admin`/`price_signer`).
- ⬜ Treasury funding for sponsored settlement/claim gas.
- ⬜ Staging run of kill switches (pause flags).
- ⬜ Geofencing at the edge; rate/anomaly monitoring on operator actions; oracle/beacon health dashboards.
- ⬜ Per-feed `max_buy_in` below market-impact size (single-update oracle residual mitigation).

---

## Dependency order (build sequence)

1. **§1 critical path** (settlement-chain builders incl. RPC verify/enumerate helpers + orchestrator slim + IDL/deploy) — unblocks the entire live→settle lifecycle.
2. **§2 RPC verification + backend registry** — no separate service; the verify/enumerate helpers land in §1, the registry writes land in §3/§6.
3. **§3 matchmaking (registry from verified txhashes) + §4 gateway (push from registry + clock-sync)**.
4. **§5 client integration** — depends on §1 builders + §4 envelopes (client must report create/deposit txhashes per §2).
5. **§6 store columns** — alongside §3 (the backend writes them inline).
6. **§7 litesvm matrix** + **§8 cleanup** — pre-audit gate.
7. **§9 operational** — pre-mainnet.

**Deployment-ready for v1 = §1–§8 all ✅.** §9 is the mainnet gate after audit.
**Net effect of dropping the indexer:** one fewer service to build/operate; no streaming/reorg/checkpoint machinery; verification is on-demand at the handful of transitions the backend already drives.
