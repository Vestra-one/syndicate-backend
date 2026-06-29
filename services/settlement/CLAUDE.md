# settlement — Settlement Orchestration

Rust crate. Bridges `shared.settle()` to on-chain submission.

## Key files
- `src/lib.rs` — `SettleParams`, `SettlementBundle`, `settle_match()`, `Outcome`
- `src/ops.rs` — Oracle fetch/post traits, Solana tx traits, `SettlementJob`

## Key types
```
SettleParams { match_id, buy_in, contributions, dead_money, config, oracle_rules, seats }
SettlementBundle { result: SettleResult, dead_money, payouts: Vec<SeatPayout>, signed_price }
```

## Flow
`SettleParams` → `shared::settle()` → `SettlementBundle` → `settlement-chain` encodes → Solana tx

## Notes
- `dead_money` flows from DB (`dead_money_chips` column) → `SettleParams` → `SettlementBundle`
- `ops.rs` has `PythResolvedPrice` + `SignedPricePayload` structs — the worker uses signed-price-server now (not raw Pyth), but both types exist for the transition
- `ARCHITECTURE.md` in this directory may reference Pyth/VRF — those are stale
