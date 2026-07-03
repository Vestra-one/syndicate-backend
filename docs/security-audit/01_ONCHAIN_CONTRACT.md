# 01 — On-Chain Contract (Solana / Anchor) Security Findings

**Scope:** `services/programs/programs/syndicate_program/src/` — `lib.rs`, `state.rs`,
`signed_price.rs`, `settle_args.rs`, `action_handlers.rs`, `error.rs`.

**Threat model (per engagement):** the company/operator is **trusted** (all `*_admin`
role keys + the `price_signer` are honest). Findings here therefore target **malicious
players / external actors** and **honest-operator logic bugs** that could cause economic
harm, fund loss, or fund stranding. Operator-malice vectors are intentionally excluded.

## Summary

The custody + settlement program is, under the trusted-operator assumption, **economically
sound on its core invariant**: I traced full-vault conservation across every terminal path
(Settled, FillingVoid/Emergency, UnderMinSealed) and it balances exactly (worked examples
below). Per-match vault isolation, one-seat-per-player, claim/refund mutual-exclusion and
idempotency are all correctly enforced. No path was found that lets a player steal another
player's principal or drain a vault.

The real exposure is **defense-in-depth erosion from the v1 trust model**: the chain
enforces only a *single aggregate* conservation equation and the signed-price authenticity.
Everything about *who wins how much* is delegated to the backend with no on-chain
re-derivation (`verify_settlement` removed). The findings below are the on-chain-visible
consequences of that, plus two genuine missing input bounds at the permissionless
`create_match` boundary.

## Findings table

| # | Title | Severity |
|---|-------|----------|
| C-1 | `config_hash` is never validated on-chain — the "allowlist" invariant is not enforced where documented | Medium |
| C-2 | `entry_fee` has no upper bound in `validate_create_params` (every other economic field is bounded) | Medium |
| C-3 | Settlement distribution is fully backend-trusted; chain checks only the aggregate sum, not per-seat correctness | Medium (architectural) |
| C-4 | Prediction commitment binds a *ciphertext hash*, not the plaintext — zero on-chain plaintext binding | Low (see report 06) |
| C-5 | Multi-accounting / sybil seating is unrestricted at the contract layer | Low |
| C-6 | `void_live_after_deadline` lets any participant force a no-contest full refund once settlement is >300s late | Low |
| C-7 | No low-S / canonical enforcement on the secp256k1 settlement signature | Low |
| C-8 | Liveness dead-zone `(seal_deadline+begin_live_window, seal_deadline+60s]` where a match is neither startable nor voidable | Info |
| C-9 | `begin_live` pass-1 deserializes seats without an owner check (mitigated) | Info |
| V | Verified controls (conservation, vault isolation, idempotency, auth) | — |

---

## C-1 — `config_hash` is never validated on-chain (Medium)

**Where:** `lib.rs:835-878` (`validate_create_params`), `lib.rs:900` (`m.config_hash = params.config_hash`).

`CLAUDE.md` and the code comments state the invariant: *"`config_hash` in `CreateParams`
must match an entry in `config`'s allowlist. Prevents spam without requiring operator-gated
creates."* In the actual program, `config_hash` is **only stored** — `validate_create_params`
never compares it to anything, and there is no allowlist account in `CreateMatch` /
`CreateAndDeposit`. `grep` confirms the only on-chain uses are the struct field, the SPACE
constant, and the assignment.

Because `create_match` / `create_and_deposit` are **permissionless** (any signer), a player
can create a match with **any** `config_hash` and **any** economic parameters within the
loose numeric bounds (see C-2). The intended anti-spam / config-binding gate exists only in
the off-chain backend.

**Attacker scenario:** a player creates on-chain matches with arbitrary `config_hash`
values, or with a `config_hash` colliding with a real config but mismatched economics. The
chain accepts them. Nothing on-chain ties the recorded `config_hash` to the actual
`buy_in`/`rake_bps`/`entry_fee`/durations stored in the same account.

**Impact:** bounded but real. Rogue matches can't *steal* funds — the operator never settles
matches it doesn't recognise, so they eventually hit `void_before_start` /
`void_live_after_deadline` → full refund. But: (a) the documented capital-safety invariant is
**false** as written, which is dangerous if any future code path *assumes* on-chain
config-binding; (b) it enables on-chain spam / state bloat and griefing (luring a user into
depositing directly into a rogue match whose economics differ from what a UI shows); (c) it
removes a defense-in-depth layer that would otherwise catch a backend that mis-maps a match
to the wrong config.

**Fix:** either (a) pass a PDA-derived `Config`/allowlist account into `CreateMatch` and
`require!` that `config_hash` matches it and that the economic params hash to `config_hash`;
or (b) if config-binding is deliberately off-chain for v1, **delete the on-chain invariant
claims** from `CLAUDE.md`/comments so no future change relies on them, and ensure the backend
registry rejects unknown `config_hash` before any user is shown/joined to a match.

---

## C-2 — `entry_fee` has no upper bound (Medium)

**Where:** `lib.rs:835-878` (`validate_create_params`).

Every other economic parameter is bounded: `buy_in ∈ [buy_in_min, buy_in_max]`,
`rake_bps ≤ 10_000`, `rake_cap ≤ buy_in`, `nonseal_penalty_bps ≤ 10_000`, durations `> 0`,
`fill_window ∈ [min,max]`. **`entry_fee` is validated nowhere** — it is read straight into
`m.entry_fee` and charged as `buy_in + entry_fee` on every deposit (`lib.rs:222-224`,
`285-287`).

**Attacker scenario:** at the permissionless `create_match`, a creator sets a normal-looking
`buy_in` (to pass bounds) but an enormous `entry_fee`. Any player who joins via a path that
doesn't surface the exact on-chain `entry_fee` (a shared "join this match" deep link, a
malicious frontend, or a backend that trusts the creator's advertised fee) signs a transfer
of `buy_in + entry_fee`. On a **settled** match the entry fee is non-refundable — it flows
to `total_fees` → treasury and is never returned. On a void it *is* refunded, so the loss
only crystallises if the match completes.

**Impact:** overpayment / fee-gouging of joiners; inconsistent with the otherwise-careful
bounding of economics. Severity is gated by social engineering (the victim must be induced to
deposit into the attacker-parameterised match), hence Medium not High, but it is a genuine
missing invariant.

**Fix:** add `require!(params.entry_fee <= entry_fee_max, InvalidConfig);` with an
operator-governed bound in `ProtocolState` (mirroring `buy_in_min/max`), or bound it relative
to `buy_in` (e.g. `entry_fee ≤ buy_in`). At minimum, the backend must reject any match whose
on-chain `entry_fee` differs from the allowlisted config before exposing it to players.

---

## C-3 — Settlement distribution is fully backend-trusted (Medium, architectural)

**Where:** `lib.rs:547-645` (`submit_settlement`), crate header `lib.rs:6-15`.

v1 removed on-chain action-log replay / `verify_settlement`. The chain accepts
backend-supplied `payouts: Vec<SeatPayout>` and enforces **only**:

```
rake_collected ≤ sealed_count * buy_in
Σ payouts == sealed_count * buy_in + dead_money − rake_collected   (lib.rs:626-634)
```

This is an *aggregate* check. **Any distribution that sums to the same total passes**, even if
it pays the wrong seats. A backend bug (or a backend that is fed manipulated engine/oracle
state — see reports 02, 04, 05, 06) that, e.g., swaps two seats' payouts, gives the whole pot
to a colluder, or mis-ranks predictions, will be **accepted on-chain with no safety net**.
The only on-chain guarantee is "no money is created or destroyed within the sealed set."

**Why it still matters under a trusted operator:** the operator is honest, but the operator's
*inputs* (revealed predictions, engine results, the signed price) come from code and from
player-controlled data. The entire weight of correctness sits on the backend pipeline, so
**this report's siblings (02/04/05/06) are where the real money bugs will live.** This entry
exists to make explicit that the chain will not catch them.

**Fix (v1+):** restore `verify_settlement` re-derivation (already flagged `TODO(v1+)`), or at
minimum add per-seat sanity bounds on-chain (e.g. no single payout exceeds the total pot;
each seat's payout ≥ 0; non-sealer payouts can't be rewritten at settlement). Even a weak
on-chain bound shrinks the blast radius of a backend bug dramatically.

---

## C-4 — Commitment binds a ciphertext hash, not the plaintext (Low; cross-ref 06)

**Where:** `action_handlers.rs:19-63`, `state.rs:211-218`
(`prediction_commitment = hash of the time-lock ciphertext`).

The on-chain commitment is the hash of the timelock **ciphertext**, and the contract never
verifies that the ciphertext decrypts to the prediction used at settlement (v1 has no reveal
check). On-chain there is therefore **zero binding** between the committed value and the
prediction the backend scores. Whether a player can commit one thing and be scored on another
depends entirely on (a) the timelock scheme being plaintext-binding and (b) the backend
checking the decrypted plaintext against the commitment. Both are off-chain.

**Impact / fix:** see report **06 (Timelock & Predictions)** — this is the on-chain anchor for
that investigation. If the scheme is non-committing, this becomes High *there*. On-chain fix
(v1+): commit to `hash(plaintext_prediction || nonce || player)` separately from the
ciphertext, and verify the reveal against it.

---

## C-5 — Unrestricted multi-accounting / sybil seating (Low)

**Where:** `deposit` / `create_and_deposit` (`lib.rs:189-326`), seat PDA `[b"seat", match, player]`.

A single key can hold exactly one seat (the seat PDA is keyed by `player`, so a second
`deposit` `init`-fails — verified, good). But **nothing at the contract layer stops one
entity from seating multiple keys** in the same match (up to `max_players = 5`). In a
prediction-betting game this enables collusion: one actor controls several seats, makes
several independent price predictions (more chances to be "closest"), and can bet to shape
the pot in favour of one of their own seats. They pay `buy_in + entry_fee` per seat and the
pot is shared, so taking the *whole* table is -EV, but taking 2–3 of 5 seats can be +EV
against the remaining honest players.

**Impact:** unfair edge / collusion against honest players. Inherent to a permissionless
seating model; not fixable purely on-chain.

**Fix:** enforce identity/sybil controls in matchmaking + trust-safety (one verified
identity per seat, per-table dedupe of funding sources). See report 07.

---

## C-6 — `void_live_after_deadline` is a no-contest escape hatch when settlement is late (Low)

**Where:** `lib.rs:725-737` (`void_live_after_deadline`), permissionless.

Once `now ≥ scheduled_end_ts + SETTLE_VOID_GRACE_SEC (300s)`, **anyone** can void a LIVE
match → `VoidKind::Emergency` → **full refund to all, penalties waived** (`lib.rs:752-757`).
A participant who is *losing* the match prefers this outcome (gets their full stack + entry
fee back instead of losing the pot).

**Attacker scenario:** if settlement is ever delayed past 300s (RPC outage, oracle/feed gap,
operator hiccup), a losing player races a `void_live_after_deadline` to dodge their loss
before the operator finally settles. Whoever's transaction lands first wins the race.

**Impact:** low under a healthy operator (honest settlement lands within seconds, far inside
the 300s window, so the grace is never reachable by a player). It only becomes exploitable in
a degraded state — and in that same degraded state *everyone* is refunded their principal, so
no one loses capital; the only thing "stolen" is the winners' expected winnings (which were
never realised). Still worth noting as an operational invariant: **settlement must be timely;
a sustained >300s settlement delay turns every in-flight match into a player-triggerable
no-contest.**

**Fix:** keep the 300s backstop (it is correct for capital safety) but monitor/alert on
settlement latency; consider a slightly larger grace if 300s is tight for the worst-case
oracle/drand window, and ensure the operator's settle path is highly available.

---

## C-7 — No low-S / canonical enforcement on the settlement signature (Low)

**Where:** `signed_price.rs:133-153` (`recover_eth_address`).

`recover_eth_address` accepts any `(v, r, s)` that recovers to the trusted signer; it does
not reject high-S (non-canonical) signatures. ECDSA is malleable: for a valid `(r, s)`,
`(r, n−s)` with flipped parity is also valid for the same message. This **cannot forge a
different price** (the recovered address must still equal the trusted signer), so it is not
directly exploitable here. The concern is narrow: anything off-chain that deduplicates or
detects replay of a settlement by raw signature bytes can be fooled by a malleated-but-equal
signature. The contract itself stores `signed_price_hash` = the *message* hash
(`lib.rs:641`), which is malleability-independent, so on-chain replay tracking is fine.

**Fix:** enforce `s ≤ n/2` and a fixed `v` convention in `recover_eth_address` for hygiene;
ensure no off-chain component keys on raw signature bytes for replay detection.

---

## C-8 — Liveness dead-zone between begin_live window and void grace (Info)

**Where:** `begin_live` requires `now ≤ seal_deadline + begin_live_window_sec` (default 5s,
`lib.rs:383-390`); `void_before_start` (Sealing branch) requires
`now ≥ seal_deadline + SEAL_VOID_GRACE_SEC (60s)` (`lib.rs:704-710`).

In the interval `(seal_deadline + begin_live_window, seal_deadline + 60s]` a Sealing match
can be **neither started nor voided** — it is temporarily stuck. This is by design (the gap
covers drand/operator liveness) and only manifests if the operator misses its own
`begin_live` window. Funds are never at risk (a full-refund void is always reachable at +60s).
Documented for completeness; honest-operator-only.

---

## C-9 — `begin_live` pass-1 deserializes seats without an owner check (Info, mitigated)

**Where:** `lib.rs:406-429`.

Pass 1 reads each `remaining_account` via `SeatAccount::try_deserialize(&mut &data[..])`,
which does **not** verify the account is owned by the program. It *is* mitigated: (a) it
requires the account key to equal `find_program_address([b"seat", match_key, seat.player])`,
an off-curve PDA an attacker can't populate with arbitrary data; (b) pass 2 re-reads each via
`Account::try_from` which **does** enforce program ownership (`lib.rs:501`); and (c)
`begin_live` is operator-gated, so an attacker can't supply the account set at all. No action
required beyond awareness; for hygiene, use `Account`/`AccountLoader` in pass 1 too.

---

## V — Verified controls (no action needed)

These were actively attacked and held:

1. **Full-vault conservation — Settled path.** Vault in `= total_deposited + Σentry_fee`.
   Out = sealer claims `(sealed_count·buy_in + dead_money − rake)` + non-sealer claims
   `(nonsealer_deposited − dead_money)` + treasury `(Σentry_fee + rake)` =
   `total_deposited + Σentry_fee`. **Balances exactly.** (`lib.rs:586-644, 648-666, 799-829`.)
   Note `Σ non-sealer penalty == dead_money` because both use identical floor arithmetic
   (`lib.rs:447-455` vs `515-525`), so the two sides cancel with no dust.

2. **Conservation — UnderMinSealed void.** Non-sealers get `deposit − penalty`; sealers get
   `deposit + entry_fee + dead_money/sealed_count (+ remainder)`; treasury gets
   `forfeited_fees (+ dead_money if sealed_count==0)`. The integer-division remainder is paid
   to exactly one sealer via `gets_remainder` (`lib.rs:766-776`, `499`), so the penalty pool
   is distributed to the lamport with no leakage. Balances.

3. **Conservation — Filling/Emergency void.** Full refund `deposit + entry_fee` to all,
   fees waived. Trivially balances.

4. **Per-match vault isolation.** `transfer_from_vault` signs with `[b"match", match_id, bump]`
   and every fund-moving instruction binds `vault = match_account.vault` (`address =` or PDA
   seeds). Match A's PDA cannot move match B's vault. No cross-match drain.

5. **One seat per player.** Seat PDA keyed by `player` → second deposit `init`-fails. Seat
   index uniqueness via `SeatIndexAccount` PDA keyed by `seat_index`. No seat squatting with
   one key; no duplicate indices.

6. **Claim/refund mutual exclusion + idempotency.** A match is Settled XOR Void; `claim`
   gates on Settled, `refund` on Void; both gate `!seat.claimed` and `close = player`, so a
   seat pays out exactly once. `has_one = player` restricts to the owner.

7. **Settlement seat-set integrity.** `submit_settlement` requires `remaining_accounts.len()
   == sealed_count`, each `!is_non_sealer`, unique `engine_seat < sealed_count`, PDA-verified,
   and every `engine_seat` slot filled — so the wrong or a partial seat set is rejected.

8. **Arithmetic.** All economic adds/subs use `checked_*` → `Overflow`/`ConservationViolation`
   on under/overflow; `rake_collected ≤ sealer_deposited` pre-checked before the subtraction.

9. **Signed-price binding at settlement.** `validate_for_match` pins `feed_id == price_token`,
   `exponent == expected`, `confidence ≤ max`, and `publish_time == scheduled_end_ts` exactly
   — so a price for the wrong token/time/scale can't settle a match.
