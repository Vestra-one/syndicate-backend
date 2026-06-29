# programs — Solana Contract

**Build**: `cargo build-sbf --tools-version v1.53 -p syndicate-program` (must use v1.53; default v1.48 breaks edition2024)
**Check**: `cargo check -p syndicate-program` (from repo root)
**Tests**: `cd litesvm-tests && cargo test`

## Key files
- `programs/syndicate_program/src/lib.rs` — all instructions + context structs
- `programs/syndicate_program/src/state.rs` — MatchAccount, SeatAccount, ProtocolState
- `programs/syndicate_program/src/settle_args.rs` — SettleArgs (SignedPriceDto + payouts)
- `programs/syndicate_program/src/signed_price.rs` — secp256k1/EIP-191 price verification
- `programs/syndicate_program/src/action_handlers.rs` — seal commitment handler
- `programs/syndicate_program/src/error.rs` — SyndicateError variants

## Instructions (lifecycle order)
`initialize_protocol` → `create_match` / `create_and_deposit` → `deposit` → `lock` → `register_prediction_commitment` → `begin_live` → `submit_settlement` → `claim` / `withdraw_fees`

Void paths: `void_before_start` (permissionless, Filling/Sealing), `void_live_after_deadline` (permissionless, 300s grace post-scheduled_end), `void` (operator emergency).

## Current v1 state
- Oracle: signed-price-server (secp256k1), NOT Pyth. `ProtocolState.price_signer = [u8; 20]`
- Action-log: removed from contract (v1 trusts backend). `TODO(v1+)` in `lib.rs` header.
- Max players: 5. `engine_seat` is contiguous 0..sealed_count. `NO_ENGINE_SEAT = u8::MAX`.
- `ARCHITECTURE.md` in this directory is partially stale — trust the code.
