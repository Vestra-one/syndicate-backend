# Syndicate Backend — Adversarial Security Audit (Index)

**Date:** 2026-07-01 · **Engagement:** white-hat, attack-to-break the whole backend.
**Threat model:** the **company/operator is trusted** (admin role keys + the price signer are
honest). All findings target **malicious players / external actors** seeking economic harm to
other users or the vault, plus **honest-operator logic bugs** that move real money to the
wrong place. Operator-malice / admin-key-compromise vectors are out of scope by request.

## How to read this

Seven reports, one per concern. Each has its own summary, severity table, per-finding attack
scenario + fix, and a "verified controls" section (things I attacked that held).

| Report | Area | Criticals | Highs |
|--------|------|:---------:|:-----:|
| [01_ONCHAIN_CONTRACT.md](01_ONCHAIN_CONTRACT.md) | Solana/Anchor custody + settlement program | 0 | 0 |
| [02_SETTLEMENT_PAYOUTS.md](02_SETTLEMENT_PAYOUTS.md) | `shared::settle`, settlement, worker reconstruct | 1 | 2 |
| [03_CHAIN_VERIFICATION_REGISTRY.md](03_CHAIN_VERIFICATION_REGISTRY.md) | txhash verification, matchmaking registry | 0 | 3 |
| [04_MATCH_ENGINE_BETTING.md](04_MATCH_ENGINE_BETTING.md) | betting engine + service layer | 2 | 1 |
| [05_SIGNED_PRICE_SERVER.md](05_SIGNED_PRICE_SERVER.md) | secp256k1/EIP-191 price signer (Go) | 1 | 2 |
| [06_TIMELOCK_PREDICTIONS.md](06_TIMELOCK_PREDICTIONS.md) | drand timelock + commit/reveal | 1 | 3 |
| [07_GATEWAY_FEED_TRUSTSAFETY.md](07_GATEWAY_FEED_TRUSTSAFETY.md) | WS gateway, action-feed, trust-safety, store, config | 2 | 4 |

> Note: reports 04↔07 share two root causes (seat-ownership + dev-signature bypass), so the
> **distinct** Critical count across the system is **5**, not 7 (see below).

## The core structural weakness

v1 deliberately removed on-chain settlement re-derivation (`verify_settlement`). The chain now
enforces exactly two things: (1) the settlement price is signed by the trusted signer at the
exact match-end second, and (2) an **aggregate** conservation sum
(`Σ payouts + rake == sealed·buy_in + dead_money`). **Everything about *who wins how much* is
computed off-chain and trusted.** That concentrates the entire system's economic integrity
onto backend inputs that are, in several places, **attacker-influenceable or unauthenticated**.
Almost every serious finding below is a consequence of that concentration.

---

## The 5 distinct Critical issues (fix before any real funds)

### K1 — Wrong-wallet payouts: `engine_seat` emitted as `seat_index` (report 02 #1)
The backend emits per-seat payouts indexed by `engine_seat = PlayerId.0 = seat_index`, but the
**contract** assigns `engine_seat` as a *compaction of the sorted sealed seat indices*
(`lib.rs:465-472`). The two numberings **diverge the instant seat indices are non-contiguous**
— i.e. whenever any seat drops as a non-sealer, or seats are sparse/out-of-order. Winners and
losers are then **silently swapped**, and because the totals still sum correctly the on-chain
aggregate conservation check **passes**. Real users are paid each other's money with no error.
The `match-engine/CLAUDE.md` even *claims* the two indexings match — they don't. This is the
single most dangerous bug in the system: silent, on-path, and invisible to the only on-chain
guard. **Fix:** derive `engine_seat` exactly as the contract does and assert the
`engine_seat → wallet` mapping before submitting.

### K2 — No seat→wallet ownership check (reports 04 E-1, 07 #1)
The gateway/engine trust a client-supplied `(wallet, seat_index)`: signatures are verified for
the wallet the *attacker names*, never that the wallet **owns** the seat. A player with one
seat can **fold another player's hand**, jam a victim all-in, or pre-register a `CheckCallAny`
timeout policy that bleeds a victim's stack (report 04 E-3). **Fix:** the engine must own the
verified `seat_index → wallet` roster and reject any intent/policy/seal whose signer ≠ the seat
owner, independent of signature validity.

### K3 — `SYNDICATE_ALLOW_DEV_SIGNATURES` bypass in the release binary (reports 04 E-2, 07 #2)
A runtime env flag makes any signature starting with `sig-` skip verification entirely, in a
production build. Combined with K2, an unauthenticated attacker controls every seat in every
match. **Fix:** compile the bypass out of release artifacts (`#[cfg(debug_assertions)]` /
test-only feature); never read it from the environment in prod.

### K4 — Settlement price is a single-exchange, unguarded top-of-book mid (report 05 #1)
Each match settles on `(best_bid+best_ask)/2` from **one** exchange, with no cross-exchange
median, no deviation/outlier guard, no minimum book depth, and a permissive staleness window.
`scheduled_end_ts` is deterministic from on-chain params, so an attacker who nudges one thin
book around a known match-end second moves the signed settlement price — and thus who wins the
prediction bets — **without the operator doing anything wrong.** The contract blindly trusts
this price. **Fix:** aggregate ≥3 independent exchanges (median) + deviation + depth + spread
guards before signing.

### K5 — drand beacon BLS signature never verified (report 06 #1)
`timelock/beacon.rs` trusts whatever the drand HTTP endpoint (env-configurable, public default)
returns as the round key, without verifying the BLS signature against the chain public key.
Anyone who can MITM or stand up a rogue mirror can **forge or withhold round keys** — breaking
both prediction *hiding* (decrypt opponents' predictions early → copy/counter-bet) and
settlement *liveness*. **Fix:** verify the drand round signature against the pinned quicknet
public key before using it as a decryption key; pin the endpoint + chain hash.

---

## Cross-cutting themes

1. **Authorization is the weakest layer, everywhere.** Missing seat-ownership (K2), no auth on
   matchmaking report endpoints (03 #1/#2), any wallet can subscribe to any match and read its
   state (07 #6), unauthenticated profile writes (07 #3), unauthenticated price/feed WS
   (05 #8, 07 #9). The *cryptographic* pieces (ed25519 handshake, EIP-191 bytes) are correct;
   the **authz on top of them is absent or self-asserted.**

2. **Trusted inputs that attackers can actually influence.** The v1 "trust the backend" model
   is only as strong as the backend's *inputs* — and the settlement price (K4), the drand key
   (K5), and the revealed prediction value (06 #3, unchecked `i128` distance → overflow/DoS or
   rigged win) are all attacker-reachable.

3. **Identity/index mapping is fragile and under-verified.** K1 (engine_seat), the tie-remainder
   `seal_seq` derived as an array index (02 #5, 06 #6), and the optional-`seatIndex` registry
   divergence (03 #9) are all the same class: an off-by-mapping that survives conservation and
   pays the wrong person.

4. **Non-cryptographic hash used where binding matters.** `intent::simple_sha256` is FNV-1a, not
   collision/preimage resistant, yet backs the prediction commitment binding (06 #2). (The
   match-engine *event log* correctly uses SHA256 via `store::chain` — a different primitive.)

5. **Griefing / availability → forced voids.** Feed outage or DoS on the price server (05 #5),
   config-service request crash (07 #8), and a >300s settlement delay letting any participant
   force a no-contest full refund (01 C-6) all let an attacker repeatedly abort matches.

---

## Recommended remediation order

1. **K1** — correct `engine_seat` derivation + `engine_seat→wallet` parity assertion. (Silent
   fund misallocation; highest priority.)
2. **K3** then **K2** — kill the dev-signature bypass, then enforce seat-ownership in the engine.
3. **K4** — multi-exchange median + guards on the settlement price.
4. **K5** — verify the drand BLS signature; pin endpoint/chain-hash.
5. **Highs:** report 02 #2/#3 (re-verify per-seat payouts), 03 #1/#2/#3 (auth + PDA-binding +
   remove the `confirmed`-defaulting dead gate), 06 #3/#4 (range-check predictions; bind the
   recorded ciphertext to the on-chain commitment), 07 #3/#4/#5/#6 (endpoint auth, rate limits,
   trusted geofence, subscription authz).
6. **Defense-in-depth (v1+):** restore on-chain `verify_settlement` re-derivation (01 C-3) so
   the chain stops trusting a per-seat permutation it cannot currently detect — this alone
   collapses the blast radius of K1 and the entire report-02 class.
7. **Mediums/Lows:** per each report's table.

## Method & caveats

- Reports 01 and 04 were produced by direct source analysis (full read of the contract and the
  betting engine/service).
- Reports 02, 03, 05, 06, 07 were produced by specialized sub-audits over each service and are
  complete; a few items are marked **SUSPECTED** where a runtime behavior couldn't be confirmed
  from source alone (notably 03 #7 — whether `verifyDeposit` asserts the tx targeted *this*
  program/match instruction). Confirm those against a live devnet trace before closing them.
- This audit is source-review only; no exploits were executed against a running system.
