# Syndicate v2 — Player-Created Rooms, Multi-Street Wall-Clock, Hardened Trust

> Supersedes `plan.md`. Incorporates the locked decisions from the architecture review.
> **Source of truth = the code.** The `04/05/06/0x_*` canon docs are STALE and must not be
> treated as authoritative; where this plan and those docs disagree, the code + this plan win.
> Any doc still describing multi-street rounds, Switchboard/median-60s oracle, or session-key
> seals is describing a game we are not building.

---

## 0. What changed vs `plan.md` (the review outcome)

The original plan was directionally right on the dangerous things (seal-before-Live hole, fake
operator VRF, permissionless creation, on-chain timing, permissionless void). The review **kept**
those and **changed** the following, which makes the system both simpler and more live:

| Area | Old plan | v2 (locked) |
|---|---|---|
| Betting | Multi-street, configurable `roundDurationsSec[]` | **Kept: multi-street, fully configurable** round count + per-round durations + observation windows. Each street is wall-clock bounded; on street-clock expiry, players who never got to act auto-**check** if facing no bet, else fall to their default / safe auto-fold (§12). |
| Oracle | First valid Pyth update in 1–3s window | Pyth single update, but **tight earliest-update tolerance** (≈ one Pyth interval) so there is effectively one valid price and the operator cannot select among in-window prints. |
| Action log | (Unaddressed liveness) | **Batch at settlement.** Gameplay runs off-chain at engine speed; operator pushes the player-signed log → finalize → settle after match end. Idempotent + resumable. |
| Seal UX | Pre-authorized session key auto-submits commitment | **Explicit player signature during Sealing.** No session keys, no delegation. Removes the key-theft surface entirely. |
| Button randomness | drand beacon "verified on-chain" | **drand commit-round:** commit `button_round` before seal close; submit its randomness at `begin_live`; derive button on-chain; re-verify off-chain. No on-chain BLS12-381. |
| Non-sealers | Drop + full refund | **Penalty:** % of buy-in (per-template) forfeited to the pot, entry fee forfeited to treasury. See §5. |
| Timing | Betting until `scheduled_end_ts` | **Observation tail:** betting closes a margin before `scheduled_end_ts`; price keeps moving to the settlement instant so the last bet is still made under uncertainty. |
| Anti-spam | Allowlist on `config_hash` only | Allowlist + **rent reclamation + per-wallet active-room cap + registry ranking + short fill deadline.** |

---

## 1. Core invariants (must hold before mainnet)

Real money; threat model = compromised/colluding operator + adversarial players. "Lose user
funds" and "let a player cheat for profit" are both unacceptable. Enforced **on-chain**; backend
does liveness/orchestration only.

### Capital safety
- Every capital-in state has a guaranteed capital-out path that does **not** depend on operator liveness (§6 matrix).
- **Generalized conservation** (replaces the single `paid == total_deposited` check at
  [lib.rs:418-421](services/programs/programs/syndicate_program/src/lib.rs)):
  `Σ vault_in == Σ sealer_payouts + Σ non_sealer_refunds + Σ sealer_void_refunds + total_fees`
  where `total_fees = entry_fees_collected + rake + forfeited_entry_fees`. Asserted on-chain on
  every terminal transition.
- Claims/refunds are pull-based and idempotent (guarded by `seat.claimed`).

### Seal integrity
- **Recorded-before-LIVE.** Each seat's time-lock ciphertext **hash** is recorded on-chain during
  **Sealing**, before `begin_live`. This is the §207 fix: today the commitment lives on the
  `ActionLog`, which only exists after Live ([action_handlers.rs:159-189](services/programs/programs/syndicate_program/src/action_handlers.rs);
  `init_action_log` requires `status == Live` at [lib.rs:768](services/programs/programs/syndicate_program/src/lib.rs)). Move it onto `SeatAccount`.
- **On-chain seal deadline.** `lock` records `lock_ts`; `seal_deadline_ts = lock_ts + seal_window_sec`.
  `register_prediction_commitment` is gated to `status == Sealing && Clock::now <= seal_deadline_ts`,
  and verifies the **seat owner's own ed25519 signature** (no delegate). `begin_live` requires
  `Clock::now >= seal_deadline_ts`.
- **Binding check at settlement.** Each decrypted prediction must equal the exact on-chain-recorded
  ciphertext for that seat (`prediction_commitment_hash`, [shared/src/intent.rs]), or funds are not
  released (VOID/escalate). This logic already exists in `submit_settlement`’s
  `player_states_from_engine` path — preserve it.

### Oracle integrity (Pyth single update, hardened)
- Settlement price = the Pyth `PriceUpdateV2` whose `publish_time` falls within
  `[scheduled_end_ts, scheduled_end_ts + oracle_tolerance_sec]`, with `oracle_tolerance_sec` set
  **tight (≈ one Pyth publish interval, e.g. ≤ 1s / a single slot)** so at most one valid update
  exists. Enforce `max_oracle_confidence` and exact feed/exponent match (already in `oracle.rs`).
- Record the chosen update key (`m.oracle_update_key`) for audit. VOID on no-valid-update / outage.
- Residual: even one print can be nudged; mitigated by per-feed `max_buy_in` below market-impact size.
  This is a deliberate, accepted trade for simplicity.

### Randomness integrity
- Dealer button from a drand beacon round **committed before it publishes** (`button_round` set at
  `lock`, randomness submitted at `begin_live`); `button = f(randomness) % sealed_count`, recorded
  on-chain, re-verifiable off-chain against drand’s public key. Replaces the unverified
  `set_button_seed` ([lib.rs:223-241](services/programs/programs/syndicate_program/src/lib.rs)).
  Note: under single-street + flat blinds the button only sets blind/action order — low stakes.

### Finality / reorg
- Seat only on a finalized deposit; indexer + settlement read at confirmed/finalized commitment.

---

## 2. Target lifecycle (single street)

```
Host: tx [create_match + deposit]            // permissionless; config_hash allowlisted; creator seated
  -> Filling                                  // indexer -> registry -> gateway browse feed
Joiners: tx deposit (join)                    // seat on finalized deposit
  // host-start at >=min OR auto at max OR auto-VOID at fill_deadline_ts (pre-lock, full refund)
Operator: lock                                // status Sealing; records lock_ts, seal_deadline_ts,
                                              //   and commits button_round (future drand round)
  -> Sealing  (server countdown)
Players: register_prediction_commitment       // own wallet sig; status==Sealing && now<=seal_deadline_ts
Operator: begin_live                           // now>=seal_deadline_ts
  // drop non-sealers: penalty=buy_in*penalty_bps -> dead_money; entry_fee -> forfeited; refundable=buy_in-penalty
  // if sealed_count < min_players -> VOID (penalty pool split among sealers; sealers full-refund)
  // else: derive button from drand randomness; stamp live_start_ts; scheduled_end_ts = now + total_betting_duration_sec
  -> Live  (N betting streets, wall-clock; N + per-street durations from the template)
     per-street deadline = live_start_ts + cumulative(round_durations_sec[0..k])
     turn timer within each street; on turn expiry -> registered default, else safe auto-check/auto-fold
     street hard cap: at the street deadline, force-resolve any pending actor —
       auto-check if to_call==0, else registered default, else safe auto-fold; then advance_street
     per-street observation window (no betting) after each street closes, before the next street
     the last street's observation window IS the final price-uncertainty tail before scheduled_end_ts
Worker: at scheduled_end_ts                    // earliest valid Pyth update in tight tolerance
  -> push batched player-signed action log -> finalize_action_log -> submit_settlement
     (binding-check each decrypted prediction; dead_money added to main pot; generalized conservation)
  -> Settled -> claim
Any stall (drand/oracle/operator) past settle_deadline_ts -> permissionless void_after_deadline -> refund
```

Example template (seal 20s; 3 streets betting [200,150,150] with per-street observation [20,20,40] — all configurable; total_betting_duration_sec = 500+80 = 580):
- `t=0` lock → Sealing; `seal_deadline_ts = +20`; `button_round` committed.
- `t=0..20` players seal (own sig).
- `t=20` begin_live: drop+penalize non-sealers; VOID if `<min` sealed; button derived; `live_start_ts=+20`, `scheduled_end_ts=+600`.
- `t=20..600` betting streets, each wall-clock hard-capped at its cumulative deadline; pending actors force-resolved (check/default/fold) at each street close; each street followed by its observation window, the last of which runs to `scheduled_end_ts`.
- `t>=600` earliest-valid Pyth print → settle → claim.

---

## 3. Workstream A — On-chain program
Files: [lib.rs](services/programs/programs/syndicate_program/src/lib.rs), [state.rs](services/programs/programs/syndicate_program/src/state.rs), [action_handlers.rs](services/programs/programs/syndicate_program/src/action_handlers.rs)

**Creation**
- Remove the `config_admin` gate on `create_match` ([lib.rs:95-99](services/programs/programs/syndicate_program/src/lib.rs)); any signer may create; keep `m.authority = signer` and all economic validation.
- Atomic `[create_match, deposit]`; if tx size/CU is tight, add a `create_and_deposit` instruction.

**`MatchAccount` new/changed fields** (bump `SPACE`, fresh devnet deploy — greenfield, no migration)
- `live_start_ts: u64`
- `total_betting_duration_sec: u64`  (bound at create = sum of all street durations + observation windows; the per-street split lives in the template/engine, not on-chain — chain only needs the total to derive `scheduled_end_ts`)
- `seal_window_sec: u64`
- `fill_deadline_ts: u64`
- `lock_ts: u64`, `seal_deadline_ts: u64`
- `button_round: u64`, `button_randomness: [u8;32]` (recorded at begin_live)
- `oracle_update_key: Pubkey`
- `oracle_tolerance_sec: u64` (replaces wide `oracle_delay_window_sec`; tight)
- `nonseal_penalty_bps: u32` (bound in config_hash)
- `dead_money: u64` (sum of non-sealer penalties; added to main pot at settlement)
- `sealed_count: u8` (set at begin_live)
- `forfeited_fees: u64` (non-sealer entry fees routed to treasury)
- Remove `scheduled_end_ts` from `CreateParams` (now derived at begin_live); keep it as a stored field set at begin_live.
- Remove `vrf_seed`/`vrf_proof_hash`/`set_button_seed` (replaced by drand commit-round).

**`SeatAccount` new fields** (for seal-before-Live + penalty refunds)
- `prediction_commitment: [u8;32]`, `timelock_target: u64`, `commitment_set: bool`, `seal_seq: u64`
- `is_non_sealer: bool`, `penalty: u64`  (set at begin_live)

**Instructions**
- `lock`: record `lock_ts`, derive `seal_deadline_ts`, commit `button_round` (operator-supplied future round, validated to publish after `seal_deadline_ts`); `Filling -> Sealing`; still requires `player_count >= min_players`.
- `register_prediction_commitment`: **move onto `MatchAccount`/`SeatAccount`** (not `ActionLog`); gate `status == Sealing && now <= seal_deadline_ts`; verify seat owner ed25519 sig; store commitment + `timelock_target` + `seal_seq` on the seat; set `commitment_set`.
- `begin_live`: require `now >= seal_deadline_ts`. For each seat without `commitment_set`: set `is_non_sealer`, `penalty = buy_in * nonseal_penalty_bps / 10_000`, add `penalty` to `m.dead_money`, add that seat's `entry_fee_paid` to `m.forfeited_fees`. Compute `sealed_count`. If `sealed_count < min_players` → `Void` (post-lock). Else: verify drand randomness for `button_round`, set `button`, stamp `live_start_ts`, set `scheduled_end_ts = now + total_betting_duration_sec`, `status -> Live`. Engine is initialized over the **sealed seats only**.
- `init_action_log` / `append_player_action` / `append_timeout_action` / `finalize_action_log`: unchanged in spirit; `round_count` = the template's configured street count (multi-street). Pushed in a **batch at settlement** by the operator (player intents are ed25519-signed and hash-chained, so the operator cannot fabricate). Make the batch **idempotent + resumable** (re-submitting an already-appended action is a no-op by nonce/head). Multi-street means a larger batch (players × streets) — still bounded; size the durability + retry path for it.
- `submit_settlement`: keep oracle + binding + replay; **add `dead_money` to the main (lowest) pot layer**; record `oracle_update_key`; **replace the conservation check** with the generalized invariant in §1. Tighten the oracle window to `oracle_tolerance_sec`.
- **New `void_before_start`** (permissionless): if `now >= fill_deadline_ts && status == Filling`, anyone may void → pre-lock full refunds (no penalty).
- `void_after_deadline` (permissionless, exists): extend to cover Sealing/Live stall past `settle_deadline_ts`.
- `refund`: branch on void kind:
  - pre-lock void (Filling): `buy_in + entry_fee` (no penalty).
  - post-lock void: sealer → `buy_in + entry_fee + dead_money_share` (share = `dead_money / sealed_count`, remainder to lowest `seal_seq` for determinism); non-sealer → `buy_in - penalty` (entry fee forfeited).
  - emergency `void` during Live: full refund `buy_in + entry_fee` for all (operator emergency; penalties waived).
- Rent reclamation: ensure terminal voids close match PDA + vault (+ seats close on refund/claim via `close = player`) so abandoned rooms cost nothing.

---

## 4. Workstream B — Settlement core extension (the crown jewel; extend, do not fork)
Files: [services/shared/src/settle.rs](services/shared/src/settle.rs), [pots.rs](services/shared/src/pots.rs)

- Add `dead_money: Chips` to `SettleInput`. In `settle()`, after `build_pots`, add `dead_money`
  to the **lowest pot layer’s amount** (the main pot — the layer the most non-folded players are
  eligible for) before rake + award. If there are zero pots (e.g., everyone folded to one — an
  uncontested single survivor), the survivor receives the dead money directly.
- Update the conservation assertion: `total_in = Σ contributions + dead_money`;
  `total_out = Σ awards + Σ uncalled_returns + rake`. Keep it a hard error (→ VOID), never best-effort.
- The on-chain `submit_settlement` already calls `verify_settlement` with the same crate, so the
  dead-money handling is verified identically off-chain and on-chain.
- Tests: extend the golden + property suites so **every random scenario including dead_money still
  conserves**, and add goldens for: dead money → single main pot; dead money with side pots
  (only main pot grows); dead money → uncontested survivor; dead money with a tie (remainder rule).

---

## 5. Non-sealer penalty — exact money flow

`penalty_i = buy_in * nonseal_penalty_bps / 10_000` for each seat that had the seal window open
(post-`lock`) but did not commit by `seal_deadline_ts`.

- **Match goes Live** (`sealed_count >= min_players`): `dead_money = Σ penalty_i` added to the main
  pot at settlement (awarded by best prediction). Non-sealer refund = `buy_in - penalty_i`; their
  `entry_fee` → treasury (`forfeited_fees`).
- **Post-lock VOID** (`sealed_count < min_players`): no game. Sealers get
  `buy_in + entry_fee + dead_money/sealed_count` (remainder to earliest `seal_seq`). Non-sealers get
  `buy_in - penalty_i`; entry fee forfeited. If `sealed_count == 0`, all penalties → treasury.
- **Pre-lock** (Filling void / leave before lock): full refund, **no penalty** (no seal window existed).
- **Emergency void during Live:** full refund all, penalties waived.

Conservation closes in every branch (worked through: `Σ in == Σ refunds + Σ payouts + total_fees`).

---

## 6. Funds-exit × state matrix (capital-safety proof — exhaustive test target)

| State reached | Trigger | Exit path | Who pays | Amount |
|---|---|---|---|---|
| Filling, never reaches min by `fill_deadline_ts` | permissionless `void_before_start` | refund | n/a (no operator) | buy_in + entry_fee, all |
| Sealing, `< min` sealed by deadline | `begin_live` → post-lock VOID | refund | n/a | sealers: buy_in+fee+penalty share; non-sealers: buy_in−penalty |
| Live started, sealed `>= min` | normal | settle → claim | sponsored tx | per-seat payout |
| Live, settlement can't complete by `settle_deadline_ts` | permissionless `void_after_deadline` | refund | n/a | buy_in+fee, all (penalties? — treat as emergency: full refund) |
| Settled | — | claim (idempotent) | sponsored tx | payout, once |
| Emergency (operator) | `void` | refund | n/a | buy_in+fee, all |

Build an automated state×exit harness (litesvm) that drives **every row** and asserts vault drains
to exactly zero with the generalized conservation invariant. This is the gate before audit.

---

## 7. Workstream C — Indexer (new service)
- Subscribe via `accountSubscribe`/`logsSubscribe` (or Geyser/Helius) for new `MatchAccount`/`SeatAccount`.
- Idempotent upserts keyed by match PDA into Postgres + Redis registry; slot cursor checkpoint;
  `getProgramAccounts`-by-discriminator reconciler as backstop; reorg tolerance.
- **Allowlist** + **anti-spam:** only project matches whose `config_hash` is in the published
  template set; additionally rank/suppress per the §9 anti-spam policy.
- Emit `roomCreated`/`roomUpdated`/`roomSettled` to gateway for the live browse feed; track full
  lifecycle so read models never drift from chain. Writes `scheduled_end_ts` (derived at begin_live)
  to Postgres so the worker/timelock read real values.

## 8. Workstream D — Config → multi-street templates
Files: [services/config/src/index.ts](services/config/src/index.ts), [table-terms.ts](services/config/src/table-terms.ts)
- Keep `roundCount` + `roundDurationsSec[]` (require `roundDurationsSec.length === roundCount`, 1..N);
  add `observationWindowsSec[]` — **a per-street observation window** (no-betting beat after each
  street closes), one per street (`observationWindowsSec.length === roundCount`). Bind ALL of these
  into `config_hash`. `total_betting_duration_sec = Σ roundDurationsSec + Σ observationWindowsSec`.
  The last street's observation window doubles as the final price-uncertainty tail before `scheduled_end_ts`.
- Add `sealWindowSec`, `nonsealPenaltyBps`, `oracleToleranceSec`, `actionTimerSec`, `timeBankSec`.
- Support multiple coexisting templates (e.g. 2-min/1-street, 10-min/3-street).
- `bindConfig`/`canonicalize` must hash ALL new fields. Expose `GET /config/templates` and a
  `config_hash -> template` map for the indexer allowlist and client tx-building.
- Derive `timelockTargetRound` from `live_start_ts + total_betting_duration_sec + margin` (never the `1_000_000` placeholder).

## 9. Workstream E — Matchmaking → registry + anti-spam
Files: [formation.ts](services/matchmaking/src/formation.ts), [main.ts](services/matchmaking/src/main.ts), [deadline-worker.ts](services/matchmaking/src/deadline-worker.ts), [orchestrator-client.ts](services/matchmaking/src/orchestrator-client.ts)
- Remove operator-create bootstrap; matchmaking no longer creates matches.
- Serve indexer-fed open-rooms registry: `GET /rooms?feed=&template=&buyIn=`; `join` returns match PDA + next seat index for the client to sign a deposit.
- Host-start trigger; fill-deadline worker (auto-start at max, host-start at `>=min`, auto-void at `fill_deadline_ts`).
- **Anti-spam:** per-wallet active-unfilled-room cap; ranking that buries new/single-occupant/flagged-creator rooms; short fill deadlines. Keep `triggerStartPolicy` → orchestrator.

## 10. Workstream F — Gateway clock-sync + discovery
Files: [relay.ts](services/gateway/src/relay.ts), [server.ts](services/gateway/src/server.ts)
- Clock sync: include `serverTime` in pong/envelopes; stop synthesizing `Date.now()+25000` ([relay.ts:172-179]); forward engine absolute deadlines (`sealEndsAt`, `bettingEndsAt`, `matchEndsAt`, `yourTurnDeadline`).
- Discovery: `roomsUpdated`/`lobbyList` push fed by indexer/matchmaking; keep action-feed `/active-games` for LIVE spectating.

## 11. Workstream G — Orchestrator slim
File: [main.rs](services/match-orchestrator/src/main.rs)
- Remove `/internal/formations/bootstrap`. Keep `/internal/start-policy` (lock → begin_live → engine-start) and void. Pass template timing + `live_start_ts` into the engine `start` body. (No `set_button_seed` step — button is derived inside `begin_live`.)

## 12. Workstream H — Match-engine multi-street wall-clock
Files: [server.rs](services/match-engine/src/server.rs), [service.rs](services/match-engine/src/service.rs), [engine-core/src/lib.rs](services/engine-core/src/lib.rs)
- `engine-core`: keep `round_count`/`advance_street`; after the last street closes → `Phase::Settlement`. The existing default/timeout path (`default_action`/`apply_timeout`) already encodes the conservation-safe resolution — reuse it; do not add a path that lets a player stay eligible for a pot they didn't match.
- `MatchConfig`: `live_start_ts`, `seal_window_sec`, `round_durations_sec: Vec<u64>`, `observation_windows_sec: Vec<u64>` (one per street), `action_timeout_ms`, `time_bank_sec` (no hardcoded 25s default path).
- Wall-clock driver in `timeout_loop` ([server.rs:183-229]): per-street deadline = `live_start_ts + cumulative(round_durations_sec)`. Within a street, turn-based with `action_timeout_ms` (+ time bank). **On street-clock expiry, force-resolve every still-pending actor**, in turn order, by: `to_call == 0` → auto-**check**; else registered default (check/fold → fold, check/call-any → call); else safe auto-fold. Then run the street's observation window and `advance_street`. At `scheduled_end_ts` → `complete_match` → settlement enqueue ([coordinator.rs](services/match-engine/src/coordinator.rs)).
- **Money-safety rule (the "auto-check" semantics):** a player who never got to act keeps a *free* seat in the pot ONLY when there is no bet to match (`to_call == 0`). Facing an unmatched bet, "check" is illegal and would corrupt side-pot eligibility — so it degrades to the registered default / safe fold. Auto-actions are recorded as engine-authored timeout events in the log (`append_timeout_action`) so replay and on-chain verification stay faithful.
- **Durability:** the player-signed intents + engine-authored timeout events collected during Live are the only proof used to rebuild the on-chain log at settlement — persist them durably; lose them → match can only VOID.

## 13. Workstream I — Sealing, time-lock, randomness (no session keys)
Files: [services/timelock/](services/timelock), [coordinator.rs](services/match-engine/src/coordinator.rs), client.
- **Seal:** player enters their number during Sealing, time-lock-encrypts it to `timelock_target` (drand `tlock`), submits ciphertext to timelock store, and signs `register_prediction_commitment` (own wallet, one popup) recording the ciphertext hash on-chain. No session key / delegate.
- **Button:** drand commit-round (§1). Commit `button_round` at `lock`; submit randomness at `begin_live`; derive on-chain; re-verify off-chain.
- **Decrypt + binding at settlement:** after the match-end round publishes, timelock decrypts all ciphertexts; worker passes decrypted predictions to `submit_settlement`, which binding-checks each against the on-chain commitment.
- **drand liveness:** if the key/round is unavailable past the configurable grace (~60s), permissionless `void_after_deadline` → full refund. Implement + test the outage path. Pin League of Entropy.

---

## 14. Build order
1. **Workstream D (templates)** + **A (program: seal-during-Sealing, drand commit-round, tight oracle, penalty, generalized conservation, void coverage)** + **B (settlement core dead-money extension + tests)** — everything binds to these.
2. Fresh devnet deploy; regenerate IDL/client for settlement-chain.
3. **C (indexer)** — chain → registry projection.
4. **E + F (matchmaking registry + anti-spam, gateway discovery/clock)** + **G (orchestrator slim)**.
5. **H (engine multi-street wall-clock + per-street force-resolution + observation windows + intent durability)**.
6. Client integration + settlement wiring.
7. **§6 funds-exit × state matrix** on litesvm + devnet; then external security audit before mainnet.

## 15. Open risks to validate during build
- Indexer latency/reorgs on devnet → reconciler + checkpoint.
- Atomic `[create_match, deposit]` tx size/CU with token + (no Pyth at create) accounts; fall back to `create_and_deposit` if needed.
- begin_live seat-drop consistency: dropped seats must keep `submit_settlement`’s
  `remaining_accounts.len() == sealed_count` and the seat_index→PlayerId mapping coherent for the
  engine initialized over sealed seats only. Cover in the matrix.
- Single-update oracle residual: monitor that the chosen update is the unique in-tolerance print; keep `max_buy_in` per-feed below market-impact.
- drand is now a dependency for BOTH button and decrypt: the ~60s-grace → VOID path must be implemented and tested; beacon pinned.
- Batch-at-settlement: a mid-batch operator crash must resume, not strand the payout; permissionless void is the backstop. Multi-street → larger batch; verify tx-count/CU budget for the worst-case (max players × max streets × raises).
- Multi-street wall-clock fairness: a street can hard-close mid-circle. Ensure (a) the auto-check-only-when-`to_call==0` rule holds so pot eligibility is never granted without payment, and (b) registered defaults + commitments exist before Sealing ends so street-expiry resolution and the binding check are always possible. Cover both in the test matrix.
