# Contract Review — Does the on-chain program verify user-signed intents?

> Scope: the single Anchor program in `services/programs` (`syndicate_program`). This review
> is derived **directly from the source code**, not from any prose docs. Code citations use
> `file:line`.

---

## TL;DR — the direct answer

**No. The on-chain contract does NOT verify that the gameplay "intents"/actions were signed by
the users.**

During settlement the program trusts the off-chain **`settlement_admin`** to hand it the
players' game inputs (each player's contribution, fold flag, prediction, seal sequence). The
program then re-computes the payout *from those inputs* and checks the math and money
conservation — but it never checks an ed25519 signature, a signed-intent merkle root, or any
other cryptographic proof that those inputs are the actions the players actually authorized.

What the contract **does** authenticate:

1. **Who is in the match** — every seat is created by a transaction the player themselves
   signed (`deposit`), and settlement must reference exactly those seat PDAs.
2. **The oracle price** — the company-signed price from `signed-price-server` must pass
   secp256k1/EIP-191 signature recovery against `ProtocolState.price_signer` (a trusted 20-byte
   Ethereum address). See `services/programs/src/signed_price.rs`.
3. **The settlement arithmetic** — recomputed by the shared deterministic core and checked for
   conservation.
4. **Authorization to submit** — only the `settlement_admin` key may call `submit_settlement`.

What the contract **does NOT** authenticate:

- The **authenticity / integrity of the player actions** (bets, folds, predictions,
  contributions) that decide who wins. These are supplied verbatim by `settlement_admin`. This
  is the trust gap described in detail below.

> Net effect: the program is a faithful, capital-safe **calculator + custodian**, but it is
> **garbage-in / garbage-out** with respect to gameplay. A compromised or buggy
> `settlement_admin` can submit internally-consistent but fraudulent inputs and the chain will
> compute and pay out a "valid" result.

---

## 1. High-level model

The program is the **source of truth for funds** and the last line of capital safety. It
implements:

- **Custody** — each match owns a vault token-account PDA; deposits go in, claims/refunds come
  out, all moved by the program (PDA signer), never by an admin directly.
- **A status state machine** — `Filling → (Sealing) → Live → Settled`, or `→ Void`
  (`services/programs/src/state.rs:26`).
- **Settlement *verification*, not computation** — the off-chain builder computes the result;
  the program **re-derives** it with the *same* deterministic crate (`syndicate-shared`) and
  only writes payouts if the re-derivation matches and money is conserved
  (`services/programs/src/lib.rs:196`–`330`).
- **Pull-based payouts** — settlement writes a `payout` into each seat; players later `claim`
  (or `refund` on void) by signing for their own seat.

```mermaid
flowchart LR
    P["Player (signs)"] -->|deposit buy-in + fee| V[("Match vault PDA")]
    A["settlement_admin (signs)"] -->|submit_settlement(SettleArgs)| PR["syndicate_program"]
    SP["signed-price-server (secp256k1/EIP-191)"] -->|company-signed price| PR
    PR -->|re-verify via shared core + conservation| PR
    PR -->|write per-seat payout| S["SeatAccount.payout"]
    P -->|claim / refund (signs)| V
    classDef trust fill:#fde68a,stroke:#b45309,color:#000;
    class PR trust;
```

The key observation: the **arrow carrying the gameplay actions is `SettleArgs` from
`settlement_admin`** — there is no player signature attached to it.

---

## 2. Where user signatures *do* exist

Solana requires the fee-payer/authority of every instruction to sign it, so these are
genuinely authenticated by the runtime:

| Action | Who must sign | Code |
| --- | --- | --- |
| `deposit` (join a seat, move buy-in + entry fee) | the **player** | `player: Signer<'info>` — `lib.rs:507` |
| `claim` (pull settled payout) | the **player** (`has_one = player`) | `lib.rs:552`–`560` |
| `refund` (on void) | the **player** | shares `Claim` accounts — `lib.rs:374`, `552` |
| `create_match` | `config_admin` | `lib.rs:81`–`86` |
| `lock` | `settlement_admin` or `config_admin` | `lib.rs:180`–`185` |
| `submit_settlement` | `settlement_admin` | `lib.rs:204`–`208` |
| `void` | `emergency_void_admin` | `lib.rs:355`–`359` |
| `initialize_protocol` / `set_pauses` | respective admin role | `lib.rs:40`, `69` |

So the program authenticates **deposit/claim/refund identity** and **admin authority**. The
seat PDA is derived from `[b"seat", match, player]` (`lib.rs:515`), so a `SeatAccount` is
cryptographic proof that *that specific wallet* deposited into *that match*.

But none of these signatures cover the **in-game actions** (what each player bet, whether they
folded, what price they predicted). Those never appear in any player-signed transaction
on-chain — they happen off-chain and arrive only inside `SettleArgs`.

---

## 3. Low-level: exactly what `submit_settlement` checks

`submit_settlement` (`services/programs/src/lib.rs:199`–`330`) is the only place gameplay
outcomes enter the chain. Step by step:

1. **Authorization** — `require_keys_eq!(authority == protocol_state.settlement_admin)`
   and `require!(!pause_settlement)` (`lib.rs:204`–`209`). *Only the admin, no player.*

2. **Match status** — must be `Live` (`lib.rs:212`).

3. **Seat-set integrity** — the seats passed as `remaining_accounts` must:
   - number exactly `player_count` (`lib.rs:213`–`216`),
   - each belong to this match (`seat.match_key == m.key()`),
   - have a valid, non-duplicated `seat_index`,
   - and **re-derive to the canonical seat PDA**
     `find_program_address([b"seat", match, seat.player], program_id)` (`lib.rs:218`–`234`).

   This guarantees the result is being applied to the *real depositors* and no fake seats are
   injected. ✅ identity of participants is enforced.

4. **Input/seat correspondence** — `args.players.len() == player_count`, and every
   `args.players[i].seat_index` matches an occupied seat exactly once (`lib.rs:235`–`249`).

   ⚠️ This only checks that there is **one input row per occupied seat**. It does **not** check
   that the *contents* of that row (`contribution`, `folded`, `prediction`, `seal_seq`) reflect
   anything the player signed. The values come straight from `SettleArgs`
   (`services/programs/src/settle_args.rs:14`–`22`).

5. **Oracle authenticity** — the company-signed price in `SettleArgs.signed_price` must pass
   secp256k1/EIP-191 signature recovery (`services/programs/src/signed_price.rs`); the recovered
   signer must equal `ProtocolState.price_signer`. ✅ the price cannot be forged without the
   operator's signing key.

6. **Deterministic re-verification** — rebuild the shared inputs from `args.players` and call
   `syndicate_shared::verify_settlement(&input, &claimed)` (`lib.rs:251`–`281`). This recomputes
   side-pots, winners/ties and rake from the inputs and fails with `SettlementMismatch` if the
   submitted result disagrees.

7. **Conservation** — `pot_awards + uncalled_returns + rake == total_deposited`, and the sum of
   per-seat payouts `== total_deposited − rake` (`lib.rs:283`–`321`). ✅ no money is created or
   destroyed.

8. **Write payouts & finalize** — each seat's `payout` is set and status → `Settled`
   (`lib.rs:302`–`328`).

### The crux

Steps 6 and 7 prove the result is **mathematically consistent with the inputs**. They do **not**
prove the **inputs are authentic**. There is:

- no `ed25519` / `secp256k1` instruction or `Instructions` sysvar introspection,
- no merkle root of player-signed actions stored in `MatchAccount` or checked here,
- no `event_root` / hash-chain proof verified on-chain,

…anywhere in the program. (Confirmed by searching the whole `services/programs` tree: the only
signature verification present is the secp256k1 company-signed price, in `signed_price.rs`.)

`MatchAccount` does store a `config_hash` (`state.rs:51`), but that binds the *game parameters*
(rake, feed, windows) for replay — it is **not** a commitment to the players' signed actions,
and `submit_settlement` does not even re-check it.

---

## 4. Why this is by design — and where the risk lands

The project's trust model (visible in the code comments, e.g. `lib.rs:1`–`13`) is:

> "The match engine orders gameplay but is **not trusted for outcomes**; on-chain verification
> gates fund release."

The chain re-verifies the **outcome math** and **custody**, deliberately keeping the program
dependency-free and SBF-portable. The authenticity of the *actions* is delegated to the
off-chain stack:

- `gateway` authenticates players and (per `services/shared/ARCHITECTURE.md:24`, a
  `log/ … intent verification` layer) is where signed intents are meant to be validated;
- the `settlement-worker` reconstructs the outcome and the `settlement-chain` adapter signs and
  submits it **as `settlement_admin`**.

So the **entire integrity of gameplay rests on the off-chain `settlement_admin` pipeline.**
If that pipeline is honest and correct, results are correct. If `settlement_admin` is
compromised, coerced, or buggy, it can:

- claim a player folded when they didn't (or vice-versa),
- alter a player's prediction so a chosen seat "wins",
- mis-state contributions,

and the chain will compute a perfectly "valid", conserved payout from those lies and release
funds accordingly. The only on-chain safety nets that still hold are: funds can't leave the
match's own vault, totals are conserved, and only depositors' seats can be paid — i.e. an
attacker can **redistribute a match's pot among its real participants**, but cannot mint money
or pay outsiders.

---

## 5. Recommendations (if on-chain intent authenticity is required)

These are options, not changes made here:

1. **Commit to signed actions on-chain.** Have each player sign their action stream
   (or its hash) off-chain; the engine builds a merkle root / hash-chain of those signed
   intents and stores the root in `MatchAccount` at `lock`. `submit_settlement` then verifies
   that the `SettleArgs` inputs are the leaves under that committed root.
   - This still doesn't verify *each* signature on-chain, but it cryptographically binds the
     settled inputs to a commitment made before the outcome was known.

2. **Verify player signatures over the final input set.** Require the `submit_settlement`
   transaction to carry, per seat, an ed25519 signature (verified via the Ed25519 program +
   `Instructions` sysvar introspection) by `seat.player` over their canonicalized inputs. This
   is the strongest guarantee but is heavier and bounded by transaction size (the program caps
   at 5 seats — `lib.rs:218`).

3. **Decentralize / threshold the `settlement_admin`.** If full on-chain intent verification is
   out of scope, at minimum reduce single-key trust: make `settlement_admin` a multisig, and
   keep the existing dual-RPC + secondary verification the off-chain adapter already performs.

4. **Bind `config_hash` at settlement.** Cheap hardening: re-assert the bound `config_hash`
   (and seal-sequence ordering) during `submit_settlement` so the replay anchor is enforced
   on-chain, not just recorded.

---

## 6. Summary table

| Property | Verified on-chain? | Mechanism |
| --- | --- | --- |
| Player deposited / owns their seat | ✅ Yes | `player: Signer` on `deposit`; seat PDA derivation |
| Only the right party can submit settlement | ✅ Yes | `authority == settlement_admin` |
| Oracle price is real | ✅ Yes (trusted operator key) | secp256k1/EIP-191 against `ProtocolState.price_signer` (`signed_price.rs`) |
| Payout math is correct for the given inputs | ✅ Yes | `syndicate_shared::verify_settlement` |
| Money is conserved (no mint/burn, only depositors paid) | ✅ Yes | conservation checks |
| **Player actions/intents were actually signed by the players** | ❌ **No** | none — inputs trusted from `settlement_admin` |
| Settled inputs match a pre-committed action log | ❌ No | `config_hash` stored but not a signed-action root |

**Bottom line:** the contract guarantees *custodial and arithmetic* integrity, but **delegates
the authenticity of user actions entirely to the trusted off-chain settlement pipeline**; it
does not itself verify that the intents were signed by the users.
