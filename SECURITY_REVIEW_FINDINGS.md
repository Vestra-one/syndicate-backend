# Security Review — Syndicate Backend

_Senior security engineering review. Date: 2026-06-28._

**Scope:** Anchor on-chain program (`services/programs`), the shared deterministic settlement crate (`services/shared`), the poker engine (`services/engine-core`), randomness/time-lock (`services/timelock`), and all off-chain services (settlement, match-engine, worker, gateway, matchmaking, action-feed, trust-safety, store, config, settlement-chain).

**Trust model (read this first):** The on-chain program is the sole custody gate. It re-derives settlement from an on-chain action log + Pyth oracle and only releases funds if conservation holds. So fund safety ultimately rests on three on-chain primitives: (1) the Ed25519 signed-intent verifier, (2) the prediction-commitment binding hash, and (3) the conservation check. **All three have defects.** That makes the headline findings genuinely fund-affecting, not just UX.

---

## 🔴 CRITICAL

### C1. Ed25519 verifier doesn't pin the instruction-index fields → signed-intent forgery
`services/programs/src/ed25519_sysvar.rs:42-76`

The verifier reads the pubkey and message from offsets **within the Ed25519 instruction's own data** (`data[pubkey_offset..]`, `data[msg_offset..]`) but never validates the three instruction-index fields in the offsets struct: `signature_instruction_index` (bytes 4-5), `public_key_instruction_index` (8-9), `message_instruction_index` (14-15). The native Ed25519 program uses those indices to decide *which instruction's data* it actually verifies. The legit builder sets them to `0xffff` (`services/settlement-chain/src/actionLog.ts:38-43`), but an attacker is free to point them at a *different* instruction.

**Exploit:** craft an Ed25519 instruction whose index fields reference a second instruction containing `(attacker_pubkey, attacker_message, valid_attacker_signature)` — the native program verifies the attacker's own valid signature — while this code reads the *victim's* pubkey and the *expected* message from bytes the attacker placed at the offsets in the Ed25519 instruction. Both checks pass; no victim signature ever existed.

This is the classic Ed25519 introspection pitfall. Because `register_prediction_commitment` (`services/programs/src/lib.rs:798-812`) and `register_default_policy` (`services/programs/src/lib.rs:782-796`) only require `player: Signer` with **no check that the signer owns the seat**, any attacker can forge a prediction commitment or default policy for **any seat**, directly determining who wins (prediction = winner selection in `services/shared/src/settle.rs:130-156`).

**Fix:** require all three instruction-index fields == `u16::MAX` (or the ed25519 ix's own index), i.e. force the signed data to be self-contained, and add `require_keys_eq!(ctx.accounts.player.key(), log.seats[idx].player)` to both register handlers.

### C2. Prediction-commitment binding uses a non-cryptographic hash
`services/shared/src/intent.rs:107-138` (`prediction_commitment_hash` → `simple_sha256`, an "FNV-1a expanded to 32 bytes"), used on-chain at `services/programs/src/settle_args.rs:131-134` and off-chain at `services/settlement/src/lib.rs`.

The reveal check is `hash(prediction, blinding) == commitment`. `simple_sha256` is a structured xor/multiply construction with four independent lanes consuming the same word stream — **no preimage/collision resistance**. The attacker controls all 32 bytes of `blinding` (256 bits of freedom against a 256-bit target). This defeats the *binding* of the commitment: a player can register a commitment, wait for the oracle settlement price `S` to be revealed, then at settlement reveal a *different* prediction ≈ `S` with a blinding that reproduces the committed hash — guaranteeing they win. The time-lock scheme (`services/timelock`) is sound, but it protects *confidentiality*; this hash is what protects *integrity*, and it doesn't. The code comment even says "Production uses sha2" — but the path actually executed uses `simple_sha256`.

`chain_hash` (the action-log `head`/`event_root` integrity chain) has the same problem: `DefaultHasher` (SipHash, fixed zero key) for 8 bytes + 24 bytes of trivially-malleable XOR'd payload.

**Fix:** use SHA-256 (`sha2` is already a dependency, see `services/worker/src/timelock_open.rs:247`) for both the commitment hash and the chain hash, in `shared`, the program, and the TS reproduction — they must stay byte-identical.

### C3. On-chain conservation is incompatible with the game model → real games cannot settle
`services/programs/src/lib.rs:405-441`

`submit_settlement` requires `paid == m.total_deposited`, where `total_deposited = buy_in × player_count` (`services/programs/src/lib.rs:192-195`) and `paid = pot_awards + uncalled_returns + rake`. But `settle()` distributes only chips **contributed to pots** (`services/shared/src/settle.rs:48-96`); it never returns a player's **uncommitted remaining stack**. The canonical rules confirm players keep remaining stacks (`04_GAME_MECHANICS_CANONICAL.md:76`: VOID refunds "remaining stacks + contributions") and the project's own golden vector is a *limped showdown* where each player contributes 2 of a 100-chip buy-in (`golden/showdown_3handed.json`, `BUY_IN = 100` at `services/programs/litesvm-tests/tests/common/mod.rs:33`).

So for that scenario: `paid = 6`, `total_deposited = 300` → **`ConservationViolation`**. Any match that doesn't end with every player all-in or fully committed will fail to settle and can only VOID. And critically, the off-chain builder *cannot* fix this by adding remaining-stack returns, because `verify_settlement` requires `recomputed == claimed` exactly (`services/shared/src/settle.rs:106-113`) and `settle()` won't produce those returns. The on-chain happy-path test masks this (it only checks pure-contribution conservation via `services/programs/litesvm-tests/tests/golden_parity.rs:70-117`, never `submit_settlement` with leftover stack).

**Fix:** `settle()` must add each non-folded player's `deposit − contribution` to their returns so `Σpaid == Σdeposits`, and the engine→settlement bridge must carry per-seat remaining stack. (Funds aren't lost — VOID refunds — but no real game can pay winners.)

### C4. Ed25519 verifier rejects the standard native instruction (accounts check)
`services/programs/src/ed25519_sysvar.rs:32-40`

It requires `!ix.accounts.is_empty()` and `ix.accounts[0] == INSTRUCTIONS_SYSVAR_ID`. But the native Ed25519 program instruction carries **zero accounts** — confirmed by both the legit TS builder (`keys: []`, `services/settlement-chain/src/actionLog.ts:49`) and the test harness (`accounts: vec![]`, `services/programs/litesvm-tests/tests/common/mod.rs:109`). As written, **every** `append_player_action` / `register_*` call fails with `InvalidSignature` — the entire signed-action path is non-functional (or the litesvm tests covering it are not actually passing, contradicting the "tested in CI" header). This is a hard liveness break independent of C1.

**Fix:** remove the accounts check entirely (the native program needs no accounts; the verifier already pins `program_id == ED25519_PROGRAM_ID`).

---

## 🟠 HIGH

### H1. Match-engine: any wallet can submit actions for any seat (no seat→wallet binding)
`services/match-engine/src/service.rs` (`validate_intent`, ~L518-558) + `server.rs` (`build_config`, ~L564-578). The signed intent binds `seat_index` + the *signer's own* pubkey, and `MatchConfig.players` drops the per-seat wallet — so a valid signature over the attacker's own key for any `seat_index` verifies. An attacker can fold/raise on a victim's behalf in the live engine, or plant a default policy. The on-chain action log is separately gated, but the off-chain head that gets finalized is corruptible. **Fix:** store each seat's authorized wallet and assert `intent.wallet == players[seat].wallet` before signature verification.

### H2. Match-engine: production lease authorizer is empty → fencing broken / actions fail
`services/match-engine/src/coordinator.rs` (L80/100/119) vs `server.rs` (L48-51). Default `MATCH_ENGINE_POSTGRES_LEASES=true` acquires the lease in Postgres but never populates `memory_leases`, which `apply_action`/`apply_timeout` consult. Either every action errors (`LeaseMismatch`) or the single-writer guarantee is not re-validated at apply time → **split-brain** (two engines applying to the same match). **Fix:** use a `PostgresLeaseCoordinator` as the authorizer and re-validate the fencing token at apply time.

### H3. Match-engine dev-signature & seal bypasses reachable in prod
`services/match-engine/src/service.rs` L540-541/757-768: `SYNDICATE_ALLOW_DEV_SIGNATURES=1` accepts any signature starting `"sig-"`. `server.rs` `seal_match` (L479-537) defaults wallet/seal_seq/signature and **returns 200 even when the seal fails**, and lets a caller attribute a commitment to another `player_id`. **Fix:** gate dev signatures behind a non-default compile feature; require+verify wallet/sig on seal and propagate failure.

### H4. Settlement: row lock released inside `begin_attempt` → concurrent double-submit
`services/settlement/src/ops/pg_store.rs:119-142` commits the transaction (releasing `FOR UPDATE`) before the status-check/build/send critical section in `ops.rs`. Two redelivered NATS messages or two replicas can both observe `Pending` and both submit on-chain. `MARK_SETTLEMENT_SUBMITTED_SQL`/`..._VOIDED_SQL` have no status precondition (`services/store/src/postgres.rs` ~L185/229), so a late worker can overwrite a `confirmed` row. The on-chain program is the only backstop. **Fix:** hold the lock across the whole critical section, or make state transitions conditional `UPDATE ... WHERE status IN (...)` and treat 0 rows as "not mine".

### H5. Settlement: transient RPC failure force-VOIDs a settleable match with a fabricated reason
`services/settlement/src/ops.rs` `retry_or_refund` (~L646-695): after N transport failures it submits `build_void_match(.., OracleDegraded)` even for a valid `Settled` bundle — refunding everyone and discarding the legitimate result (and lying about the reason). **Fix:** never auto-void a `Settled` outcome on transport failure; dead-letter for operator/extended backoff.

### H6. Worker: reconstruction trusts DB-stored commitment/blinding without re-verifying the signature
`services/worker/src/reconstruct.rs` (`PredictionSealed` is a no-op in replay; `seal_registry_from_events` copies `commitment`/`blinding` straight from the persisted event). The hash chain proves "these bytes were written," not "the wallet signed them." Combined with C2, anyone with events-table write access can substitute a prediction. Also `timelock_target_round` is taken from the untrusted NATS message and only cross-checked if a `MatchCompleted` event exists (`reconstruct.rs:33-34,333-337`); a forged small round can already have a published beacon → early opening / confidentiality break. **Fix:** re-run `verify_prediction_commitment` during reconstruction; derive `target_round` only from the validated `MatchCompleted` event.

### H7. Gateway auth: bare-nonce signature, no domain/wallet/expiry binding; wallet self-comparison is a tautology
`services/gateway/src/` `index.ts:44` + `verifier.ts:74` + `server.ts:157`. The signed message is a raw UUID with no domain separation, audience, wallet, or expiry — replayable from any other context where the wallet signs an opaque value; the user never sees what they authorize. The `wallet !== n.wallet` check compares a client-supplied field to itself. **Fix:** sign a structured, domain-separated message binding wallet + nonce + expiry; verify identity from the signature, not an echoed field. Add a WS `Origin` allowlist (none today, `server.ts:85-87`).

### H8. Matchmaking & money endpoints unauthenticated; deposit gate bypassable
`services/matchmaking/src/main.ts` (no auth; trusts `body.wallet/host/seatIndex/tierId/txSignature`). `hostStart` authorizes on a client-supplied `host` string returned in the lobby payload (`formation.ts:172`). Deposit verification is fabricated `ok:true` when no RPC is configured or `buyIn===0` (`formation.ts:346-347`), and the pending-deposit cache is keyed by `txSignature` only (`formation.ts:336-338`) so one real deposit can seat across multiple matches/wallets. Separately, `services/matchmaking/src/deposit-verify.ts:61-77` only checks the wallet appears in `accountKeys` (not that it signed) and never verifies amount/destination/match. **Fix:** require gateway-minted signed sessions; derive tier/feed from stored table state; key deposits by `(matchId, wallet, txSignature)` and treat each on-chain deposit as single-use; verify amount + vault destination on-chain.

### H9. Action-feed: unauthenticated profile takeover + arbitrary file read
`services/action-feed/src/server.ts:81-91`: `PUT /profiles/me` trusts `body.wallet` with no auth → anyone overwrites any wallet's handle/avatar. `services/action-feed/src/object-store.ts:59-64`: `getJsonByUri` does `readFile(fileURLToPath(uri))` with **no confinement to `rootDir`** — a `file://` URI reaching it via `replayBundleUri` yields arbitrary host file read (e.g. key material) on `GET /matches/<id>/replay`. **Fix:** derive `wallet` from an authenticated principal; confine read paths to `rootDir` and only accept `file:` URIs you generated.

---

### H10. Start path issues `lock`→`begin_live` with no sealing window → can't go Live
Orchestrator `/internal/start-policy` (`services/match-orchestrator/src/main.rs:135-248`) calls `lock-match` then `begin-live` synchronously. But `lock` sets `seal_deadline_ts = now + seal_window_sec` (~20s default, `services/programs/src/lib.rs:322-324`) and `begin_live` requires `now >= seal_deadline_ts` (`lib.rs:352`). Called milliseconds after lock it reverts `SealDeadlineNotReached`; on real custody the start path 502s, and in stub mode the error is swallowed (`main.rs:343`). No scheduler defers `begin_live` to the seal deadline (confirmed `formation.ts:47`: "only call left is the start trigger"). **Fix:** drive `begin_live` from a seal-deadline worker that fires in `[seal_deadline, seal_deadline+begin_live_window]`, not inline after `lock`.

### H11. Off-chain seal and on-chain commitment are disconnected → every match VOIDs
Gateway `sealPrediction` posts only to the engine's off-chain `SealRegistry` (`services/gateway/src/relay.ts:95-97`). `begin_live`/settlement classify sealers solely by on-chain `seat.commitment_set`, set only by `register_prediction_commitment` (`services/programs/src/action_handlers.rs`). Nothing in the live flow makes the player sign that on-chain ix — settlement-chain only exposes an unused `register-commitment` preview. So on-chain `sealed_count` stays 0 → `under_min` always true → `UnderMinSealed` VOID at `begin_live` (`lib.rs:435,468`). **Fix:** wire the seal to submit the player-signed on-chain commitment, or have `begin_live` consume the engine's seal set.

### H12. Engine seat set ≠ on-chain Live seat set → settlement misindex/revert
Engine is started with ALL depositors (`input.players` = full `table.seats`, `main.rs:215-220`), `PlayerId` 0..n. `begin_live` drops non-sealers and re-indexes sealers to contiguous `engine_seat` 0..sealed_count-1 (`lib.rs:440-447`), and `submit_settlement` requires `payouts.len() == sealed_count` and `engine_seat < sealed_count` (`lib.rs:543,547,572`). But `compute_seat_payouts` emits `engine_seat: player.id.0` over every engine player (`services/settlement/src/ops.rs:1181`). When a match goes Live with `sealed_count < player_count`, payout count/indices diverge from on-chain → settlement reverts (or, if lengths coincide, mispays). Currently shadowed by H11 (no match goes Live); surfaces the moment H11 is fixed. (At exactly `min_players` it degenerates to all-seal-or-void.) **Fix:** start/replay the engine with only the on-chain sealer set, in `engine_seat` order.

## 🟡 MEDIUM

- **M1. Protocol-init front-running.** `initialize_protocol` (`services/programs/src/lib.rs:49-73`) is permissionless `init` on a singleton PDA; whoever calls first sets all admin roles. If not initialized atomically with deployment, an attacker front-runs it and seizes full control of all matches/funds. Initialize in the deploy transaction or gate to the program's upgrade authority.
- **M2. Admin-chosen randomness, no on-chain VRF verification.** `set_button_seed` (`services/programs/src/lib.rs:223-241`) records `vrf_proof_hash` but never verifies it; the button is `seed % player_count` with `seed` fully admin-supplied → grindable. Acceptable only under a fully-trusted-operator model; document it, or verify a real VRF proof.
- **M3. Settlement idempotency-key collision** (`services/settlement/src/ops.rs:496-512`): `begin_attempt` `ON CONFLICT DO UPDATE` returns the stored row without asserting `job.event_root == stored.event_root`; a reused key short-circuits to "final" and the corrected settlement is never submitted. Reject on `event_root` mismatch.
- **M4. Oracle window enumeration is an unbounded fetch loop** (`services/settlement/src/ops.rs` `fetch_updates`, ~L963-997): one blocking HTTP call per second over `scheduled_end_ts..=window_end` with no cap on `oracle_delay_window_sec` → DoS/retry-storm against Hermes. Clamp the window.
- **M5. Match-engine HTTP body read is a single 64 KiB `read`** (`services/match-engine/src/server.rs:167-181`): no Content-Length loop, no size cap, no read timeout → truncated bodies and slow-loris. `/internal/*` routes are unauthenticated (`server.rs:234-354`) and `start_match` is fully attacker-controlled if reachable. Add framing, caps, timeouts, and a shared secret/mTLS.
- **M6. Match-engine timeout loop holds the global `runtimes` mutex across DB/Redis awaits** (`services/match-engine/src/server.rs:183-232`): one slow match blocks all matches; a player who never registers a default cannot be timed out → indefinite stall/griefing. Snapshot IDs, per-match lock, hard server-side fold default.
- **M7. Action-feed outbox `JSON.parse` with no schema validation** (`services/action-feed/src/projector.ts:375`): a malformed/poisoned row can set `timelockOpen:true` (early prediction reveal via WS), inject huge numbers, or crash the whole batch (`runOnce` throws). Validate every message; dead-letter on failure. The `timelockOpen` flag should be computed from match state, not trusted from the event.
- **M8. Action-feed projector builds SQL by string interpolation through `psql -c`** (`services/action-feed/src/projector.ts:123-223`): relies on hand-rolled `'`-doubling for `feed`/`summary`/`lastError`. Fragile for a settlement-adjacent path; use bind parameters.
- **M9. Gateway: no per-message rate limit or `maxPayload`; `subscribe` has no authorization** (`services/gateway/src/relay.ts:44-62`, `server.ts:84`): an authenticated client can subscribe to any match (cross-table info leak), grow `matchWatchers` unboundedly (no unsubscribe/disconnect cleanup), and amplify each WS message into internal `fetch`es. Authorize subscriptions against seat membership; cap and clean up.
- **M10. Geofence fails open on spoofable headers** (`services/gateway` / `services/matchmaking/src/main.ts:60-62`): country from `x-syndicate-country` etc., defaults to `'ZZ'` = allowed. Strip client geo headers at the edge; fail closed.
- **M11. Hand-rolled RESP parser in `services/gateway/src/redis.ts:137-159`** can't handle nested arrays / null-bulk, corrupting `ZRANGEBYSCORE` used by the deadline/void worker → under-filled matches may never be voided/refunded. (A correct recursive parser already exists in `matchSubscriber.ts`.) Use a real client.

---

- **M12. Zero-slack sealing at `min_players` is a cheap grief.** When `seated == min_players`, a single non-sealer makes `sealed_count < min_players` → `UnderMinSealed` VOID for the whole table (`services/programs/src/lib.rs:435,468`). The lone griefer forfeits only `nonseal_penalty_bps` of their deposit, and on `UnderMinSealed` refund that pool is split back to sealers (`lib.rs:740-743`) — so denying a minimum-sized table costs the attacker almost nothing. Require a seating margin above `min`, or gate go-live on the (cheaper-to-reach) off-chain seal set rather than all-or-nothing on-chain commitments.

## 🔵 LOW / INFO

- **L1.** Settlement `attempt_count` is double-counted by both submit and retry paths, roughly halving and obscuring the retry budget that gates the H5 force-void (`services/store/src/postgres.rs:185` + `services/settlement/src/ops.rs`).
- **L2.** Numerous `i64→u64`/`i32→u32` `as` casts on DB-sourced money fields in `services/worker/src/reconstruct.rs` (scheduled_end_ts, rake_cap, rake_bps); a negative value wraps huge. Use `try_from`.
- **L3.** `now_ms().expect("clock")` panics on backwards clock across worker/poller/consumer — a panic in the consumer loop stops draining the queue. Make it recoverable.
- **L4.** `from_hex`/`hex_to_bytes` slice `&s[i..i+2]` by byte index (`services/store/src/lib.rs:238-246`, `services/timelock/src/beacon.rs:151-159`) → panic on multibyte UTF-8 from tampered input/beacon. Validate ASCII first.
- **L5.** Action-feed/leaderboard returns raw wallet as `userId` (`services/action-feed/src/profiles.ts:42`), contradicting the service's stated pseudonymity contract. Use a non-reversible public id.
- **L6.** Trust-safety heuristics are trivially evadable: `botTimingScore` only fires below CV 0.05; `chipDumpScore` ignores pot magnitude (`services/trust-safety/src/index.ts:17-35`). Add jitter-robust statistical tests and magnitude-weighted collusion scoring.
- **L7.** NATS settlement jobs are unauthenticated (`services/settlement/src/ops/nats.rs`); a forged *Void* job isn't self-verified (only *Settled* bundles are). On-chain `void` is authority-gated (`services/programs/src/lib.rs:474-491` requires `emergency_void_admin`), but authenticate producers anyway.
- **L8.** `base58` decoder in `services/gateway/src/verifier.ts` accepts non-canonical input; malformed wallets propagate as identity keys. Validate canonical 32-byte decode.
- **L9.** `submit_settlement` lets the settlement_admin choose *any* valid oracle update inside the bounded window rather than the earliest; off-chain `first_valid_oracle_update` picks earliest but on-chain doesn't enforce it. Small window (default 5s) limits impact; admin is trusted.
- **L10.** Matchmaking `queueKey` set is write-only dead code: `joinQueue` `zadd`s `{wallet→ts}` to `syndicate:matchmaking:queue:{matchId}` (`services/matchmaking/src/formation.ts:430,434`) but nothing in the repo ever reads it (no `zrange`/`zpop`/`zrem`/`zcard`) and it has no TTL → slow unbounded Redis growth. Seating/start decisions key off `table.seats` (deposit-verified) ordered by deposit-finality in `requestSeat`, so the join-order queue was superseded. Remove the writes + key helper, or actually use it as the intended waitlist.
- **Info.** `devnet_testing_keys.md` is committed to the repo — confirm it contains only devnet/throwaway material and never mainnet keys; ensure CI/secrets hygiene (`docs/deployment/SECRETS_AND_KEYS.md`).

---

## What's solid (so you don't regress it)
- Pot/side-pot math, rake flooring, and remainder tie-breaking are deterministic and integer-only with explicit conservation asserts (`services/shared/src/pots.rs`, `services/shared/src/settle.rs`).
- Pyth verification requires `VerificationLevel::Full`, owner-checks the receiver program, and binds feed/exponent/confidence/window (`services/programs/src/pyth_receiver.rs`, `services/shared/src/oracle.rs`).
- Seat-set validation in `submit_settlement` (PDA re-derivation + dedup) and pull-based idempotent `claim`/`refund` with `close = player` are well done.
- The drand `tlock` time-lock core (no key holder, round-gated, missing-key→VOID) is correctly structured (`services/timelock/src/lib.rs`).
- The worker re-derives oracle rules/rake/`onchain_match_id` from the DB and validates `event_root` rather than trusting the message body; store uses parameterized SQL.

---

## Top of the fix list
1. **C1 + C4** — the Ed25519 verifier is both insecure (no index pinning) and likely broken (accounts check). Fix together and add seat-owner checks to the register handlers.
2. **C2** — replace the commitment/chain hashes with SHA-256 everywhere in lock-step.
3. **C3** — reconcile the conservation model with remaining-stack returns, or your real games can't pay out.
4. **H4/H5** — settlement concurrency + force-void are the off-chain money-loop landmines.
