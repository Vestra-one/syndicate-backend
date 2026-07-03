# Fix: begin_live flow — SealDeadlineNotReached (Custom error 6024)

## Problem

Host can't start a game. The call chain `matchmaking → orchestrator → lock-match → begin_live on-chain` fails with:
```
transaction simulation failed: InstructionError[0, Custom 6024]
```

**Custom error 6024 = `SealDeadlineNotReached`** (Anchor starts at 6000; index 24 in `SyndicateError` in `services/programs/programs/syndicate_program/src/error.rs`).

On-chain guard in `begin_live` (`lib.rs`):
```rust
require!(now >= m.seal_deadline_ts, SyndicateError::SealDeadlineNotReached);
```

`seal_deadline_ts` is stamped by `lock`:
```rust
m.seal_deadline_ts = now.checked_add(m.seal_window_sec)?;  // seal_window_sec = 20s default
```

The orchestrator calls `lock` → **immediately** calls `begin_live` with zero delay. Since `seal_deadline_ts = lock_ts + 20s`, `begin_live` always runs before the deadline, always fails.

---

## Root Cause + All Related Bugs

### Bug 1 — Root cause: orchestrator doesn't wait for the seal window
**File:** `services/match-orchestrator/src/main.rs` ~lines 136–201

After `lock-match` succeeds the orchestrator fires `begin-live` immediately. `begin_live` on-chain requires `now >= seal_deadline_ts`. Fix: read `sealDeadlineTs` from the lock response and sleep until that timestamp before calling `begin-live`.

### Bug 2 — `submitLockMatch` doesn't return `sealDeadlineTs`
**File:** `services/settlement-chain/src/custody.ts` function `submitLockMatch` (~line 580)

Returns `{ ok, txSig, tx_sig, matchPda }` — never reads back the on-chain match account after confirming. The orchestrator needs `sealDeadlineTs` (and `beginLiveWindowSec`) to know how long to sleep.

Fix: after the lock tx confirms, call `connection.getAccountInfo(pdas.match, 'confirmed')`, decode with `decodeMatchAccount` (already in `matchAccount.ts`), and add `sealDeadlineTs` + `beginLiveWindowSec` to the return value.

### Bug 3 — `begin_live_window_sec = 5s` is too tight
**Files:** `services/config/src/index.ts` line 86, `services/settlement-chain/src/custody.ts` line 159

`DEFAULT_BEGIN_LIVE_WINDOW_SEC = 5`. After the seal window the operator has only 5 seconds to land `begin_live` on-chain. Actual path: HTTP round-trip (orchestrator → settlement-chain) + `getProgramAccounts` RPC call to enumerate seats + simulate tx + submit + confirm = realistically 1–10 s. Any RPC latency or slot congestion blows the window, causing `BeginLiveWindowPassed` (error 6027).

Fix: raise the default to **30 seconds** in both `config/src/index.ts` and `custody.ts`.

### Bug 4 — Orchestrator has no sleep logic and discards lock response body
**File:** `services/match-orchestrator/src/main.rs`

`require_downstream` consumes and discards the successful response body, so even if settlement-chain returned `sealDeadlineTs`, the orchestrator can't see it. No sleep code exists.

Fix: capture the lock response body on success, parse `sealDeadlineTs`, compute `sleep_secs = deadline - unix_now() + 1`, then `tokio::time::sleep`.

### Bug 5 — Missing engine-timing fields in the start-policy request
**File:** `services/matchmaking/src/orchestrator-client.ts`

`StartContext` and the HTTP body sent to `/internal/start-policy` omit `roundDurationsSec`, `observationWindowsSec`, and `timeBankSec`. The orchestrator's `StartPolicyRequest` struct already has these as `Option<Vec<u64>>` / `Option<u64>` fields. Without them the engine receives no template timing and falls back to hardcoded defaults.

Fix: add the three fields to `StartContext`; populate from the bound `MatchConfig` in `formation.ts` at the `triggerStartPolicy` call site.

---

## Verified Correct — No Changes Needed

- `buildBeginLiveInstruction` in `custody.ts` — correctly appends `buttonRandomness[32]` to ix data and passes all seat PDAs as writable `remaining_accounts`.
- `enumerateSeatPdas` in `verify.ts` — correctly calls `getProgramAccounts` with memcmp filter on match key.
- `decodeMatchAccount` in `matchAccount.ts` — offsets manually verified field-by-field against `state.rs`; all 435 bytes match exactly.
- Orchestrator `set-button-seed` step — already removed; orchestrator flow is otherwise correct.
- `matchAccount.ts` `sealDeadlineTs` field at offset 189 — verified correct against state.rs layout.

---

## Implementation

### Change 1 — `services/settlement-chain/src/custody.ts`

**a) `submitLockMatch` — read back match account and return timing fields**

Add `decodeMatchAccount` import at top of file (if not already imported):
```typescript
import { decodeMatchAccount } from './matchAccount.ts';
```

In `submitLockMatch`, after `sendSignedLegacyTx` succeeds, before the `return`:
```typescript
const info = await connection.getAccountInfo(pdas.match, 'confirmed');
const m = info?.data ? decodeMatchAccount(info.data as Buffer) : undefined;
return {
  ok: true as const,
  txSig,
  tx_sig: txSig,
  matchPda: pdas.match.toBase58(),
  sealDeadlineTs: m ? m.sealDeadlineTs.toString() : null,
  beginLiveWindowSec: m ? m.beginLiveWindowSec.toString() : null,
};
```

**b) `encodeCreateParams` — raise `begin_live_window` default**

Line ~159, change:
```typescript
const beginLiveWindow = parseU64(input.beginLiveWindowSec ?? 5, 'beginLiveWindowSec');
```
to:
```typescript
const beginLiveWindow = parseU64(input.beginLiveWindowSec ?? 30, 'beginLiveWindowSec');
```

---

### Change 2 — `services/config/src/index.ts`

Line 86, change:
```typescript
export const DEFAULT_BEGIN_LIVE_WINDOW_SEC = 5;
```
to:
```typescript
export const DEFAULT_BEGIN_LIVE_WINDOW_SEC = 30;
```

`defaultFeedUsdcTier` at line 294 already references this constant (`beginLiveWindowSec: DEFAULT_BEGIN_LIVE_WINDOW_SEC`), so no further change needed there.

---

### Change 3 — `services/match-orchestrator/src/main.rs`

**a) Add imports at top**
```rust
use std::time::{Duration, SystemTime, UNIX_EPOCH};
```

**b) Add `unix_now` helper** (outside `handle_request`, near the other helpers):
```rust
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
```

**c) Replace current lock call block (~lines 136–154)**

The current code passes the lock result directly to `require_downstream` and discards the body. Restructure to capture the body:

```rust
// Step 1: lock-match
let lock_result = post_json(
    &cfg.settlement_chain,
    "/internal/solana/lock-match",
    &cfg.auth,
    lock_body,
)
.await;

let lock_resp = match lock_result {
    Ok(resp) if (200..300).contains(&resp.status) => resp,
    Ok(resp) if cfg.stub_mode => {
        eprintln!("orchestrator stub: lock-match returned HTTP {}", resp.status);
        PostResult { status: 200, body: String::new() }
    }
    Ok(resp) => {
        return (
            "502 Bad Gateway",
            format!(
                r#"{{"error":"lock-match failed with HTTP {}","detail":{}}}"#,
                resp.status,
                serde_json::to_string(&resp.body).unwrap_or_else(|_| "\"\"".into())
            ),
        );
    }
    Err(err) if cfg.stub_mode => {
        eprintln!("orchestrator stub: lock-match transport error: {err}");
        PostResult { status: 200, body: String::new() }
    }
    Err(err) => {
        return (
            "503 Service Unavailable",
            format!(r#"{{"error":"lock-match unavailable","detail":"{err}"}}"#),
        );
    }
};

// Step 2: wait for seal window to elapse before calling begin_live.
// begin_live requires now >= seal_deadline_ts on-chain (SealDeadlineNotReached = 6024).
let seal_deadline_ts: Option<u64> = serde_json::from_str::<serde_json::Value>(&lock_resp.body)
    .ok()
    .and_then(|v| {
        v.get("sealDeadlineTs")
            .and_then(|x| x.as_str().and_then(|s| s.parse().ok()))
    });

if let Some(deadline) = seal_deadline_ts {
    let now = unix_now();
    if deadline > now {
        // +1s buffer past the on-chain deadline to absorb clock skew between backend
        // and the Solana validator.
        tokio::time::sleep(Duration::from_secs(deadline - now + 1)).await;
    }
} else if !cfg.stub_mode {
    // Lock response didn't include a deadline (e.g. old settlement-chain version).
    // Fall back to a conservative 21s sleep to cover the default 20s seal window.
    tokio::time::sleep(Duration::from_secs(21)).await;
}
```

---

### Change 4 — `services/matchmaking/src/orchestrator-client.ts`

**a) Add fields to `StartContext`:**
```typescript
export interface StartContext {
  onchainMatchId: string;
  matchPda?: string;
  tierId: string;
  feedId: string;
  players: Array<{ seatIndex: number; stack: number; sealSeq: number; wallet: string }>;
  smallBlind: number;
  bigBlind: number;
  roundCount: number;
  actionTimeoutMs: number;
  roundDurationsSec?: number[];
  observationWindowsSec?: number[];
  timeBankSec?: number;
}
```

**b) Pass them in the request body inside `triggerStartPolicy`:**
```typescript
body: JSON.stringify({
  matchId,
  result,
  onchainMatchId: ctx.onchainMatchId,
  players: ctx.players,
  smallBlind: ctx.smallBlind,
  bigBlind: ctx.bigBlind,
  roundCount: ctx.roundCount,
  actionTimeoutMs: ctx.actionTimeoutMs,
  roundDurationsSec: ctx.roundDurationsSec,
  observationWindowsSec: ctx.observationWindowsSec,
  timeBankSec: ctx.timeBankSec,
}),
```

---

### Change 5 — `services/matchmaking/src/formation.ts`

At the `triggerStartPolicy` call site, add timing fields from the bound `MatchConfig` to the `StartContext`:
```typescript
roundDurationsSec: config.roundDurationsSec,
observationWindowsSec: config.observationWindowsSec,
timeBankSec: config.timeBankSec,
```
`config` is the `MatchConfig` already available at that call site.

---

## Files Changed Summary

| File | What changes |
|------|-------------|
| `services/settlement-chain/src/custody.ts` | `submitLockMatch`: read back match account after lock confirms → return `sealDeadlineTs` + `beginLiveWindowSec`; `encodeCreateParams`: default `?? 5` → `?? 30` |
| `services/config/src/index.ts` | `DEFAULT_BEGIN_LIVE_WINDOW_SEC = 5` → `30` |
| `services/match-orchestrator/src/main.rs` | Capture lock response body; parse `sealDeadlineTs`; sleep until deadline + 1s; add `unix_now()` helper and `std::time` import |
| `services/matchmaking/src/orchestrator-client.ts` | Add `roundDurationsSec`, `observationWindowsSec`, `timeBankSec` to `StartContext` and request body |
| `services/matchmaking/src/formation.ts` | Pass timing fields from bound `MatchConfig` into `StartContext` |

---

## Verification Steps

1. Start the full local stack (settlement-chain, orchestrator, matchmaking, engine).
2. Create a match and have ≥2 players deposit.
3. Trigger host-start. Watch orchestrator logs: should show `lock-match OK`, then a ~20s sleep, then `begin-live OK`.
4. Confirm `begin-live` returns 200 with `button`, `liveStartTs`, `scheduledEndTs`.
5. Engine starts and the match goes Live.
6. No `SealDeadlineNotReached` (6024) or `BeginLiveWindowPassed` (6027) errors in the chain.

**Quick devnet shortcut for testing:** Create a match with `sealWindowSec: 1` in the test harness so the sleep is ~2 seconds and iteration is fast.
