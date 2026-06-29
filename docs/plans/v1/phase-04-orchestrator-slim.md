# Phase 04 — Orchestrator slim start-policy

**Goal:** `lock → begin_live(randomness + seats) → engine start` runs end-to-end; dead steps removed.

- **Status:** ⬜ not started
- **Depends on:** 01 (begin-live route), 02 (seat enumeration)
- **Parallel-safe with:** 05, 09, 10
- **Checklist ref:** §1b

---

## Context — why this phase exists

The orchestrator's start-policy is the true critical-path blocker: it still calls the **removed**
`set_button_seed` instruction (so the sequence cannot complete), and the engine `start` body omits the
timing fields (`roundDurationsSec`/`observationWindowsSec`/`timeBankSec`/`liveStartTs`) even though
the engine already accepts them. It also still exposes `/internal/formations/bootstrap` (the
operator-create path that v1's player-created model eliminates).

## Scope

**In:** rewrite the start-policy sequence; remove the bootstrap route; pass timing to the engine.
**Out:** the builders/routes themselves (Phase 01), seat enumeration impl (Phase 02), match-row writes (Phase 05/06).

## Files to touch

- `services/match-orchestrator/src/main.rs`

## Patterns to reuse

- Start-policy block `main.rs:223-369`: lock stage `:234-251`, **set-button-seed stage `:253-296` (DELETE)**, begin-live stage `:298-316`, engine-start stage `:317-346`.
- HTTP-to-settlement-chain helper `post_json` `main.rs:400-415` (Bearer auth).
- Bootstrap handler `main.rs:150-221` (**DELETE**).
- Engine `StartBody` fields to populate: `services/match-engine/src/server.rs:86-112` (`roundDurationsSec`, `observationWindowsSec`, `timeBankSec`, `liveStartTs`, `button`, `smallBlind`, `bigBlind`, `roundCount`, `actionTimeoutMs`, `players[{seatIndex,stack,sealSeq,wallet}]`).
- Template timing source: `config` package `getTemplateByHash(config_hash)` → `config.roundDurationsSec`/`observationWindowsSec`/`timeBankSec` (and `totalBettingDurationSec`).

## Implementation steps

1. **Delete the set-button-seed stage** (`:253-296`) and the `parse_button_from_seed_response` usage. The button is derived on-chain inside `begin_live` from the randomness we submit.
2. **Begin-live stage:** generate a CSPRNG `button_randomness: [u8;32]` (server-side); obtain the authoritative seat set by calling settlement-chain's begin-live route (Phase 01) which itself enumerates seats (Phase 02), OR call an enumerate endpoint first and pass `seatPdas`. POST `/internal/solana/begin-live` with `{ matchId, onchainMatchId, buttonRandomness, seatWallets|seatPdas }`. Capture `live_start_ts`/`scheduled_end_ts` from the response (settlement-chain returns the on-chain values) for the engine body + DB write (Phase 05).
3. **Engine-start stage:** look up the bound template by `config_hash`; add `roundDurationsSec`, `observationWindowsSec`, `timeBankSec`, and `liveStartTs` (from step 2) to the `start` body alongside the existing `button`/blinds/`roundCount`/`players`.
4. **Remove `/internal/formations/bootstrap`** (`:150-221`) and its request/response types. Keep `/internal/start-policy` and `/healthz`.
5. Keep the lock stage as-is (it already calls `/internal/solana/lock-match` with no args).

## Acceptance criteria

- [ ] No `set_button_seed`/`set-button-seed` references remain in the orchestrator.
- [ ] `begin_live` is called with server-generated randomness + the full seat set.
- [ ] The engine `start` body includes `roundDurationsSec`, `observationWindowsSec`, `timeBankSec`, `liveStartTs`.
- [ ] `/internal/formations/bootstrap` removed; `/internal/start-policy` intact.
- [ ] `cargo check` clean for the orchestrator crate.

## Verification

```bash
grep -rn "set.button.seed\|formations/bootstrap" services/match-orchestrator/src/   # expect no matches
cd services/match-orchestrator && cargo check
# functional check happens in Phase 11 (devnet start-policy completes lock→begin_live→engine start)
```

## Risks & gotchas

- `begin_live` is gated on-chain to `now >= seal_deadline_ts` AND `now <= seal_deadline_ts + begin_live_window_sec` (default 5s) — the orchestrator must fire promptly after the seal deadline or the match can only be voided. Keep the lock→begin_live latency tight.
- The seat set passed must equal `player_count` exactly (on-chain assert) — always derive from `getProgramAccounts` (Phase 02), never from the registry.
- `button_randomness` must be non-zero (on-chain `InvalidButtonRandomness` guard).
