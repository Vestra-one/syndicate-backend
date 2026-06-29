# settlement-chain — Solana Instruction Builders (TypeScript)

Builds Solana instructions and encodes Anchor args. Does NOT talk to chain directly — the worker calls these.

## Key files
- `src/custody.ts` — `encodeCreateParams` (138 bytes), `buildCreateMatchInstruction`, `buildLockInstruction`, `deriveMatchPdas`
- `src/main.ts` — `encodeSettleArgsFromBundle`, `deriveSyndicateAccounts`
- `src/actionLog.ts` — `anchorDiscriminator` helper (used for instruction discriminators)
- `test/custody.test.ts` — byte-length test (138 bytes), discriminator tests
- `test/protocol.test.ts` — SettleArgs encoding test, PDA derivation test

## CreateParams layout (138 bytes, Borsh LE)
```
match_id(8) buy_in(8) entry_fee(8) rake_bps(4) rake_cap(8)
nonseal_penalty_bps(4) min(1) max(1) config_hash(32) price_token(20)
total_betting(8) seal_window(8) begin_live_window(8) fill_deadline(8)
max_oracle_confidence(8) oracle_exponent(4)
```

## SettleArgs layout (Borsh)
`signed_price { token(20) price_in_wad(32) timestamp_ms(8) v(1) r(32) s(32) } || rake(8) || payouts_len(4) || [engine_seat(1) amount(8)...]`

## Notes
- `price_token` is 20 bytes (Ethereum address of the token signed by price server), NOT 32-byte Pyth feed_id
- `buildSetButtonSeedInstruction` in custody.ts is dead code (button seed removed in T3) — remove when cleaning up
