# Devnet Flow Test Findings

Last updated: 2026-07-01T11:52:00Z

## Scope

End-to-end user flow against devnet as a protocol user:

1. Host creates a room by signing `create_and_deposit`.
2. Host reports the txhash to matchmaking.
3. Joiner signs `deposit`.
4. Joiner reports the txhash to matchmaking.
5. Host starts the room through matchmaking.
6. Backend locks the match; users seal on-chain during `Sealing`.
7. Backend advances to `Live`.
8. Users submit gateway actions/defaults.
9. Backend settles and exposes resolution.
10. Users claim/refund after terminal state.

Target program: `6mmD3xZhgJ33RzHgXWeFSdLG8Ygpy2camFWtDmdmKM7d`.

## Findings So Far

### F1 - Existing deployed-flow script targeted stale program/config

`scripts/e2e-devnet-test.ts` previously defaulted to program `GhbH...`, while `devnet-contract-info.md` and the current deployed program use `6mmD...`. It also hard-coded an obsolete `CONFIG_HASH`, which would be rejected by backend tx verification because deployed config templates allowlist different hashes.

Status: fixed in the script. The script now defaults to `6mmD...` and fetches the deployed `tier-standard:BTC/USD` template/config hash before creating the match.

### F2 - Existing script used old begin-live timing

The script encoded `beginLiveWindowSec = 5`, while the implemented fix and deployed config use `30`. This made the test structurally inconsistent with the plan fix and too brittle for devnet timing.

Status: fixed in the script. It now uses deployed timing values.

### F3 - Existing script sealed in the wrong lifecycle phase

The old script treated sealing as something that opens after `LIVE + totalBettingDurationSec`. The contract only accepts `register_prediction_commitment` while the match is in `Sealing` and before `seal_deadline_ts`. That made the old `AWAIT_SEAL` branch invalid as an on-chain flow test.

Status: fixed in the script. It now starts the backend `/rooms/:roomCode/start` request, then submits both users' on-chain seal commitments while that backend request is waiting for the seal deadline.

### F4 - Commitment hash implementation was wrong in the old test

The script used Node SHA-256 for `computeCommitment`, but the backend/shared implementation uses the repo's deterministic `simple_sha256` over `i128_le(prediction) || blinding`.

Status: fixed in the script.

### F5 - Backend public API does not expose exact sealing metadata to users

The public matchmaking start endpoint does not expose `sealDeadlineTs` or the exact valid `timelockTargetRound` before the start request completes. The script currently estimates from the host-start request time. If this fails under live timing, the backend should expose exact `Sealing` metadata through a user-visible surface.

Status: open backend/API gap to verify in live run.

### F6 - Gateway seal upload lacks an acceptance ack

`sealPrediction` is sent over gateway, but the user-facing protocol has no explicit acknowledgment that the ciphertext/blinding was persisted. The test can only infer acceptance from later settlement visibility.

Status: open backend/API gap to verify in live run.

### F7 - Settlement/claim public user surface is limited

Deployment docs say settlement-chain is not public; matchmaking handles txhash reporting only. Public action-feed history is the currently available user-visible backend surface for terminal resolution. Claim/refund are wallet-side Solana actions per frontend docs, not public backend actions.

Status: script now polls public action-feed history for settled/voided resolution. Claim/refund execution remains dependent on terminal visibility and wallet-side transaction builders.

### F8 - Local verification status

Passed:

- `node --experimental-strip-types --check scripts/e2e-devnet-test.ts`
- `bash -n scripts/run-e2e-devnet.sh`
- `npm --prefix services/settlement-chain test` (36/36)
- `npm --prefix services/matchmaking test` (22/22)
- `npm --prefix services/e2e test` (3 passed, 1 devnet-gated skip)
- `git diff --check -- scripts/e2e-devnet-test.ts scripts/run-e2e-devnet.sh services/matchmaking/src/main.ts deploy/docker-compose.app.yml findings.md`

Live:

- Run 1 sent one `create_and_deposit` transaction, then backend txhash reporting failed at the settlement-chain verifier auth gate.
- Run 2 verified the hardened preflight stops before sending any additional transaction while that backend gate remains broken.
- Run 3 re-confirmed the deployed backend still fails at the same verifier auth gate before any additional Solana transaction is sent.

### F9 - Harness now fails safely before deposits when backend verifier auth is broken

After Run 1 put a host deposit on-chain and then failed at txhash reporting, the script was hardened with a fake-create preflight. It calls `POST /rooms` with a fake txhash after loading the live config hash. If matchmaking returns internal settlement-chain `401`, the script exits before sending any real transaction.

Status: fixed in the script.

### F10 - Matchmaking deployment does not read the mounted settlement-chain token

The live failure is consistent with matchmaking not sending the Basic Auth credential expected by settlement-chain. Other services support token-file deployment patterns, but matchmaking only read `SETTLEMENT_CHAIN_AUTH_TOKEN` directly. In the app docker compose, matchmaking also did not mount `./secrets/settlement-chain.token`.

Status: fixed in repo config/code. `services/matchmaking/src/main.ts` now supports `SETTLEMENT_CHAIN_AUTH_TOKEN_FILE`, and `deploy/docker-compose.app.yml` mounts the host token from `deploy/secrets/settlement-chain.token` into the established container path `/etc/syndicate/settlement-chain.token` for matchmaking, orchestrator, settlement-chain, and settlement-worker. The currently deployed backend still needs this change deployed/restarted before the E2E user flow can pass.

### F11 - Compose token source path must match the real host file

The container-side `/etc/syndicate/settlement-chain.token` pattern is correct. The failure came from mounting a host path that does not exist in this repo checkout, which caused Docker to surface a directory at the target path and made services fail with `EISDIR` / `Is a directory`.

Status: fixed in `deploy/docker-compose.app.yml`. Token consumers now read `/etc/syndicate/settlement-chain.token`, mounted from `./secrets/settlement-chain.token`, which matches the existing deployment docs and adjacent `settlement-admin-keypair.json` pattern.

### F12 - Deployed start flow fails because match-engine requires UUID match ids but matchmaking uses the Solana match PDA

After the backend restart, the previous settlement-chain auth blocker is fixed: matchmaking can verify txhashes, accept room creation, and accept the joiner deposit. The flow now fails when the host starts the room.

Observed deployed error from `POST /rooms/:roomCode/start`:

- `orchestrator start-policy failed (502)`
- nested detail: `match-engine start failed with HTTP 409`
- nested match-engine error: `invalid: invalid match uuid: invalid character: found 'z' at 2`

Code trace:

- `services/matchmaking/src/formation.ts` sets `const matchId = input.matchPda` for real on-chain rooms.
- `services/matchmaking/src/formation.ts` sends `rec.matchId` into `orchestrator.triggerStartPolicy(...)`.
- `services/match-orchestrator/src/main.rs` forwards the same `matchId` into match-engine `/internal/matches/start`.
- `services/match-engine/src/persistence.rs` production lease acquisition parses `match_id` as `uuid::Uuid`.

Impact:

- The user can deposit and report txhashes successfully.
- Both users can authenticate on gateway.
- Both users can submit on-chain `register_prediction_commitment` during the sealing window.
- The backend cannot make the game live because match-engine rejects the PDA-shaped match id.
- Matchmaking remains user-visible as `FILLING`, while action-feed has no history for the match.
- This blocks live betting, settlement, reveal, and claims through the user flow.

Status: fixed in repo, pending deploy/retest. The chosen service contract is: public/backend `matchId` equals the Solana on-chain match id (`onchainMatchId`) as decimal text. `matchPda` remains a separate Solana account address. Postgres can keep internal UUID primary keys, but engine/store/action-feed resolve the protocol `matchId` through `matches.onchain_match_id` / `matches.match_key` before writing UUID-keyed tables.

Repo changes:

- `services/matchmaking/src/formation.ts` now sets `matchId = input.onchainMatchId` for verified on-chain rooms instead of `matchId = input.matchPda`.
- `services/matchmaking/src/persistence.ts` documents `matchKey` as the protocol match id.
- `services/store/src/postgres.rs` accepts internal UUID, `match_key`, or `onchain_match_id` for match lifecycle/event/seat/context reads and writes where user-flow services pass a match id.
- `services/match-engine/src/persistence.rs` resolves external protocol match ids to the existing internal UUID row before acquiring leases, appending events, snapshots, settlement enqueue, and replay loads.
- `services/action-feed/src/projector.ts` resolves protocol match ids to UUID rows when persisting replay/history and hydrates history back under `onchain_match_id::text`.
- `services/matchmaking/test/registry.test.ts` now asserts `matchId === onchainMatchId` and deposit reporting by on-chain match id.

Verification:

- `node --experimental-strip-types --test services/matchmaking/test/registry.test.ts` passed.
- `cargo test -p syndicate-store -p syndicate-engine` passed.
- `node --experimental-strip-types --check services/action-feed/src/projector.ts` passed.
- `node --experimental-strip-types --check services/matchmaking/src/formation.ts` passed.
- `node --experimental-strip-types --check scripts/e2e-devnet-test.ts` passed.
- `node --experimental-strip-types --test services/action-feed/test/projector.test.ts services/action-feed/test/read-api.test.ts` could not complete in the sandbox because local `127.0.0.1` listener creation failed with `EPERM`; an elevated rerun was blocked by the environment approval/usage limit. The non-listening projector tests in that command passed before the listener failures.

## Live Run Receipts

### Run 1 - 2026-07-01T10:37Z

Command intent: run `scripts/e2e-devnet-test.ts` against deployed devnet backend as a user, with authorized wallet signing.

Environment:

- Matchmaking: `https://matchmaking.devnet.satoshitable.fun`
- Gateway: `wss://gateway.devnet.satoshitable.fun`
- Program: `6mmD3xZhgJ33RzHgXWeFSdLG8Ygpy2camFWtDmdmKM7d`
- Chips mint: `3Gdd9ew2Dq63QeJETc7krKB2JJ1GaHfBZvMzBdAy541X`
- Config hash fetched live: `f45b21238906ada52fd0e7486c123843359713860161d9afdeacba821343f93d`
- Timing fetched live: `totalBetting=580s`, `seal=20s`, `beginLiveWindow=30s`

Preflight passed:

- Matchmaking `/healthz`: ok
- Config `/healthz`: ok
- Action-feed `/healthz`: ok
- Price `/health`: ok
- Player 1 SOL/token balance sufficient
- Player 2 SOL/token balance sufficient

On-chain transaction sent:

- `create_and_deposit` succeeded.
- On-chain match id: `26592567447011025`
- Match PDA: `34NzPakas5gfAuvcXRHYWRfuDSNAgrRhsbv7DUB9BQ5K`
- Vault PDA: `BP9HKtQW41QQsn4QFF15fiffBGp2HcTH7yTjvV58zY4J`
- Create tx: `5ygFEtHfKxwZi6KEijRYpjkJNz8gdsgpwyS43gVSef5FKNRNfFNUsy4JjjFcPPe6Ku8msgmHffMa67oVABDUNcfG`

Backend failure:

- `POST /rooms` returned:
  - `{"ok":false,"reason":"chain verify failed (401): {\"error\":\"unauthorized\"}"}`
- Follow-up `GET /rooms` returned `{"rooms":[]}`, so the failed create report did not partially register a lobby.

Interpretation:

- Matchmaking is reachable, but its internal call to settlement-chain verification is unauthorized.
- The user flow is blocked at the first backend txhash-reporting step.
- This is a deployed backend auth/config issue, likely `SETTLEMENT_CHAIN_AUTH_TOKEN` mismatch or missing token between matchmaking and settlement-chain.
- Per the test rule, no direct RPC fallback was used to bypass backend verification.

Status: failed backend gate. Cannot continue to join, lock, seal, live betting, settlement, or claim until matchmaking can verify reported txhashes through settlement-chain.

### Run 2 - 2026-07-01T10:38Z

Purpose: verify the new backend-verifier preflight stops before further on-chain transactions while the backend auth issue remains.

Preflight passed:

- Matchmaking `/healthz`: ok
- Config `/healthz`: ok
- Action-feed `/healthz`: ok
- Price `/health`: ok
- Config hash fetched live: `f45b21238906ada52fd0e7486c123843359713860161d9afdeacba821343f93d`

Stopped before any on-chain transaction:

- Backend verifier preflight returned:
  - `{"ok":false,"reason":"chain verify failed (401): {\"error\":\"unauthorized\"}"}`

Interpretation:

- The deployed backend issue is still present.
- The patched harness now protects future runs from depositing funds before confirming matchmaking can verify txhashes.

Status: failed backend gate. No additional Solana transaction was sent in Run 2.

### Run 3 - 2026-07-01T10:41Z

Purpose: continue the live E2E attempt after repo-side script and matchmaking auth-file fixes, using the same approved devnet wallets and backend-only user flow.

Preflight passed:

- Matchmaking `/healthz`: ok
- Config `/healthz`: ok
- Action-feed `/healthz`: ok
- Price `/health`: ok
- Config hash fetched live: `f45b21238906ada52fd0e7486c123843359713860161d9afdeacba821343f93d`
- Timing fetched live: `totalBetting=580s`, `seal=20s`, `beginLiveWindow=30s`

Stopped before any on-chain transaction:

- Backend verifier preflight returned:
  - `{"ok":false,"reason":"chain verify failed (401): {\"error\":\"unauthorized\"}"}`

Interpretation:

- The deployed backend still has the settlement-chain auth/config issue.
- The repo-side fix has not yet been deployed/restarted on devnet, or the deployed secret value is still mismatched.
- No additional Solana transaction was sent in Run 3.

Status: failed backend gate. Full flow remains blocked at "user submits txhash to backend".

### Run 4 - 2026-07-01T11:14Z

Purpose: restart the live E2E test after the backend was brought back up, using the same approved devnet wallets and backend-only user flow.

Environment:

- Matchmaking: `https://matchmaking.devnet.satoshitable.fun`
- Gateway: `wss://gateway.devnet.satoshitable.fun`
- Program: `6mmD3xZhgJ33RzHgXWeFSdLG8Ygpy2camFWtDmdmKM7d`
- Chips mint: `3Gdd9ew2Dq63QeJETc7krKB2JJ1GaHfBZvMzBdAy541X`
- Config hash fetched live: `f45b21238906ada52fd0e7486c123843359713860161d9afdeacba821343f93d`
- Timing fetched live: `totalBetting=580s`, `seal=20s`, `beginLiveWindow=30s`

Preflight passed:

- Matchmaking `/healthz`: ok
- Config `/healthz`: ok
- Action-feed `/healthz`: ok
- Price `/health`: ok
- Backend verifier fake-tx preflight no longer fails with `401 unauthorized`; it rejects fake txhash with transaction-size validation instead.
- Player 1 SOL/token balance sufficient.
- Player 2 SOL/token balance sufficient.

On-chain and backend receipts:

- On-chain match id: `24328480494376601`
- Match PDA: `E3zef1qCuELKnQoK86SJZpQhz66jwys4S7vv44dhAxUs`
- Vault PDA: `CgdaN5nSTXm3zUc2hGWw3dhvcJ8qukVtNxa2a7AUx4pg`
- Player 1 `create_and_deposit` tx: `4RpVY61Ucv92S8JuPWVWkVUqHr6fJJHJS5zXBwjDuRpuK8MU766iD7bz1Yr2UmJ8nbvg6LL1WVefxZEVQGKNn7Fg`
- `POST /rooms`: ok, room code `ac0143a6`
- Player 2 `deposit` tx: `3rg7RYQsvheH4ayY23tnsCGXXWYJtCrHdN9pTTctcQRD1y5tWTeU62TxvSQJctwPeyWetUvFSamecvsVSNGQPTiT`
- `POST /matches/:id/deposits`: ok, Player 2 seated at seat `1`
- Gateway auth: both players authenticated.
- Gateway room subscription: both players subscribed.
- Player 1 `register_prediction_commitment` tx: `2is9t3ixmPCR7eH4Sz9vReGm1nw5JBshMSqhRGtLCPPc7H8PJj8zSUzsMqcaCcsjpJhLo643q5GWRCgWCA2MJqXz`
- Player 2 `register_prediction_commitment` tx: `5Z7NT2hJJirHJaC9NUBLDnDevU3E4h4hn2fmujbCbz7ftKtfimdxfb9uLvFPpRUs6BK7Y7Nsvm9PEwcBX6hQFnpm`

Backend failure:

- `POST /rooms/ac0143a6/start` returned:
  - `{"error":"orchestrator start-policy failed (502): {\"error\":\"match-engine start failed with HTTP 409\",\"detail\":\"{\\\"error\\\":\\\"invalid: invalid match uuid: invalid character: found `z` at 2\\\"}\"}"}`

Follow-up user-visible state:

- `GET /rooms/ac0143a6` still reports phase `FILLING`.
- `GET /rooms` still lists the room as joinable with two seated users.
- `GET /matches/E3zef1qCuELKnQoK86SJZpQhz66jwys4S7vv44dhAxUs/history` returns `{"error":"match not found"}`.

Interpretation:

- The settlement-chain auth/token issue from Runs 1-3 is fixed on the deployed backend.
- The deployed flow is now blocked at the transition from sealed/locked on-chain state into match-engine live state.
- This is a backend service-contract bug: production match-engine requires UUID `matchId`, but real matchmaking uses the Solana match PDA as the match id.
- Full flow cannot continue to betting, settlement, reveal, or claim until this backend mismatch is fixed and redeployed.

Status: failed backend start/live gate after successful deposits and sealing commitments.
