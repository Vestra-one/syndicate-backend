# config — Match Templates & Config Hash

TypeScript. Defines the `MatchConfig` type and hardcoded template allowlist.

## Key files
- `src/index.ts` — `MatchConfig`, template helpers, `timelockTargetRound()`, `totalBettingDurationSec()`
- `src/table-terms.ts` — `TableTermsPayload`, `toTableTerms()` (player-facing config summary)
- `test/config.test.ts` — template hash stability tests

## MatchConfig fields (current)
```typescript
{
  roundDurationsSec: number[],      // per-street betting durations
  observationWindowsSec: number[],  // per-street observation (oracle) windows
  sealWindowSec: number,            // default 20
  beginLiveWindowSec: number,       // default 5
  nonsealPenaltyBps: number,        // default 2500
  // + buy_in, rake_bps, etc.
}
```

## Key constants
- `MAX_ORACLE_TOLERANCE_SEC = 2`, `DEFAULT_ORACLE_DELAY_WINDOW_SEC = 2`
- `DEFAULT_SEAL_WINDOW_SEC = 20`, `DEFAULT_BEGIN_LIVE_WINDOW_SEC = 5`
- `MAX_TIMELOCK_SKEW_SEC = 20`, `DEFAULT_NONSEAL_PENALTY_BPS = 2500`

## Key functions
- `timelockTargetRound(config, projectedLiveStartUnix)` — computes the drand round to target
- `templateAllowlist()` / `getTemplateByHash(hash)` — config-hash allowlist for CreateParams
- `totalBettingDurationSec(config)` — Σ round durations + observation windows
