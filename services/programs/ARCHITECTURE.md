# Service: `programs` — Solana On-Chain Program(s)

**Stack:** Rust + Anchor. **Trust role:** the source of truth for custody and final settlement. **Implements:** `04 §3,§4,§9,§10,§11,§14,§18`; `06 §1,§4,§5,§11`.

> This service holds user funds and is the last line of capital safety. Treat every line as audited, adversarial-input code. It links the deterministic core in `shared` so its settlement math is **byte-identical** to the off-chain builder.

---

## Responsibilities (owns)
- **Protocol state PDA:** stores scoped admin roles and pause flags. No single match authority controls all operations.
- **Match vault PDA** per match: holds all buy-ins in `chips_token`; locks at LIVE; pays only via the validated settlement instruction.
- **Deposits / seat eligibility:** accept buy-in + `entry_fee`; finality is what `matchmaking` waits on to seat a player.
- **Refunds / VOID:** full pro-rata refund path (incl. entry-fee refund) for not-filled / leave-before-LIVE / fault.
- **Settlement verification:** consume a Pyth Receiver `PriceUpdateV2` account, require full verification/account ownership, validate the authenticated feed/timestamp/confidence/exponent metadata, recompute pots from recorded inputs using `shared`, and validate the submitted settlement before releasing funds; reject/halt on mismatch.
- **VRF:** consume verifiable randomness for button assignment; record seed + proof.
- **Fees:** entry fee at deposit; pot rake at settlement (to the fee/treasury account). (`04 §14`.)
- **Idempotent claim/distribution** per `(match, player)`, with seat accounts closed after claim/refund.
- **Seat-index uniqueness:** one PDA per `(match, seat_index)` prevents two wallets occupying the same seat number; seat PDA per `(match, player)` prevents one wallet taking multiple seats in the same match.

## Non-responsibilities (explicitly NOT here)
- No gameplay sequencing, timers, or betting legality (→ `match-engine`).
- No oracle fetching. The settlement worker posts/fetches Pyth updates; the program consumes the resulting authenticated Receiver account and validates it before settlement.
- No decryption of predictions (→ `timelock`); the program verifies decrypted values against recorded ciphertexts.

## Internal structure (suggested)
```
programs/
  Anchor.toml
  programs/syndicate/src/
    lib.rs            # entrypoints
    instructions/     # create_match, deposit, lock, settle, claim, void, refund
    state/            # MatchVault, SeatLedger, FeeConfig (PDAs)
    verify/           # settlement re-verification (calls shared)
    errors.rs
  tests/              # bankrun / litesvm integration, fuzz
```

## Key instructions (state transitions)
`initialize_protocol` · `set_pauses` · `create_match` · `deposit` (buy_in + entry_fee → seat-eligible) · `lock` (→ LIVE; deposits frozen) · `settle` (verify via `shared`, assert conservation `Σpayouts+Σreturns+fees == Σdeposits`, write exact seat payouts) · `claim` (idempotent, closes seat records) · `void`/`refund` (capital-safe exit, closes seat records).

## Invariants (must assert on-chain)
- Conservation holds **net of fees** before any release (`04 §0`).
- Funds release **only** after settlement re-verification passes.
- Settlement must include exactly the occupied seats; player inputs must correspond to those seats.
- Locked funds cannot move except via settle/void.
- Entry fee refunded on VOID/leave-before-LIVE; never raked on void.
- All randomness/seeds recorded for replay.
- Pause controls stop new exposure or settlement submission but must not block claims/refunds.

## Dependencies
- `shared` (deterministic pot, oracle metadata, and winner math — linked as a crate).
- Reads verified Pyth oracle price metadata + drand-decrypted predictions provided in the settle instruction (produced by `settlement`/Pyth updater/`timelock`).

## Testing
- Litesvm/bankrun integration for every instruction + every VOID path.
- **Conservation + determinism**: program settlement == `shared` reference == `settlement` output (golden vectors).
- Fuzz deposit/settle/claim ordering; reentrancy-class and arithmetic-overflow checks; **independent external audit before mainnet**.

## AI-agent rules
- Money math → call `shared`; never inline pot/`S`/tie logic here.
- Any new instruction must define its refund/void behavior and assert conservation.
- Changing settlement inputs? Update `shared`, `settlement`, and the replay golden vectors together.
- Capital safety > everything: if verification is uncertain, do not release — VOID.
