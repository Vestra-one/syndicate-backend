# worker — Settlement Worker

Rust service. Triggered by NATS events; loads DB context, calls shared.settle(), submits to chain.

## Key files
- `src/reconstruct.rs` — `LoadedContext`, `SettleParams` — loads match + seat data from DB
- `src/lib.rs` — main worker loop, event handling

## Data flow
DB (`dead_money_chips`, seats, actions) → `reconstruct::load()` → `SettleParams { dead_money, ... }` → `settlement::settle_match()` → `SettlementBundle` → `settlement-chain` → Solana

## Notes
- `dead_money` flows: DB column → `LoadedContext.dead_money` → `SettleParams.dead_money` → `SettlementBundle.dead_money`
- Worker is NOT yet fully wired for drand timelock decryption (pending task)
- `ARCHITECTURE.md` in this directory may be stale
