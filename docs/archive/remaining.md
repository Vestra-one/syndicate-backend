# Syndicate backend — remaining tasks

Tracks everything still to do to finish the **plan_v2** implementation. Status as of 2026-06-29.
Source of truth = code + `plan_v2.md`. Canon docs (`04/05/06/0x_*`) are STALE.

Legend: ✅ done & verified · 🟡 partial · ⬜ not started · 🔴 blocker/gotcha

---

## 0. Done & verified (for context — do not redo)

- ✅ **Workstream B — settlement core** (`services/shared`): `dead_money` in `SettleInput`/`settle()`, generalized conservation, leftover handled at the program layer. 27 tests (incl. 100k property test with random dead_money). Threaded through worker/store (`matches.dead_money_chips`, migration `0001`).
- ✅ **Workstream A — on-chain program** (`services/programs`): permissionless `create_match`; seal commitment on `SeatAccount` during Sealing (player-signed, on-chain `seal_seq`); `lock(button_round)`; `begin_live` drop+penalty+engine re-index+drand button+timing; `submit_settlement` dead_money + leftover-stack return + generalized conservation + tight oracle + `oracle_update_key`; `void_before_start`; `void_kind` refunds; `withdraw_fees` forfeited-fee drain; `set_button_seed`/VRF removed. Builds to `.so` via `cargo build-sbf --tools-version v1.53`; host `cargo check -p syndicate-program` clean; litesvm `golden_parity` passes.
- ✅ **Workstream H — match-engine multi-street** (`services/match-engine`): `round_durations_sec[]`/`observation_windows_sec[]`/`time_bank_sec`; per-street wall-clock hard cap; observation-window action gate; `force_resolve_street` (auto-check when `to_call==0`, else default/safe-fold); persistence + config-hash bind. 14 tests.
- ✅ **Workstream D — config templates** (`services/config`): `observationWindowsSec[]`/`sealWindowSec`/`nonsealPenaltyBps`; tight oracle tolerance (max 2s); `totalBettingDurationSec()`; `timelockTargetRound()`; templates + allowlist + `GET /config/templates`. 14 tests.
- ✅ **settlement-chain serialization** (partial): `encodeCreateParams` (new 150-byte `CreateParams`) + `encodeSettleArgsFromBundle` (vrf_seed removed). 28 tests.
- ✅ **Toolchain blocker** resolved: `cargo build-sbf --tools-version v1.53` (default v1.48/Rust 1.84 is too old for edition2024 deps).

---

## 1. settlement-chain client — finish lifecycle builders  🟡
Files: [services/settlement-chain/src/custody.ts](services/settlement-chain/src/custody.ts), [src/main.ts](services/settlement-chain/src/main.ts), [src/matchAccount.ts](services/settlement-chain/src/matchAccount.ts)

- ⬜ `buildLockInstruction`: add `buttonRound: bigint`; append `u64(buttonRound)` to the ix data. Update `submitLock`/main.ts route to source the round (= `config.timelockButtonRound` or computed from the pinned beacon so it publishes just after `seal_deadline_ts`).
- ⬜ `buildBeginLiveInstruction`: append `button_randomness[32]` to data; add all seat PDAs as `remaining_accounts` (writable). Match on-chain `begin_live(BeginLiveArgs)`.
- ⬜ `submitBeginLive`: enumerate seat PDAs (`getProgramAccounts` memcmp on `SeatAccount.match_key`, offset 8) **or** accept the player wallet list and derive seat PDAs; fetch drand randomness for the committed `button_round` (League of Entropy quicknet) and pass it in.
- ⬜ Remove `buildSetButtonSeedInstruction`, `submitSetButtonSeed`, `SetButtonSeedInput`, and the `set_button_seed` route in main.ts.
- ⬜ Add `buildVoidBeforeStartInstruction` (permissionless; keys = match PDA only) + a submit/route.
- ⬜ `register_prediction_commitment` builder/route: new context (match + seat, no action_log / instructions sysvar); args `{ commitment[32], timelock_target u64 }`. (Usually the **client/player** signs this directly — see §6 — but keep an operator/test builder consistent.)
- 🔴 `matchAccount.ts` `MATCH_ACCOUNT_PLAYER_COUNT_OFFSET = 235` is **stale** after the `MatchAccount` reorder. It's only used by `set_button_seed`, so it dies with that removal — but audit for any other reader of `MatchAccount`/`SeatAccount` byte offsets and re-derive against the new [state.rs](services/programs/programs/syndicate_program/src/state.rs).
- ⬜ Acceptance: end-to-end `create_match → deposit → lock(button_round) → register_prediction_commitment → begin_live(drand+seats) → submit_settlement → claim` callable against a localnet/devnet deploy of the new program.

## 2. Fresh devnet deploy + program id  🟡
Files: [services/programs/programs/syndicate_program/src/lib.rs](services/programs/programs/syndicate_program/src/lib.rs) (`declare_id!`), [services/programs/Anchor.toml](services/programs/Anchor.toml)

- 🔴 `declare_id!` is the placeholder `Gwzr…`; the litesvm harness + devnet use `FR4tq…`. Align them (generate the real program keypair / key ceremony) — currently causes `DeclaredProgramIdMismatch` (error 4100) in litesvm.
- ⬜ Fresh `build-sbf --tools-version v1.53` + devnet deploy of the new layout (greenfield, no migration).
- ⬜ Commit the freshly built IDL (`target/idl/syndicate_program.json`) — the previously committed one was stale (missing `void_before_start`, still had `set_button_seed`).

## 3. Workstream C — indexer service (NEW)  ⬜
New `services/indexer/`.

- ⬜ Subscribe to the program (`accountSubscribe`/`logsSubscribe` or Geyser/Helius) for new `MatchAccount`/`SeatAccount`; idempotent upserts keyed by match PDA into Postgres + a Redis registry; slot-cursor checkpoint; `getProgramAccounts`-by-discriminator reconciler backstop; basic reorg tolerance.
- ⬜ **Allowlist gate**: project only matches whose `config_hash` is in `GET /config/templates`’s allowlist; ignore unknown configs.
- ⬜ **Anti-spam**: per-wallet active-unfilled-room cap; ranking that buries new/single-occupant/flagged-creator rooms.
- ⬜ Emit `roomCreated`/`roomUpdated`/`roomSettled` to gateway (Redis); track full lifecycle (Filling/seat/Sealing/Live/Settled/Void); write derived `scheduled_end_ts` to Postgres for the worker/timelock.
- ⬜ Read at confirmed/finalized commitment only (no acting on unconfirmed state).

## 4. Workstream E — matchmaking → registry + start-trigger  ⬜
Files: [services/matchmaking/src/formation.ts](services/matchmaking/src/formation.ts), [main.ts](services/matchmaking/src/main.ts), [deadline-worker.ts](services/matchmaking/src/deadline-worker.ts), [orchestrator-client.ts](services/matchmaking/src/orchestrator-client.ts)

- ⬜ Remove the operator-create bootstrap (`bootstrapFormation` → `create-match`). Matchmaking no longer creates matches.
- ⬜ Serve the indexer-fed open-rooms registry: `GET /rooms?feed=&template=&buyIn=`; `join` returns match PDA + next seat index for the client to sign a deposit.
- ⬜ Host-start trigger; fill-deadline worker (auto-start at max, host-start at `>=min`, auto-void at `fill_deadline_ts`).
- ⬜ Per-wallet active-room cap (anti-spam) consistent with the indexer.
- ⬜ Keep `triggerStartPolicy` → orchestrator.

## 5. Workstream F — gateway clock-sync + discovery  ⬜
Files: [services/gateway/src/relay.ts](services/gateway/src/relay.ts), [server.ts](services/gateway/src/server.ts)

- ⬜ Include `serverTime` in pong/envelopes; stop synthesizing `Date.now()+25000`; forward engine absolute deadlines (`sealEndsAt`, `streetEndsAt`/`bettingEndsAt`, `matchEndsAt`, `yourTurnDeadline`).
- ⬜ Add `roomsUpdated`/`lobbyList` push fed by indexer/matchmaking; keep action-feed `/active-games` for LIVE spectating.

## 6. Workstream G — orchestrator slim  ⬜
File: [services/match-orchestrator/src/main.rs](services/match-orchestrator/src/main.rs)

- ⬜ Remove `/internal/formations/bootstrap` create path. Keep `/internal/start-policy`.
- ⬜ New start-policy sequence: `lock(button_round)` → `begin_live(drand randomness + seats)` → match-engine `start`. **No** `set_button_seed` step.
- ⬜ Pass template timing + on-chain `live_start_ts` into the engine `start` body (the engine already accepts `roundDurationsSec`/`observationWindowsSec`/`liveStartTs`).

## 7. Workstream H (client side) + I — sealing, time-lock, drand, worker  ⬜
Files: [services/timelock/](services/timelock), [services/worker/src/](services/worker/src), client.

- ⬜ **Client**: build+sign atomic `[create_match, deposit]` using `GET /config/templates` params; join = single `deposit`; **explicit seal signature** during Sealing (`register_prediction_commitment`, one wallet popup, no session key); subscribe for clock-synced countdowns. Update [docs/frontend/INTEGRATION_GUIDE.md](docs/frontend/INTEGRATION_GUIDE.md) + [docs/frontend/protocol.ts](docs/frontend/protocol.ts).
- ⬜ **Time-lock**: client time-lock-encrypts the prediction to `timelock_target` (drand `tlock`), stores the ciphertext off-chain, records only the hash on-chain. Pin League of Entropy quicknet (genesis `1692803367`, period `3`).
- ⬜ **Drand button**: orchestrator commits `button_round` at `lock`; submits its randomness at `begin_live`; anyone re-verifies off-chain.
- ⬜ **Worker** (`services/worker`, `services/settlement`): batch-push the player-signed action log → `finalize_action_log` → `submit_settlement`; idempotent + resumable (mid-batch crash retries, not strands). Earliest-valid Pyth update inside the tight tolerance; binding-check each decrypted prediction; pass `dead_money` (already wired via `SettleParams`/`dead_money_chips`).
- ⬜ **Drand liveness**: ~60s grace → permissionless VOID + refund; implement + test the outage path.
- ⬜ `init_action_log` is called with the **sealer seats** as `remaining_accounts` (engine_seat-indexed); no `seal_seq[]` param anymore — confirm the worker/orchestrator build this correctly.

## 8. Task 9 — funds-exit × state test matrix (pre-audit gate)  ⬜
Files: [services/programs/litesvm-tests/](services/programs/litesvm-tests)

- 🔴 The harness `tests/common/mod.rs` (619 lines) drives the **old** instruction signatures — rewrite for: new `CreateParams`, `lock(button_round)`, `register_prediction_commitment` (seat, Sealing), `begin_live(BeginLiveArgs + seats)`, `init_action_log` (no `seal_seq[]`), `SettleArgs` (no `vrf_seed`).
- ⬜ Fix `declare_id!` ↔ harness load id (§2).
- ⬜ Write the exhaustive matrix asserting the **vault drains to exactly zero** under the generalized conservation for every row:
  - Filling never reaches min by `fill_deadline_ts` → `void_before_start` → full refund.
  - Sealing `< min` sealed by deadline → `begin_live` → UnderMinSealed VOID → sealers refund + penalty-pool share, non-sealers `deposit − penalty`.
  - Stuck Sealing past grace → `void_before_start` (FillingVoid) → full refund.
  - Live → `submit_settlement` → `claim` (incl. **leftover-stack** payout + non-sealer `claim`).
  - Live, settlement can't complete → `void_after_deadline` (Emergency) → full refund.
  - Settled `claim` idempotency (double-claim guarded).
  - Emergency `void` during Live → full refund, penalties waived.
- ⬜ Multi-street wall-clock fairness: assert auto-check only when `to_call==0` (no pot eligibility without payment); defaults + commitments exist before Sealing ends.
- ⬜ Golden parity through the program `.so` (not just shared-core).

## 9. Store / schema  🟡
Files: [services/store/migrations/](services/store/migrations), [services/store/src/postgres.rs](services/store/src/postgres.rs)

- ✅ `matches.dead_money_chips` added (migration 0001) + read in worker settlement context.
- ⬜ Add the rest of the new match columns the indexer projects: `live_start_ts`, `lock_ts`, `seal_deadline_ts`, `fill_deadline_ts`, `button_round`, `sealed_count`, `nonseal_penalty_bps`, `void_kind`, `oracle_update_key` (and seat-level seal commitment / engine_seat / penalty if the read models need them).
- ⬜ Config columns: `seal_window_sec`, `observation_windows_sec`, `total_betting_duration_sec`, tightened `oracle_delay_window_sec` check (≤ 2).

## 10. Operational gates (pre-mainnet, out of code scope)  ⬜
- ⬜ External security audit of program + settlement core; bug bounty.
- ⬜ Multisig / hardware custody for production role keys; key ceremony; mainnet program-key generation (replace `declare_id!` placeholder).
- ⬜ Separate role keys verified distinct (`config_admin`/`settlement_admin`/`emergency_void_admin`).
- ⬜ Treasury funding for sponsored settlement/claim gas.
- ⬜ Staging run of kill switches (pause flags).
- ⬜ Geofencing enforced at the edge; rate/anomaly monitoring on operator actions; oracle/beacon health dashboards.
- ⬜ Per-feed `max_buy_in` set below market-impact size (single-update oracle residual mitigation).

## 11. Docs reconciliation  ⬜
- ⬜ Canon docs (`04/05/06/08_*`) describe a different game (multi-street median-60s Switchboard, session keys, etc.). Regenerate from the build or mark deprecated so an auditor isn't misled. `plan_v2.md` + code are authoritative.
</content>
