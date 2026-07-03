# 04 — Match-Engine & Betting Logic Security Findings

**Scope:** `services/engine-core/src/lib.rs` (pure betting state machine),
`services/match-engine/src/{service,server,coordinator,lease,verify,persistence}.rs`.

**Threat model:** company/operator trusted. Attackers are malicious **players / external
actors** trying to bet beyond their stack, act as/against another seat, corrupt pot
accounting, desync engine state, or force outcomes. Also honest-operator logic bugs. The
engine's per-seat result feeds settlement, which the chain trusts (v1 removed on-chain
replay), so a betting-logic or authorization bug = real money moved between real users.

## Summary

The **pure betting core (`engine-core`) is solid.** I attacked bet/raise/all-in validation,
underflow paths, turn order, street closing, side-pot eligibility and min-raise reopening
rules, and could not break the math: `commit()` clamps every payment to the player's stack,
`to_call` uses `saturating_sub`, an out-of-range actor index returns `NotYourTurn` before any
slice index (no panic), and the all-in short-raise "does not reopen betting" rule is correct.
The service wrapper (`FencedMatchRuntime`) adds a genuinely good integrity spine: a
SHA256 hash-chained event log (`store::chain`), `(seat_index, nonce)` replay dedup, a
`prev_head` chain that pins action ordering, Postgres lease fencing against split-brain, and
server-side `betting_open` enforcement so no bet lands during the price-observation window.

**The break is authorization, not arithmetic.** The engine treats the client-supplied
`(wallet, seat_index)` pair as self-asserting: signatures are verified *for the wallet the
attacker names*, but **nothing checks that the wallet actually owns that seat**. Because
actions, timeout **default policies**, and seal commitments all share this flaw, one player
can fold another player's hand, drain a victim's stack by pre-registering a
"call-any" timeout policy on their seat, or sabotage any seat in the match — all with valid
signatures from the attacker's own wallet. A compiled-in env flag
(`SYNDICATE_ALLOW_DEV_SIGNATURES`) removes even the signature check. These two are the same
root causes report 07 rates Critical; this report documents the **betting-specific economic
exploits** they unlock.

## Findings table

| # | Title | Severity | Status |
|---|-------|----------|--------|
| E-1 | No seat→wallet ownership check — fold/act/policy-set as any seat in the match | Critical | PROVEN |
| E-2 | `SYNDICATE_ALLOW_DEV_SIGNATURES` bypasses all intent/policy/commitment signatures in the release binary | Critical | PROVEN |
| E-3 | Attacker pre-registers a `CheckCallAny` timeout policy on a victim's seat (front-run, one-shot, irrevocable) | High | PROVEN (consequence of E-1) |
| E-4 | `InMemoryLeaseCoordinator` gives zero cross-process fencing — split-brain if used in multi-replica prod | Medium | PROVEN |
| E-5 | `apply_timeout_default` trusts a caller-supplied `deadline_ms`; `force_resolve_street` self-gates only on the caller | Low | PROVEN |
| E-6 | Replay re-applies events without re-verifying signatures — a poisoned append is permanent | Low | PROVEN (by design) |
| V | Verified controls (engine math, ordering, fencing, betting window, hash chain) | — | — |

---

## E-1 — No seat→wallet ownership check (Critical)

**Where:** `match-engine/src/service.rs:647-687` (`validate_intent`), `689-712`
(`validate_default_policy`), `verify.rs:44-102`, and `server.rs:403,432`
(`seat_index = input.seat_index.unwrap_or(0)`, `wallet = input.wallet` — both taken verbatim
from the client request).

The runtime never holds a verified `seat_index → wallet` roster. `validate_intent` checks:
`seat_index < seats.len()`, wallet/signature non-empty, `prev_head == head`, `(seat,nonce)`
unseen, then `verify::verify_action_intent(wallet, sig, …, seat_index, …)`. The ed25519
verification (`verify.rs:44-67`) signs a message that *contains* `seat_index` and the wallet
pubkey — but both are chosen by the signer. So an attacker signs, **with their own wallet**, a
message asserting "wallet = me, seat_index = *victim's seat*", and it verifies. The engine
then applies the action to the victim's seat.

**Concrete betting exploits (attacker holds one legitimate seat in the match):**
- **Forced fold.** When it is the victim's turn (`to_act == victim_seat`), the attacker
  submits `Action::Fold` for `seat_index = victim_seat`, signed by the attacker. `apply`
  folds the victim → the victim forfeits everything already contributed to the pot and their
  equity in the hand. Repeatable against every opponent → attacker wins uncontested.
- **Forced bad line.** The attacker submits `Call`/`AllIn`/`RaiseTo` on the victim's turn to
  push the victim's chips into a pot the attacker expects to win (e.g. jam the victim all-in),
  or `Check` to deny them a bet.
- **Action griefing / DoS of a seat.** Because `(seat_index, nonce)` is consumed on first
  use and `prev_head` must equal the current head, the attacker can also *burn* the victim's
  intended action slot at each head.

**Impact:** direct, attacker-chosen redistribution of other players' chips; the settlement
layer faithfully pays out the corrupted result. Critical.

**Fix:** the engine must own the authoritative `seat_index → wallet` map (from the verified
on-chain seat roster / matchmaking registry) and reject any intent, default policy, or seal
whose signing wallet ≠ the registered owner of `seat_index`, **independent of signature
validity**. Do not derive identity from the request body.

---

## E-2 — Dev-signature bypass in the production binary (Critical)

**Where:** `service.rs:896-907` (`allow_dev_signature`), called at the top of
`validate_intent` (669), `validate_default_policy` (696), `validate_prediction_commitment`
(721).

```rust
std::env::var("SYNDICATE_ALLOW_DEV_SIGNATURES")
    .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    .unwrap_or(false)
    && signature.starts_with("sig-")
```

Outside `#[cfg(test)]`, if the env var is set, **any** intent/policy/commitment whose
signature string starts with `sig-` skips verification entirely and returns `Ok(())`.
Combined with E-1 (client-chosen `seat_index`), this means: with the flag on, an
unauthenticated attacker submits `{"seatIndex": <any>, "wallet": "<any>", "signature":
"sig-x", "action": Fold/AllIn/…}` and controls every seat in every match.

**Impact:** total loss of action authenticity. This is a runtime env flag, not a build
feature, so a single misconfigured deployment (or an attacker who can set an env var) is
catastrophic. Critical.

**Fix:** gate the bypass behind `#[cfg(debug_assertions)]` / a test-only feature so it cannot
exist in a release artifact; never read it from the environment in production builds.

---

## E-3 — Front-run a `CheckCallAny` timeout policy onto a victim's seat (High)

**Where:** `service.rs:294-310` (`register_default_policy`) + `validate_default_policy`
(689-712); consumed by `apply_timeout_default` (325-358) and `force_resolve_street`
(444-477).

Default timeout policies suffer the same missing-ownership flaw as E-1, but with two extra
teeth: (a) registration is **first-write-wins and irrevocable** — `register_default_policy`
returns an error if a policy for that `seat_index` already exists (302-306); and (b) the
policy governs what happens whenever the seat times out.

**Attack:** early in the match, the attacker registers a `CheckCallAny` default policy for the
victim's `seat_index`, signed with the attacker's own wallet (passes `validate_default_policy`
because ownership isn't checked). Now:
- The victim can **never register their real (`CheckFold`) policy** — the slot is taken.
- Every time the victim's turn times out (they miss a turn, disconnect, or the street is
  force-resolved), the engine auto-**calls any bet** (`apply_timeout` →
  `DefaultAction::CheckCallAny` → `Action::Call`, `engine-core/src/lib.rs:167-181`), bleeding
  the victim's stack into pots regardless of their prediction.

**Impact:** an attacker can systematically drain a chosen opponent through their timeouts.
High (economic, targeted; slightly gated by the victim needing to time out).

**Fix:** same as E-1 (ownership binding). Additionally, consider allowing a seat's owner to
overwrite their own default policy up to the seal deadline, so a stale/hostile policy can't be
locked in by a race.

---

## E-4 — `InMemoryLeaseCoordinator` gives no cross-process fencing (Medium)

**Where:** `service.rs:72-156` (`InMemoryLeaseCoordinator`) vs. `lease.rs:8-69`
(`PostgresLeaseCoordinator`).

The lease/fencing design is correct *when backed by Postgres* — `ACQUIRE_MATCH_LEASE_SQL`
uses an `owner_fencing_token` and the SQL enforces single-holder semantics (verified in the
lease.rs test). But `InMemoryLeaseCoordinator` keeps leases in a per-process `HashMap`, so it
provides **no coordination across replicas**: two match-engine instances each running an
`InMemoryLeaseCoordinator` will both grant themselves the lease for the same `match_id`, run
divergent engines, and produce conflicting event logs / settlement inputs (split-brain).

**Impact:** if the in-memory coordinator is ever used in a multi-replica deployment, two nodes
can mutate the same match and disagree on the outcome → conservation/settlement chaos. Medium
(deployment-conditional; the Postgres path is safe).

**Fix:** ensure production wires `PostgresLeaseCoordinator` exclusively; restrict
`InMemoryLeaseCoordinator` to tests (feature-gate or move under `#[cfg(test)]`).

---

## E-5 — Timeout deadline is caller-supplied; `force_resolve_street` self-gates only on the caller (Low)

**Where:** `service.rs:332-335` (`apply_timeout_default` checks `now_ms >= deadline_ms` where
`deadline_ms` is a **parameter**), `service.rs:444-477` (`force_resolve_street` checks only the
lease, not the wall-clock street deadline).

`apply_timeout_default` validates `now_ms >= deadline_ms`, but `deadline_ms` is passed in by
the caller rather than derived from the match schedule inside the runtime — the runtime trusts
the caller to supply the true street/turn deadline. `force_resolve_street` performs **no**
wall-clock check at all; it force-times-out every pending actor as soon as it's called,
relying entirely on the server invoking it only after `current_street_close_ms`
(`server.rs:221` does compute that value). These paths are operator-internal (players cannot
call them directly), so the risk is a *server bug* prematurely timing players out, not a
player attack.

**Impact:** low (no external attacker surface), but it's a fragile trust boundary: a
mistake in the server's deadline computation silently mis-times real players' turns.

**Fix:** have the runtime derive the authoritative deadline from its own config +
`live_start_ms` and reject premature timeouts internally, so correctness doesn't depend on the
caller passing the right `deadline_ms` / calling `force_resolve_street` at the right moment.

---

## E-6 — Replay does not re-verify signatures (Low, by design)

**Where:** `service.rs:501-594` (`replay`).

`replay` re-checks sequence contiguity, `prev_hash`, and the event hash, and re-applies each
action to rebuild engine state — but it does **not** re-run ed25519 verification on the
`PlayerAction`/policy events. The event log is treated as authoritative once appended. This is
a reasonable design (verification happens at append time), but it means the append-time checks
are the *sole* gate: any event that slipped past verification (e.g. via the E-2 dev bypass, or
a future append-path bug) becomes permanently "valid" on every replay and every downstream
settlement reconstruction.

**Fix:** low priority given E-2 is fixed; optionally re-verify signatures during replay in a
"strict" mode used by the settlement reconstruction path for defense-in-depth.

---

## V — Verified controls (attacked, held)

1. **Bet/raise/all-in validation** (`engine-core/src/lib.rs:187-284`): cannot bet/raise beyond
   `committed + stack` (`InsufficientStack`); `BetTo` requires `current_bet==0`, `RaiseTo`
   requires `>current_bet` and a full increment unless all-in; min-bet (`< big_blind`) rejected
   unless all-in; a short all-in raise does **not** reopen betting (`full` flag gates
   `reset_acted_except` and `last_raise_size`) — matches No-Limit rules.
2. **No underflow / no panic:** `commit()` clamps `pay = amount.min(stack)` and decrements
   safely; `to_call` uses `saturating_sub`; `apply` returns `NotYourTurn` when `to_act != idx`
   *before* indexing `seats[idx]`, so an out-of-range or spoofed index can't panic the process.
3. **Chip conservation within a hand:** every `commit` moves chips stack→pot 1:1; folded and
   all-in players are excluded from `contender`/`street_closed` logic correctly; blinds posted
   exactly once in `new()`.
4. **Turn ordering & anti-replay:** `apply` enforces `to_act == idx`; `validate_intent`
   enforces `prev_head == head` (pins each action to the exact current state, preventing
   reorder/replay) and `(seat_index, nonce)` dedup.
5. **Event-log integrity:** SHA256 hash chain via `store::chain` (`store/src/lib.rs:67`, real
   `sha2::Sha256`), length-prefixed canonical encoding (`canonical_event_bytes`), and `replay`
   verifies seq contiguity + `prev_hash` + recomputed `hash`. (Note: this is the *sound* chain;
   the FNV `intent::simple_sha256` weakness flagged in report 06 is the *commitment* hash, a
   different primitive — the event log does not use it.)
6. **Split-brain protection (Postgres path):** `PostgresLeaseCoordinator` fences via
   `owner_fencing_token`; `assert_current` is checked at the start of every mutating method, so
   a stale-lease node's appends are rejected (`LeaseMismatch`) — see the
   `two_engine_instances_cannot_mutate_same_match` test.
7. **Betting-window enforcement:** `server.rs:448` rejects actions when
   `!betting_open(live_start_ms, now)`, so no bet can land during a street's observation gap or
   after the betting span — preserving end-of-match price uncertainty (plan_v2 §8/§12).
8. **Timeout safety:** `CheckFold` fallback resolves to a free `Check` when `to_call==0` and to
   `Fold` when facing a bet — it never auto-commits chips a player didn't act on, so pot
   eligibility is never granted without payment.
9. **Duplicate-guard:** duplicate `MatchStarted`, duplicate default policy, and duplicate
   intents are all rejected in both live and replay paths.
