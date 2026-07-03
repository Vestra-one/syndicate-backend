# 02 — Settlement & Payouts Security Audit

**Scope:** `services/shared/{settle,pots,intent,oracle,types}.rs`, `services/settlement/{lib,ops}.rs` + `ops/{pg_store,nats}.rs`, `services/worker/{reconstruct,relay,consumer,poller,main}.rs`, `services/store/*` (settlement-relevant). Cross-referenced against the on-chain conservation boundary in `services/programs/.../lib.rs::submit_settlement` and the wire-mapping in `services/settlement/src/ops.rs::net` + `services/settlement-chain/src/main.ts`.

**One-paragraph summary.** The pure settlement core (`shared/settle.rs`, `pots.rs`) is genuinely solid: integer-only, deterministic (BTreeMap/Vec, no floats/clock/RNG), conservation-asserted, with correct side-pot layering, tie handling, rake cap, and dead-money injection. I could not break the math inside `settle()` and several plausible attacks (folded-player eligibility, uncalled-bet returns, remainder dust, rake double-application) are handled correctly. **The real risk lives at the boundary where the deterministic result is translated into the on-chain `engine_seat`-indexed payout array.** The chain enforces only *aggregate* conservation (`Σpayout + rake == sealed_count·buy_in + dead_money`), so any per-seat *mis-distribution that still sums correctly passes unchecked and silently pays the wrong wallets*. The most serious finding is exactly such a case: the backend emits `engine_seat = PlayerId.0` (which is the *seat_index*), while the chain assigns `engine_seat` as a *compaction of sorted sealed seat_indices*. These two numberings diverge the moment seat_indices are non-contiguous (a dropped non-sealer, a sparse/late join, or any out-of-order seat assignment), at which point winners and losers are swapped while conservation still holds. Secondary findings concern parity fragility (off-chain recompute is not actually re-run against the wire `payouts`), a self-verify gap, and a couple of lower-severity robustness issues.

## Findings table (severity-sorted)

| # | Severity | Title | Location |
|---|----------|-------|----------|
| 1 | **Critical** | `engine_seat` emitted as `seat_index`, not the chain's compacted engine_seat — pays wrong wallets, passes conservation | `settlement/src/ops.rs:1181` |
| 2 | **High** | `compute_seat_payouts` / wire `payouts` are never re-verified by `settle()`/`verify_settlement` — the only on-chain check is aggregate-sum | `settlement/src/ops.rs:1160`, `lib.rs:85` |
| 3 | **High** | Conservation parity depends on `bundle.players` being *exactly* the sealed set; reconstruct enforces it but the wire encoder does not, and folded/leftover handling is fragile to a stale engine | `settlement/src/ops.rs:1160`, `worker/src/reconstruct.rs:417` |
| 4 | Medium | Off-chain settlement price scale (`-18` WAD) parity with the committed prediction is assumed, never asserted; a scale mismatch silently inverts "closest prediction" | `settlement-chain/src/main.ts:283`, `shared/settle.rs:185` |
| 5 | Medium | Tie-remainder tiebreak uses `seal_seq`, which the worker derives as the seat array index (`sealSeq = seatIndex`), not the on-chain arrival order — remainder can go to the wrong winner | `matchmaking/src/formation.ts:416`, `shared/settle.rs:214` |
| 6 | Low | `pot_rake` truncates per-pot; many tiny side pots leak rake to winners vs. a single-pot rake (economically minor, but non-obvious and griefable) | `shared/settle.rs:160` |
| 7 | Low | `reconcile_vault` drift is computed but never gates settlement; a known drift does not block payout | `settlement/src/ops.rs:713` |
| 8 | Info | `intent::simple_sha256` / `chain_hash` are non-cryptographic (FNV) — fine for v1 (commitment binding is re-checked by hash equality off-chain) but must not be relied on for collision resistance | `shared/intent.rs:93,117` |
| 9 | Info | `settle()` core verified correct — no bug in pot math, ties, fees, dead-money, returns | `shared/settle.rs`, `shared/pots.rs` |

---

## Finding 1 — CRITICAL: `engine_seat` is emitted as `seat_index`, diverging from the chain's compacted `engine_seat`

**Location:** `services/settlement/src/ops.rs:1160-1186` (`compute_seat_payouts`), specifically line 1181:
```rust
engine_seat: player.id.0 as u8,
```

**The two numbering systems.**

1. **Engine `PlayerId`.** Built in `match-engine/src/server.rs:623` and `matchmaking/src/formation.ts:413`:
   ```rust
   players: players.iter().map(|p| (PlayerId(p.seat_index), p.stack, p.seal_seq))
   ```
   so `PlayerId.0 == seat_index`. `to_player_states` (`engine-core/src/lib.rs:292`) copies `id: s.id` straight through, and `compute_seat_payouts` emits `engine_seat = player.id.0 = seat_index`.

2. **On-chain `engine_seat`.** Assigned in `programs/.../lib.rs:465-472` at `begin_live`:
   ```rust
   let engine_seat_of = |seat_index: u16| -> u8 {
       sealed_seat_indices.iter().position(|&s| s == seat_index)...
   };
   ```
   where `sealed_seat_indices` is the **sorted list of seat_indices that actually sealed** (`lib.rs:457`). So on-chain `engine_seat` is the *rank of this seat among the sealers*, contiguous `0..sealed_count`.

3. The chain looks up payout strictly by this compacted index (`lib.rs:594-599, 608, 618`):
   ```rust
   let idx = p.engine_seat as usize;        // from the wire payout
   payout_by_engine[idx] = Some(p.amount);
   ...
   let idx = seat.engine_seat as usize;      // from the seat PDA
   let payout = payout_by_engine[idx]...;    // matched by engine_seat, NOT by wallet
   ```

**These are equal only when the sealers' seat_indices are exactly `{0,1,...,sealed_count-1}`.** They diverge whenever seat_indices are non-contiguous over the sealer set — e.g.:

- A non-sealer is dropped at `begin_live`. Suppose seats `0,1,2` deposited; seat `1` failed to seal. On-chain `sealed_seat_indices = [0,2]`, so `engine_seat(0)=0`, `engine_seat(2)=1`. The worker's engine, however, is reconstructed from the match-engine event log, which `require_seals_for_all_seats` (`reconstruct.rs:417`) insists contains *only sealers* — but those sealers still carry `PlayerId = original seat_index` (0 and 2). `compute_seat_payouts` emits `engine_seat = 0` and `engine_seat = 2`. The chain rejects `engine_seat=2` (`idx < sealed_count=2` fails → `InvalidSeat`) — **best case a strand/void**. 
- Worse, when the divergence keeps both indices in range but *permuted*: seats `1,2,3` seal (seat `0` and `4` did not, or never existed densely). On-chain `sealed_seat_indices=[1,2,3]` → `engine_seat(1)=0, engine_seat(2)=1, engine_seat(3)=2`. Backend emits `engine_seat = 1,2,3`. After the in-range filter, `engine_seat=3` is rejected and `engine_seat=0` is missing → again strand/void. But if the off-chain engine was started with *re-densified* indices (`formation.ts:413` maps `table.seats` to `seatIndex = array_position`, i.e. `0,1,2`) **while the on-chain seat PDAs were created with the original sparse seat_indices**, then the backend emits `0,1,2`, all in range, all present — and the chain happily assigns *player A's winnings to player B's seat PDA*, because the seat→engine_seat map on-chain follows the sorted on-chain seat_index order, which is a different permutation than the off-chain array order.

**Why conservation does not catch it.** The chain's only economic check is `Σ payout == sealed_count·buy_in + dead_money − rake` (`lib.rs:626-634`). A permutation of the per-seat amounts leaves the sum invariant, so the check passes and the wrong wallets get paid. This is the precise "sums right, robs a user" class the threat model calls out.

**Attacker scenario.** A malicious player does not even need to act maliciously — *any* match whose sealer seat_indices are not `0..n−1` triggers it. But an attacker can deliberately engineer it: join a table, induce another seat to no-seal (or exploit any seat-allocation path that produces a sparse/out-of-order `seat_index`), so that the off-chain array order and on-chain sorted-seal order disagree, then collect a co-conspirator's pot — or simply grief by forcing a settlement that the chain rejects, stranding everyone's funds until an operator VOID.

**Economic impact.** Direct theft of pot winnings (mis-paid to the wrong seat PDA) when the permutation stays in range; fund stranding / forced VOID when it goes out of range. Either is a real loss with no on-chain safety net.

**Proven vs suspected.** *Proven* that `compute_seat_payouts` emits `seat_index` and that the chain expects the compacted `engine_seat` (both cited above). *Suspected* (could not fully verify end-to-end) whether the production deposit/join path guarantees dense, in-order seat_indices that always coincide with the off-chain array order. The whole safety of this Critical hinges on that invariant being *accidentally* true; nothing in the settlement code enforces or asserts it.

**Fix.** Make the backend compute `engine_seat` exactly as the chain does, and carry it explicitly rather than reusing `PlayerId`:
1. Persist the chain-assigned `engine_seat` per seat at `begin_live` (read it back from the seat PDAs via `getProgramAccounts`, which the v1 plan already does for the seat set), and key `compute_seat_payouts` off *that*, not `player.id.0`.
2. Alternatively, in `compute_seat_payouts`, derive `engine_seat` by ranking each player's `seat_index` within the sorted set of *sealer* seat_indices — identical to `engine_seat_of` on-chain — and assert the resulting set is exactly `0..sealed_count`.
3. Add a parity assertion before submit: rebuild the `(engine_seat → wallet)` map from the seat PDAs and confirm every payout's `engine_seat` maps to the intended `PlayerId`'s wallet. Fail to VOID on mismatch.

---

## Finding 2 — HIGH: the wire `payouts` array is never re-derived by `settle()`/`verify_settlement`

**Location:** `services/settlement/src/ops.rs:1160` (`compute_seat_payouts`) and `1250` (`payouts: compute_seat_payouts(...)`); `SettlementBundle::verify` at `services/settlement/src/lib.rs:85-94`.

**Issue.** `SettlementBundle::verify()` re-runs `verify_settlement(input, &self.result)` — i.e. it re-derives `pot_awards`, `uncalled_returns`, and `rake_collected` and checks they match `self.result`. That is good. **But the array that actually moves money on-chain is `payouts: Vec<SeatPayoutWire>`, produced by `compute_seat_payouts`, which is *not part of `SettleResult` and is never re-verified by `settle()`/`verify_settlement`.** It is computed once (`from_bundle`, line 1250) by a hand-rolled fold over `pot_awards + uncalled_returns + leftover`. Any bug in *that* fold (the `engine_seat` mislabeling of Finding 1, a `saturating_add`/`saturating_sub` swallowing an overflow at lines 1179/1183, a duplicate/missing player) is invisible to the self-verify path. The chain re-checks only the *sum*.

The `MockSubmitter`/`MockSolanaClient` "verify" (`ops.rs:765`, `lib.rs:261`) also calls `bundle.verify()` — which again does **not** look at `payouts`. So every test that asserts "the chain would accept it" is asserting the wrong thing for the seat-level distribution.

**Economic impact.** Removes the last off-chain guard against per-seat mis-distribution; combined with Finding 1, the system has *no* layer that checks the per-seat array against the canonical result — neither off-chain self-verify nor on-chain conservation.

**Proven.** `compute_seat_payouts` output is not threaded through `verify_settlement`; `verify()` only compares `self.result`.

**Fix.** Make `payouts` derivable from `SettleResult` by a single shared, tested function, and add a verification step that:
- reconstructs `payouts` from `result` + `players` + `buy_in`,
- asserts `Σ payouts == sealed_count·buy_in + dead_money − rake`,
- asserts each `engine_seat` is unique and in `0..sealed_count`,
- asserts the `engine_seat→wallet` mapping matches the on-chain seat set.
Gate submission on it (VOID on failure), and have the mocks exercise the real `payouts`.

---

## Finding 3 — HIGH: per-seat conservation parity is fragile to the exact player set and to `leftover`

**Location:** `services/settlement/src/ops.rs:1160-1186`; cross-ref `worker/src/reconstruct.rs:417` (`require_seals_for_all_seats`) and the chain check at `programs/.../lib.rs:626-634`.

**The arithmetic (verified correct *only* under a strict precondition).** The chain expects
`total_payout == sealed_count·buy_in + dead_money − rake`.
The backend produces `Σ_i (leftover_i + won_i)` where `leftover_i = buy_in − contribution_i` (line 1179) and `won_i` is this player's awards+returns. Since `settle()` guarantees `Σ won = Σ contribution + dead_money − rake`,
`Σ (leftover + won) = sealed_count·buy_in − Σ contribution + (Σ contribution + dead_money − rake) = sealed_count·buy_in + dead_money − rake`. ✓

**The precondition.** This identity holds **iff `bundle.players` is *exactly* the `sealed_count` sealers and every player's `contribution ≤ buy_in`.** Three ways it breaks:

1. **Wrong player set.** If `bundle.players` includes a non-sealer (or excludes a sealer), `Σ leftover` no longer equals `sealed_count·buy_in − Σ contribution_sealers`, and the chain check fails → strand/VOID. `reconstruct.rs` enforces the sealed set for the *worker* path via `require_seals_for_all_seats`, but `compute_seat_payouts` itself has no such guard, and nothing asserts `players.len() == sealed_count`. A future caller (or the `build_settlement`/replay seam at `lib.rs:208`) that constructs a bundle with a different player set produces a silently wrong `payouts`.
2. **`leftover` underflow masking.** `buy_in.saturating_sub(player.contribution)` (line 1179): if a player's recorded `contribution > buy_in` (engine/DB inconsistency, or a buy_in mismatch between the DB context and the engine stacks), the saturating sub yields `0` instead of erroring, the sum no longer matches, and the failure mode is a confusing conservation revert rather than a clear VOID.
3. **`won` overflow masking.** `saturating_add` at line 1183 hides an overflow that should be impossible but, if reached, would corrupt a single seat's amount while the chain sum check might still pass if another seat compensates.

**Economic impact.** Stranded funds / forced VOID in the benign cases; in the adversarial framing, any path that can perturb the recorded `contribution` or the player set relative to the on-chain `sealed_count`/`buy_in` becomes a griefing or mis-pay vector.

**Proven.** The identity and the `saturating_*` calls are as cited; the dependence on the exact sealed set is structural.

**Fix.** In `compute_seat_payouts`: assert `bundle.players.len() == sealed_count` (thread `sealed_count` in), use checked arithmetic and return an error (→ VOID) instead of `saturating_*`, and assert `contribution ≤ buy_in` per seat.

---

## Finding 4 — MEDIUM: settlement-price scale parity (`-18` WAD) vs. prediction scale is assumed, never asserted

**Location:** `services/settlement-chain/src/main.ts:283` (`exponent: -18`), `signed_price.rs:14` (`SIGNED_PRICE_EXPONENT = -18`), winner math at `shared/settle.rs:185` (`(pred - s).unsigned_abs()`).

**Issue.** Winner determination compares `|prediction − S|` as raw `i128` integers. This is only meaningful if `prediction` and `S` are at the **same fixed-point scale**. `S` is fixed at `-18` (WAD) both off-chain (`resolvePyth` hardcodes `exponent:-18`) and on-chain (`price_in_wad_to_i128`). The prediction, however, originates from the player's sealed commitment and is decrypted by the timelock; nothing in the settlement path asserts the decrypted `prediction` is expressed at `-18`. `oracle.rs::validate_oracle_update` checks the *oracle* exponent against config but never relates it to the prediction scale.

If the frontend ever commits a prediction at, say, `-8` (a natural Pyth-style scale) while settlement runs at `-18`, every distance is dominated by the scale gap and "closest prediction" becomes effectively random / always-the-largest-magnitude — silently mis-assigning every contested pot. The conservation check still passes.

**Economic impact.** Systematic mis-assignment of winners across all matches if a scale drift is ever introduced; undetectable by any current check.

**Proven that** the comparison is scale-naive and the price scale is hardcoded `-18`. **Suspected** (out of this scope's files) that the commitment is produced at `-18`; this is an unguarded cross-service contract.

**Fix.** Carry the prediction scale explicitly and assert `prediction_exponent == settlement_exponent` (or normalize both to a canonical scale) before the distance comparison in `winners_of`. Add a test that a scale mismatch VOIDs rather than mis-pays.

---

## Finding 5 — MEDIUM: tie-remainder tiebreak uses a `seal_seq` that the worker fabricates from array position

**Location:** `shared/settle.rs:204-225` (`award_split` sorts by `(seal_seq, id)`), source of `seal_seq`: `matchmaking/src/formation.ts:416` and `deadline-worker.ts:85` (`sealSeq: seatIndex`).

**Issue.** When winners tie, the indivisible remainder is awarded to the *earliest-sealed* winner (`award_split` orders by `seal_seq` then id, gives `rem` to index 0). The design intent (per `intent.rs:66` and plan_v2 §1) is that `seal_seq` reflects **on-chain arrival order of the seal**, precisely so "no player can claim an early seal to grab tie-remainders." But the off-chain match config sets `sealSeq = seatIndex` (the seat *array position*), **not** the on-chain seal arrival order. The chain, meanwhile, tracks the true earliest sealer via `earliest_seal_seq` / `gets_remainder` (`lib.rs:435-444, 499, 508`) using the recorded `r.seal_seq`.

So the off-chain remainder recipient (lowest seat_index among tied winners) can differ from the on-chain notion of earliest sealer. For a single-chip remainder this is economically tiny, but: (a) it is a *determinism/parity* gap — if `verify_settlement` were re-enabled on-chain in v1+, the recomputation would disagree; (b) a player who can choose a low seat_index gains a deterministic edge on every tie remainder, contrary to the stated anti-grief goal.

**Economic impact.** Sub-chip per tie today; a latent parity break for v1+ and a minor manipulable edge.

**Proven.** `sealSeq = seatIndex` in matchmaking; `award_split` orders by `seal_seq`.

**Fix.** Populate `seal_seq` from the actual seal arrival order recorded in the `PredictionSealed` events / on-chain seat `seal_seq`, not from the seat array index. Ensure the off-chain `seal_seq` is byte-identical to the value the chain used for `gets_remainder`.

---

## Finding 6 — LOW: per-pot rake truncation leaks value across many side pots

**Location:** `shared/settle.rs:104, 160-163` (`pot_rake` applied independently to each formed pot).

**Issue.** `pot_rake(amount) = min(bps·amount/10_000, cap).min(amount)`, computed *per pot layer*. With many side pots (all-ins at distinct levels), each layer rakes independently and each truncates `bps·amount/10_000` downward. Total rake over N small pots is `Σ floor(bps·a_i/10000)`, which is ≤ `floor(bps·Σa_i/10000)` — i.e. the protocol collects *less* rake than a single-pot computation, and the difference flows to winners. Also the `cap` is applied *per pot*, so a hand split into many side pots can pay total rake up to `N·cap` rather than `cap` — if the intent was a per-hand cap, this over-rakes; if per-pot, it is fine but non-obvious.

**Economic impact.** Minor and bounded; direction depends on intent. The per-pot `cap` interpretation is the more concerning of the two and is worth confirming.

**Proven** the per-pot application; **suspected** which cap semantics are intended (docs say "per-pot rake cap", so likely intentional — flagged for confirmation).

**Fix.** Confirm cap semantics in the config spec; if a per-hand cap is intended, accumulate rake and clamp once. Add a test pinning the multi-side-pot rake total.

---

## Finding 7 — LOW: vault reconciliation computes drift but never blocks settlement

**Location:** `settlement/src/ops.rs:713-729` (`reconcile_vault`), `690-711` (types). No call site gates `process()` on a `Drift` result.

**Issue.** `reconcile_vault` returns `ReconciliationStatus::Drift` when the vault balance ≠ expected liability, but `SettlementOpsWorker::process` (line 483) never consults it. A known drift (e.g. an unaccounted deposit/withdrawal, or a prior mis-pay) does not prevent a subsequent settlement from paying out against a corrupted vault.

**Economic impact.** Defense-in-depth gap; lets a pre-existing accounting error propagate into a payout.

**Fix.** Call `reconcile_vault` before submit and refuse to settle (VOID/alert) on `Drift`.

---

## Finding 8 — INFO: non-cryptographic hashing in `intent.rs`

**Location:** `shared/intent.rs:93-107` (`chain_hash`, FNV `DefaultHasher`), `117-141` (`simple_sha256`, FNV-1a expansion), `110-115` (`prediction_commitment_hash`).

**Issue.** The commitment and action-chain hashes are non-cryptographic FNV variants, not SHA-256, despite the name. For v1 the commitment binding is enforced by *equality* re-check off-chain (`settlement/src/lib.rs:147-150`) and the on-chain action-log replay is removed, so collision resistance is not currently load-bearing for fund safety. **But** a player who can find a `(prediction', blinding')` colliding with their committed hash could reveal a *different* prediction at settlement than they sealed — and FNV is trivially collidable. Today the prediction is also pinned by the timelock ciphertext, which limits exploitability, but this is a latent footgun if any path ever trusts the commitment alone.

**Fix.** Use a real SHA-256 (the file comment already concedes "production uses sha2 off-chain"). Make off-chain and on-chain use the identical real hash before any v1+ feature relies on commitment soundness.

---

## Finding 9 — INFO: the `settle()` core is correct (verified, no bug)

I specifically tried and failed to break the following in `shared/settle.rs` + `pots.rs`:

- **Side-pot construction** (`pots.rs:32-92`): distinct ascending levels, single-contributor layers correctly returned as uncalled bets, `height·count` per layer, conservation asserted. Correct.
- **Folded-player dead money** stays in the pot layers they reached (contributors include folded; eligible excludes folded — `pots.rs:63-67`). Correct.
- **Winner selection** (`settle.rs:174-200`): lone-eligible uncontested layer wins regardless of prediction; otherwise min `|pred − S|` with ties accumulated. Distance via `(pred - s).unsigned_abs()` on `i128` — no overflow (i128 abs of a difference of i128 prices fits in u128). Correct, *given* scale parity (Finding 4).
- **Tie split** (`award_split:204-225`): equal base, single remainder to the ordered-first winner. Deterministic. (Tiebreak *source* is Finding 5, but the split mechanic is correct.)
- **Rake** (`pot_rake:160-163`): `min(bps·amount/10000, cap, amount)` — cannot exceed pot, applied once per pot, not double-applied. Correct (per-pot semantics is Finding 6).
- **Dead-money injection** (`settle.rs:66-89`): added to the lowest pot (or a synthetic pot if none formed), raked and awarded with it; `checked_add` guards overflow. No double-count — it is added exactly once and the conservation `total_in` includes it exactly once (lines 117-122). Correct.
- **Degenerate no-eligible-winner** layer returns pro-rata to contributors (`distribute_pro_rata:229-242`) — capital-safe, never burns. Correct.
- **Determinism**: BTreeMap merges (`244-267`), `sort_unstable_by_key` on stable ids, no floats, no clock, no RNG, no HashMap iteration over money. Correct.
- **Conservation** re-asserted in u128 at the end (`settle.rs:117-131`). Correct.

The core is not where the money leaks. The leak is the translation layer (Findings 1-3).

---

## Cross-cutting recommendation

The on-chain contract deliberately trusts the backend for per-seat distribution and checks only the aggregate. That makes the `SettleResult → engine_seat-indexed payouts → seat PDA` mapping the single most security-critical code path in the system, yet it is the *least* tested and the *only* part not covered by `verify_settlement`. Before mainnet:
1. Fix Finding 1 (correct `engine_seat` derivation + explicit `engine_seat→wallet` parity assertion).
2. Thread the wire `payouts` through a shared, tested derivation and re-verify it (Finding 2/3).
3. Re-enable an on-chain re-derivation of the per-seat split (the `TODO(v1+)` `verify_settlement`) so the chain no longer trusts a permutation it cannot detect.
