# Player-Created Rooms + Configurable Wall-Clock Timing

> Overview: Redesign match creation and timing so players (not the operator) create rooms on-chain via an atomic create+deposit, an indexer projects chain state into a browseable room registry, and a fully configurable wall-clock round engine drives identical, lag-free timing for all players while the operator+oracle retain control of progression and fund release.

## Core principle (first-principles invariant)

- **Chain is the source of truth.** Players sign `create_match` (+ their deposit) atomically; the backend learns of matches only by indexing the chain.
- **Creation is permissionless; progression and money are gated.** Anyone can create, but only the operator runs `lock` -> `set_button_seed` -> `begin_live` -> `submit_settlement`, and only oracle-verified settlement releases funds. Abandoned/garbage rooms can only refund/void.
- **One authoritative clock.** The server (match-engine) drives gameplay timing from an on-chain-stamped `live_start_ts`; the gateway pushes absolute deadlines + server time so every client renders the identical countdown.
- **Nothing hardcoded.** Seal window, street count, per-street durations, action timer, and total match length all come from a hashed, published game template bound into `config_hash` at create.

## Decisions locked
- Authority: hybrid (player = `m.authority`; operator gates lifecycle).
- Clock: hybrid (server gameplay clock; `begin_live` stamps `live_start_ts` and derives `scheduled_end_ts` on-chain).
- Betting: canon multi-round wall-clock, fully configurable (1..N streets, per-game durations).
- Room lifecycle: fill deadline + auto-VOID; auto-start at max, host-start at min; creator seated at create.
- Creation tx: single atomic `[create_match, deposit]`.
- Discovery: matchmaking registry + gateway WS push; new indexer feeds it; replaces operator-create path.
- Anti-grief: off-chain `config_hash` allowlist of published templates.
- Seal integrity: per-seat on-chain time-lock commitment recorded DURING Sealing, gated by on-chain `seal_deadline_ts`; binding-checked at settlement. Backend only decides liveness (who to drop), never timing.
- Seal UX: pre-authorized session key / delegate (signed at deposit) auto-submits the seal commitment with no mid-game wallet popup.
- Randomness: dealer button derived from a drand beacon revealed at seal close (publicly verifiable, no operator grinding); round + value recorded on-chain at `begin_live`.
- Oracle: `oracle_delay_window_sec` configurable, default 1-3s; confidence cap enforced; chosen Pyth update recorded for audit; VOID on ambiguity/outage.

## Greenfield constraint (no legacy support)
This backend is pre-production and has **no users, no live matches, and no legacy data**. Therefore:
- **No migrations, no backwards compatibility, no feature flags to preserve old behavior.** Delete/replace old code paths outright (e.g. the operator-create bootstrap, the per-tier queue bucket, hardcoded timing defaults).
- **Redesign data models freely.** Add fields directly to `MatchAccount`/`CreateParams`/`MatchConfig` and Postgres tables; drop and recreate DB schema rather than writing reversible migrations. A fresh program deploy to devnet is expected on every on-chain change.
- Prefer clean rewrites over incremental adapters. The only thing that must stay intact is the deterministic settlement core in `services/shared` (pot/`S`/tie/oracle logic) - extend it with tests, do not fork it.

## Security model and capital-safety invariants (must hold before mainnet)
This is a real-money product. The threat model assumes a compromised/colluding operator and adversarial players, and treats "lose user funds" or "let a player cheat for profit" as unacceptable. The following invariants are non-negotiable and must be enforced ON-CHAIN, with the backend handling only liveness/orchestration.

### Seal integrity (the prediction can never be added/altered after the outcome could be known)
- **Time-lock concealment (canon 04 §12, §21).** Predictions are time-lock encrypted to a drand round `timelock_target` at match end. Nobody - player, spectator, or operator - can decrypt before that round. There is no key holder. This means a player cannot adapt their number to price movement even if timing were loose.
- **Recorded-before-LIVE (canon 04 §207).** Each player's ciphertext (its hash) MUST be recorded on-chain during SEALING, before `begin_live`. The current program records commitments only after `init_action_log`, which requires `status == Live` ([action_handlers.rs](services/programs/programs/syndicate_program/src/action_handlers.rs) lines 68, 159-189) - this is a real hole and must be fixed by moving commitment recording into the Sealing phase.
- **On-chain seal deadline.** `lock` records `lock_ts`; `seal_deadline_ts = lock_ts + seal_window_sec`. `register_prediction_commitment` is gated to `status == Sealing && Clock::now <= seal_deadline_ts`. `begin_live` requires `Clock::now >= seal_deadline_ts`. So the chain - not the backend - proves "sealed before the game started."
- **Binding check at settlement (canon 04 §207, §273-274).** Each decrypted prediction must equal the exact ciphertext recorded on-chain; recomputation by anyone must reproduce the result, or funds are not released (VOID/escalate).
- **Backend role = liveness only.** The backend may decide to drop non-sealers and continue if `>= min_players` remain (canon §71/§251), but it can never assert that a seal was on time - the on-chain deadline is the source of truth.

### Funds-exit completeness (no state can ever strand capital)
Every capital-in state must have a guaranteed capital-out path that does NOT depend on operator liveness:
- Filling never reaches `min_players` by `fill_deadline_ts` -> permissionless `void_before_start` -> `refund`.
- Sealing with `< min_players` sealed by `seal_deadline_ts` -> VOID -> `refund`.
- Non-sealers dropped at `begin_live` are refunded; remaining must be `>= min_players` or the whole match VOIDs.
- Live but settlement cannot complete by `settle_deadline_ts` (drand or oracle outage, canon §210 ~60s grace) -> permissionless `void_after_deadline` -> `refund`.
- Settled -> `claim`; idempotent, double-claim guarded by `seat.claimed` (canon §184).
- This must be covered by an exhaustive state x exit-path test matrix.

### Operator-compromise containment (defense in depth)
- A stolen `settlement_admin` key CANNOT steal funds: `submit_settlement` recomputes payouts via `services/shared` with conservation checks and re-validates the oracle on-chain, so the operator cannot choose winners or amounts. Worst case is griefing (halt/void).
- Reduce even the grief surface: separate role keys (`config_admin` / `settlement_admin` / `emergency_void_admin` distinct), multisig + hardware custody for production keys, and rate/anomaly monitoring on operator actions.

### Randomness integrity
- Dealer button derives from a drand beacon revealed at seal close (after `seal_deadline_ts`, before `begin_live`): unpredictable during sealing, publicly verifiable, no operator grinding. Replace the current operator-chosen `set_button_seed` (the `vrf_proof_hash` is stored but never verified, lib.rs ~222-240).

### Oracle integrity
- Settlement price = first valid Pyth `PriceUpdateV2` in `[scheduled_end_ts, scheduled_end_ts + oracle_delay_window_sec]`. Keep the window configurable, default 1-3s; enforce the confidence cap; record the exact chosen update so anyone can audit it was the earliest valid one; VOID on ambiguity or outage.

### Finality / reorg
- Seat a player only on a finalized deposit; the indexer and settlement read at confirmed/finalized commitment; never act on unconfirmed state.

## Context for implementers (self-contained)
This section lets a coding agent act without prior chat history.

### What the product is
A real-money, poker-style price-prediction game on Solana. Players join a "match" (a table), each deposits a buy-in (SPL token, e.g. USDC), seals a time-locked price prediction, then plays turn-based betting streets. At a scheduled time the canonical Pyth price is read and the contract settles payouts. The deterministic money/settlement logic lives in `services/shared` and is consumed by the on-chain program and the settlement worker. Canon docs: `04_GAME_MECHANICS_CANONICAL.md` (rules/settlement), `05_GAME_REQUIREMENTS_CANONICAL.md` (player flows).

### Repo + service map (monorepo under `services/`)
- `services/programs/` - Solana Anchor program `syndicate_program` (Rust). Match lifecycle + custody + on-chain settlement verification.
- `services/shared/` - deterministic core (Rust): pot math, settlement (`verify_settlement`), oracle window (`oracle.rs`). Do NOT duplicate this logic elsewhere.
- `services/engine-core/` - pure poker state machine (Rust): `Phase::Live|Settlement|Done`, betting streets, turn order.
- `services/match-engine/` - Rust HTTP service (port 8083) wrapping engine-core with leases, persistence, timers, Redis pub/sub to gateway.
- `services/match-orchestrator/` - stateless Rust HTTP coordinator (port 8086): sequences on-chain lifecycle calls via settlement-chain, then starts match-engine.
- `services/settlement-chain/` - TS service (port 8790): builds/signs/sends Solana txs with the OPERATOR keypair (create/lock/seed/begin-live/void/settle). `src/custody.ts` is the tx builder.
- `services/worker/` + `services/settlement/` - Rust settlement worker: polls due matches, fetches Pyth update, submits `submit_settlement`.
- `services/matchmaking/` - TS service (port 8082): today owns public formation (per-tier Redis buckets) + private rooms, fill-deadline `DeadlineWorker`, deposit verification.
- `services/gateway/` - TS WebSocket server: wallet auth (ed25519 challenge), relays player intents to match-engine, fans out match-engine Redis events to clients.
- `services/action-feed/` - TS service: public spectator feed + `/active-games` (LIVE only), match history.
- `services/config/` - TS service: tier/match config catalog; `bindConfig()` computes `config_hash` (SHA-256 over canonical JSON).
- `services/timelock/`, `services/trust-safety/`, `services/store/` - drand timelock, abuse enforcement, Postgres schema/queries.
- Infra: Postgres, Redis, NATS, MinIO, Prometheus, Grafana via `deploy/docker-compose.localnet.yml`; app services via `deploy/docker-compose.app.yml`.

### Current on-chain lifecycle (what exists today, to be changed)
Program: `services/programs/programs/syndicate_program/src/lib.rs` + `state.rs`.
- `MatchStatus` enum: `Filling -> Sealing -> Live -> Settled` (+ `Void`).
- `create_match(params)` - **gated to `config_admin`** (operator). Stores `m.authority = signer`, all economics, `m.config_hash`, `m.scheduled_end_ts` (passed in by caller, NOT derived), oracle params. Creates the match PDA `["match", match_id]` and vault `["vault", match]`.
- `deposit(seat_index)` - **player-signed**; creates `SeatAccount` `["seat", match, player]` + `SeatIndexAccount`; transfers buy_in+entry_fee to vault; increments `player_count`. Only while `Filling`.
- `lock` / `set_button_seed` / `begin_live` - **operator** (`settlement_admin` OR `config_admin`). `lock` requires `player_count >= min_players`. `begin_live` only flips status; **does NOT record a timestamp** today.
- Action-log instructions (`init_action_log`, `append_player_action`, `append_timeout_action`, `finalize_action_log`) drive on-chain gameplay record; `ActionLog` holds `scheduled_end_ts` + `settle_deadline_ts`.
- `submit_settlement` - `settlement_admin`; validates Pyth `PriceUpdateV2` against `m.price_feed_id` and the window `[scheduled_end_ts, scheduled_end_ts + oracle_delay_window_sec]` via `services/shared/src/oracle.rs`; writes per-seat payouts; status -> `Settled`.
- `claim` (player, after Settled), `refund` (player, after Void), `void` (`emergency_void_admin`), `void_after_deadline` (permissionless, when `clock >= settle_deadline_ts`).
- Key fact: lifecycle gates check `ProtocolState` ROLE pubkeys, never `m.authority`. So making the player the authority does not, by itself, give them lifecycle power - the operator monopoly is preserved automatically.

### Current timing reality (the gap this plan closes)
- `engine-core` starts a match **already in `Live`** with `round: 1`; `round` is a betting-street counter advanced when a street closes, NOT a wall clock. There is no SEALING phase in the engine and no match-length timer.
- `match-engine` has only a per-action timer (`action_timeout_ms`, hardcoded default `25_000`) polled by `timeout_loop` in `server.rs`. On timeout it applies a player's pre-registered default action (canon 8).
- `config/src/index.ts` already defines `roundDurationsSec: [240,180,180]`, `roundCount: 3`, `actionTimerSec: 25`, `timeBankSec`, `settlementWindowSec`, `fillWindowSec`, but the engine **ignores** durations (only `roundCount` is passed through). There is **no `sealWindowSec`**. `timelockTargetRound` is a placeholder `1_000_000`.
- `scheduled_end_ts` defaults to `now + 3600` in `services/settlement-chain/src/custody.ts` and is used ONLY as the Pyth oracle window anchor, not to end gameplay.

### Current creation/discovery reality (to be replaced)
- Creation today: matchmaking -> `orchestrator /internal/formations/bootstrap` -> settlement-chain `create-match` signed by the OPERATOR. Players never sign creation. `onchain_match_id = hash_match_id(uuid)`.
- Public matchmaking = one implicit forming table per `(tier, feed, token, rating-bucket)` in Redis; private = invite-by-`roomCode`. **There is no "browse joinable rooms" surface.** `action-feed /active-games` lists only LIVE games.
- Gateway pushes no `serverTime`; it synthesizes `yourTurn.deadline = Date.now()+25000` in `relay.ts`.

### Key ports / channels
- Redis match event channel: `match:{matchId}` (match-engine publishes; gateway subscribes).
- Service ports: matchmaking 8082, match-engine 8083, orchestrator 8086, settlement-chain 8790, gateway WS, action-feed read API 8080.
- Wire protocol types: `docs/frontend/protocol.ts`; integration: `docs/frontend/INTEGRATION_GUIDE.md`.

## Target lifecycle and timing

```mermaid
sequenceDiagram
  participant Host as Host wallet
  participant Chain as Solana program
  participant Idx as Indexer
  participant MM as Matchmaking registry
  participant GW as Gateway
  participant Joiner as Joiner wallet
  participant Orch as Orchestrator
  participant ME as Match-engine

  Host->>Chain: tx [create_match + deposit] (config_hash = template)
  Chain-->>Idx: MatchAccount(Filling) + Seat
  Idx->>MM: upsert room (allowlisted hash only)
  MM-->>GW: roomsUpdated (live browse feed)
  Joiner->>Chain: tx deposit (join)
  Chain-->>Idx: Seat added
  Idx->>MM: seat count++
  Note over MM: host-start at >=min OR auto at max OR fill-deadline
  MM->>Orch: start-policy(start)
  Orch->>Chain: lock (t=0, status Sealing, records lock_ts + seal_deadline_ts)
  Note over GW,ME: SEALING window (server countdown)
  Joiner->>Chain: register_prediction_commitment (session key, gated clock<=seal_deadline_ts)
  Host->>Chain: register_prediction_commitment (session key)
  Note over Chain: drand beacon at seal close -> button (verifiable)
  Orch->>Chain: begin_live (clock>=seal_deadline; drop+refund non-sealers; VOID if <min; stamp live_start_ts; derive scheduled_end_ts + button)
  Orch->>ME: start(live_start_ts, template timing)
  Note over ME,GW: BETTING streets (wall-clock) until scheduled_end_ts
  ME->>Chain: (worker) submit_settlement (oracle window + time-lock binding check)
```

Timeline (example template: seal 20s, streets [240,180,180]):
- `t=0` = `lock` -> SEALING; on-chain `lock_ts = now`, `seal_deadline_ts = now + 20`.
- `t=0..20` = each seated player records their time-lock ciphertext hash on-chain via the pre-authorized session key (no popup); program rejects any commitment after `seal_deadline_ts`.
- `t=20` = `begin_live` -> requires `now >= seal_deadline_ts`; drops + refunds non-sealers (VOID if `< min_players`); derives button from the drand beacon revealed at seal close; stamps `live_start_ts = now`, `scheduled_end_ts = now + 600`. BETTING begins.
- `t=20..620` = wall-clock streets; per-street deadline = `live_start_ts + cumulative durations`; turn timer `actionTimerSec` within a street; expiry auto-resolves pending actors via registered defaults; optional observation window between streets.
- `t>=620` = oracle window opens (default 1-3s); `submit_settlement` validates the chosen Pyth update and binding-checks each decrypted prediction against its on-chain commitment -> settlement -> claim.
- Any blocked path (under-min, drand/oracle outage past `settle_deadline_ts`) -> permissionless VOID -> refund.

## Workstream A: On-chain program changes
File: [services/programs/programs/syndicate_program/src/lib.rs](services/programs/programs/syndicate_program/src/lib.rs), [state.rs](services/programs/programs/syndicate_program/src/state.rs)
- Relax `create_match`: remove the `config_admin` gate (lib.rs ~95-98); allow any signer; keep `m.authority = signer` (lib.rs ~112) and all param/economic validation.
- Atomic create+deposit: clients submit one tx containing `[create_match, deposit]` (vault is created by `create_match`, consumed by `deposit` in the same tx). A convenience `create_and_deposit` instruction is acceptable since there is no legacy client to support.
- `MatchAccount` new fields: `live_start_ts: u64`, `total_betting_duration_sec: u64` (bound at create), `seal_window_sec: u64`, `fill_deadline_ts: u64`, `lock_ts: u64`, `seal_deadline_ts: u64`, `button_round: u64` (drand round used for the button), `oracle_update_key: Pubkey` (chosen Pyth update, recorded for audit). Greenfield: add fields directly and bump `SPACE` / redeploy; no need to squeeze into `reserved`.
- `CreateParams`: replace `scheduled_end_ts` with `total_betting_duration_sec` + `seal_window_sec` + `fill_deadline_ts`; keep `oracle_delay_window_sec` configurable (default 1-3s). All bound inside `config_hash`.
- `lock`: record `m.lock_ts = Clock::now`, `m.seal_deadline_ts = lock_ts + seal_window_sec`; status `Filling -> Sealing` (still requires `player_count >= min_players`).
- **Move seal commitment into Sealing (fixes the §207 hole).** Make `register_prediction_commitment` operate on the `MatchAccount`/`SeatAccount` (not the post-Live `ActionLog`); gate it to `status == Sealing && Clock::now <= m.seal_deadline_ts`; store the ciphertext hash + `timelock_target` on the seat. Signed by the player (Ed25519) - works via the pre-authorized session key (Workstream I).
- `begin_live` (lib.rs ~243-255): require `Clock::now >= m.seal_deadline_ts`; drop seats without `commitment_set` and mark them refundable; require remaining sealed seats `>= min_players` else transition to VOID; derive `m.button` from the drand beacon at `m.button_round` (verifiable) instead of an operator seed; stamp `m.live_start_ts = now`, `m.scheduled_end_ts = now + m.total_betting_duration_sec`. This makes the Pyth settlement window (`shared/oracle.rs`) trustless and tied to real game start.
- Replace `set_button_seed`: button comes from drand (above); remove the unverified operator seed path (lib.rs ~222-240). If a transitional instruction is needed it must verify the drand signature on-chain.
- `submit_settlement`: in addition to existing oracle + conservation checks, enforce the time-lock binding check (each decrypted prediction equals the on-chain-recorded ciphertext for that seat) and record `m.oracle_update_key`. Reject (VOID/escalate) on mismatch.
- Add permissionless `void_before_start`: if `Clock::now >= m.fill_deadline_ts` and status still `Filling`, anyone can void -> trustless refunds for abandoned rooms (mirrors existing `void_after_deadline`).
- Funds-exit completeness: ensure refund paths exist for every VOID origin (under-min at fill, under-min sealed, dropped non-sealers, settlement outage); cover with an exhaustive state x exit test matrix.
- Keep `lock`/`begin_live`/`submit_settlement` operator-gated; seal commitment is player-gated. This preserves the operator monopoly on progression while keeping seal timing trustless.

## Workstream B: New indexer service
New service `services/indexer/` (Rust, alongside settlement worker, or TS):
- Subscribe to program via `accountSubscribe`/`logsSubscribe` (or Geyser/Helius stream) for near-instant pickup of new `MatchAccount`/`SeatAccount`.
- Idempotent upserts keyed by match PDA into Postgres + Redis registry; maintain a slot cursor/checkpoint; polling `getProgramAccounts`-by-discriminator reconciler as backstop; basic reorg tolerance.
- Allowlist gate: only project matches whose `config_hash` is in the published template set (from config service); ignore unknown-config matches.
- Emit `roomCreated` / `roomUpdated` / `roomSettled` events to gateway (via Redis) for the live browse feed.
- Track full lifecycle (`Filling`/seat/`Sealing`/`Live`/`Settled`/`Void`) so read models never drift from chain.

## Workstream C: Config -> game-template catalog
File: [services/config/src/index.ts](services/config/src/index.ts), [table-terms.ts](services/config/src/table-terms.ts)
- Generalize tiers into versioned, hashed **game templates**. Add `sealWindowSec`, `streetCount`, `observationWindowSec`; require `roundDurationsSec.length === streetCount` (1..N). Total betting = `sum(roundDurationsSec)`.
- Support multiple coexisting templates (e.g. 2-min/1-street, 5-min/3-street). `bindConfig`/`canonicalize` already hash the whole config; ensure all new timing fields are included.
- Expose `GET /config/templates` and a `config_hash -> template` map consumed by the indexer (allowlist) and by clients (to build the create tx params).
- Derive `timelockTargetRound` from match end (drand) instead of the `1_000_000` placeholder.

## Workstream D: Match-engine wall-clock rounds
File: [services/match-engine/src/server.rs](services/match-engine/src/server.rs), [service.rs](services/match-engine/src/service.rs), [engine-core/src/lib.rs](services/engine-core/src/lib.rs)
- Extend `MatchConfig` with `live_start_ts`, `seal_window_sec`, `round_durations_sec: Vec<u64>`, `observation_window_sec`, `action_timeout_ms` (no hardcoded 25s default path).
- Add a wall-clock round driver to the existing `timeout_loop` (server.rs ~183-229): per-street deadline = `live_start_ts + cumulative durations`; on street-clock expiry, auto-resolve all pending actors via registered defaults, run observation window, then `advance_street`. Keep turn-based actions within a street using `action_timeout_ms`.
- Match end at `scheduled_end_ts` (not only "betting complete") -> `complete_match` -> settlement enqueue ([coordinator.rs](services/match-engine/src/coordinator.rs)).
- Publish absolute deadlines in `matchState`/`yourTurn` (`sealEndsAt`, `streetEndsAt`, `matchEndsAt`, `yourTurnDeadline`) instead of the gateway-synthesized `Date.now()+25000`.

## Workstream E: Matchmaking -> registry + start-trigger
File: [services/matchmaking/src/formation.ts](services/matchmaking/src/formation.ts), [main.ts](services/matchmaking/src/main.ts), [deadline-worker.ts](services/matchmaking/src/deadline-worker.ts), [orchestrator-client.ts](services/matchmaking/src/orchestrator-client.ts)
- Remove operator-create bootstrap (`bootstrapFormation` -> `create-match`). Matchmaking no longer creates matches.
- New responsibilities: serve the indexer-fed open-rooms registry; `GET /rooms?feed=&template=&buyIn=` filterable list; `join` returns match PDA + next seat index for the client to sign a deposit; host-start trigger; fill-deadline worker (auto-start at max, host-start at >=min, auto-void if <min at `fill_deadline_ts`).
- Keep `triggerStartPolicy` -> orchestrator for lock/seed/begin_live/engine-start.

## Workstream F: Gateway clock-sync + discovery feed
File: [services/gateway/src/relay.ts](services/gateway/src/relay.ts), [server.ts](services/gateway/src/server.ts)
- Clock sync: include `serverTime` in pong/envelopes so clients compute an offset and render identical countdowns; stop synthesizing deadlines (relay.ts ~172-179) and forward engine absolute deadlines.
- Discovery: add `roomsUpdated`/`lobbyList` push fed by indexer/matchmaking so the browse screen updates with no polling lag; keep action-feed `/active-games` for LIVE spectating.

## Workstream G: Orchestrator slimming
File: [services/match-orchestrator/src/main.rs](services/match-orchestrator/src/main.rs)
- Remove `/internal/formations/bootstrap` create path. Keep `/internal/start-policy` (lock -> set_button_seed -> begin_live -> match-engine start) and void.
- Pass template timing + `live_start_ts` into the match-engine `start` body.

## Workstream H: Client/integration + settlement
- Client builds and signs the atomic `[create_match, deposit]` tx using template params from `GET /config/templates`; join = a single `deposit` tx; subscribe for clock-synced countdowns. Update [docs/frontend/INTEGRATION_GUIDE.md](docs/frontend/INTEGRATION_GUIDE.md) and [docs/frontend/protocol.ts](docs/frontend/protocol.ts).
- Settlement: `scheduled_end_ts` now derived on-chain at `begin_live`; the indexer writes it to Postgres so the settlement worker/timelock read real values (replaces the `now+3600` default in [services/settlement-chain/src/custody.ts](services/settlement-chain/src/custody.ts)).

## Workstream I: Sealing, time-lock, randomness, session keys
Files: [services/timelock/](services/timelock), [services/match-engine/src/coordinator.rs](services/match-engine/src/coordinator.rs), [services/programs/programs/syndicate_program/src/action_handlers.rs](services/programs/programs/syndicate_program/src/action_handlers.rs), client.
- Session keys: at deposit, the player signs a scoped delegation authorizing a client-held ephemeral key to submit ONLY `register_prediction_commitment` for that match/seat. Client auto-submits the seal commitment during the window with no popup. Scope must be minimal (one instruction, one seat, expires at `seal_deadline_ts`).
- Time-lock encrypt: client encrypts the prediction to `timelock_target` (drand `tlock`), submits the ciphertext to the timelock/match-engine for storage + records the ciphertext hash on-chain. Off-chain stores the full ciphertext; on-chain stores only the hash + target round.
- `timelock_target` derivation: compute from projected match end (`live_start_ts + total_betting_duration_sec`) + margin so the round publishes after match end; never the `1_000_000` placeholder. Validate the round is far enough out that it cannot publish before `seal_deadline_ts`.
- Drand button: pick a beacon round that publishes just after `seal_deadline_ts`; at `begin_live` read its randomness and derive the button on-chain; record `button_round`. Anyone can re-verify.
- Decrypt + binding at settlement: after the match-end round publishes, the timelock service decrypts all ciphertexts; the settlement worker passes decrypted predictions to `submit_settlement`, which binding-checks each against the on-chain commitment.
- Drand liveness (canon 04 §210): if the decryption key is unavailable beyond a configurable grace (~60s), VOID + full refund via the permissionless deadline path. Implement and test the outage path.
- Non-sealer handling: match-engine/matchmaking reports who sealed; orchestrator drives `begin_live` which drops+refunds non-sealers (chain-enforced) and VOIDs if `< min_players`.

## Security / anti-grief summary
- Permissionless create + allowlisted `config_hash`: junk rooms are ignored by the registry and never serviced by the operator; only refund/void applies.
- Operator monopoly on `lock`/`begin_live`/`submit_settlement` + oracle verification = funds released only on verified settlement.
- `fill_deadline_ts` + permissionless `void_before_start` = trustless refunds for abandoned rooms.
- On-chain `live_start_ts`/`scheduled_end_ts` = trustless settlement window even though gameplay timing is server-driven.

## Open risks to validate during build
- Indexer latency/reorgs on devnet (websocket gaps) -> reconciler + checkpoint required.
- `MatchAccount` layout change -> just bump `SPACE` and do a fresh devnet deploy (no existing matches to migrate).
- Atomic `[create_match, deposit]` tx size/compute budget with Pyth + token accounts; if it exceeds limits, fall back to a single `create_and_deposit` instruction.
- Wall-clock vs turn-based fairness: ensure registered default policies AND seal commitments exist before SEALING ends so street-expiry auto-resolution and the binding check are always possible (canon 8, §207).
- Session-key scope creep: the delegation must be tightly scoped (one instruction, one seat, expiring at `seal_deadline_ts`) or it becomes a key-theft vector. Security-review this carefully.
- Drand availability is now a settlement dependency (button + decrypt): the ~60s grace -> VOID path must be implemented and tested, and beacon source pinned (League of Entropy).
- Oracle selection residual: even with a 1-3s window, document and monitor that the chosen update is auditable as the earliest valid one.
- Plan a third-party security audit of the program + settlement core before mainnet (capital at risk).

## Suggested build order
1. Workstream C (templates) + Workstream A (program, including seal-during-Sealing, drand button, oracle, void coverage) - everything downstream binds to the template/`config_hash` and on-chain timing/integrity.
2. Workstream I (sealing, time-lock, session keys, randomness) - co-developed with A since the seal commitment + button live on-chain.
3. Fresh devnet deploy of the program; regenerate the IDL/client used by settlement-chain.
4. Workstream B (indexer) - stand up the chain->registry projection.
5. Workstream E + F (matchmaking registry + gateway discovery/clock) and Workstream G (orchestrator slim).
6. Workstream D (engine wall-clock rounds).
7. Workstream H (client integration + settlement wiring).
8. Exhaustive funds-exit + seal-integrity test matrix on devnet; then schedule the external security audit before mainnet.
