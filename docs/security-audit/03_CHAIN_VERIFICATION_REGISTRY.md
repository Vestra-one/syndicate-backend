# 03 — Chain Verification & Registry Integrity (Adversarial Audit)

## Summary

The core trust boundary — `services/settlement-chain/src/verify.ts` — is **fundamentally
sound**. It re-reads `finalized` on-chain state (`MatchAccount` + the player's `SeatAccount`)
and never trusts client-decoded values: it confirms the tx was *found at finalized*, did *not
error*, the *reporter signed it*, the *match is `Filling`* with an *allowlisted config*, the
*seat belongs to the claimed player*, and that `seat.deposit == match.buy_in`. The seat PDA is
keyed `['seat', match, player]`, so player A **cannot** claim player B's deposit, and the
on-chain `SeatIndexAccount` (`init`) prevents duplicate seat indices. The decoder offsets and
the `getProgramAccounts` memcmp (offset 8 = `match_key`, disambiguated from `SeatIndexAccount`
by `dataSize=168`) are **correct**. Capital safety reads chain, not the registry.

The exploitable surface is the **layer above** that boundary: the matchmaking HTTP service has
**no authentication and no wallet-ownership proof** on its report endpoints, uses
**client-supplied `matchPda` as the registry key without binding it to the verified PDA**, runs
a **non-atomic Redis CAS** (the Redis client has no `WATCH`/`MULTI`/`EVAL`), and a **global,
non-match-scoped tx-replay cache**. There is also a **dead-but-documented** `deposit-verify.ts`
gate that, if ever wired, defaults to `confirmed` (rollback-prone) and effectively verifies
nothing. None of these let an attacker steal vault funds (the contract is the backstop), but
several enable registry desync, griefing, lockout, and economic harm to honest players.

| # | Title | Severity | Status |
|---|-------|----------|--------|
| 1 | Matchmaking report endpoints have no auth / no wallet-ownership proof | High | PROVEN |
| 2 | `createRoom` keys registry on client-supplied `matchPda`, not the verified PDA | High | PROVEN |
| 3 | `deposit-verify.ts` gate defaults to `confirmed` and verifies nothing real | High | PROVEN (dead code) |
| 4 | Non-atomic Redis CAS (`saveTableCas`) — TOCTOU double-seat / lost seat | Medium | PROVEN |
| 5 | Tx-replay cache is global, not scoped to (match, wallet) | Medium | PROVEN |
| 6 | Client-claimed `configHash` chooses the template, never compared to on-chain | Medium | PROVEN |
| 7 | `verifyDeposit` does not assert the seat tx targeted *this* program/match instruction | Medium | SUSPECTED |
| 8 | Deadline-worker uses `hashMatchId(matchId)` as on-chain id — fabricated PDA | Medium | PROVEN |
| 9 | `optional seatIndex` lets registry seat order diverge from on-chain seat_index | Low | PROVEN |
| 10 | Single primary RPC for `finalized` verify; no quorum / slot sanity | Low | PROVEN |
| 11 | `wallet-rooms` cap never decrements; honest hosts locked out | Low | PROVEN |
| 12 | `verifyOnSecondary` accepts any commitment, defeating its purpose | Low | PROVEN |
| — | On-chain re-verification of seat/deposit/signer/status | Verified control | — |
| — | Seat-PDA / SeatIndex dedupe prevents cross-player & dup-seat theft | Verified control | — |

---

## Findings

### 1. Matchmaking report endpoints have no auth and no wallet-ownership proof — High (PROVEN)

**File:** `services/matchmaking/src/main.ts:69-145` (and the whole server). `grep` for
`authoriz|Bearer|signature` in `main.ts` returns nothing.

`POST /rooms`, `POST /rooms/:code/start`, `POST /matches/:id/deposits`, `POST /queue/join` are
all unauthenticated and take `wallet`/`host` straight from the request body
(`String(body.wallet ?? body.host)`, `main.ts:76`, `:138-139`). The caller never proves
control of that wallet (no signed nonce, no session token).

**Attacker scenario.**
- *Report-on-behalf / griefing:* anyone can call `POST /matches/:id/deposits` with another
  player's `wallet` and that player's real (public, on-chain) deposit signature. On-chain
  verification *passes* (the victim genuinely signed and deposited), so the attacker forces the
  victim to be seated/registered at a time of the attacker's choosing — useful to win seat
  races against the victim's intended room, or to seat them into a different forming table than
  the one they queued for, since `matchId` is attacker-chosen in the path.
- *Host impersonation on start:* `POST /rooms/:code/start` only checks `rec.host === body.host`
  (`formation.ts:378`); `body.host` is unauthenticated, so the check is "do you know the host's
  public wallet address", which is public. Any actor can trigger an early `hostStart`,
  forcing `lock → begin_live` before more players join — shrinking the pot / changing odds for
  everyone already seated.

**Economic impact.** No direct theft (vault is contract-guarded), but: forced early starts,
seat-race manipulation, and seating victims into attacker-chosen tables — concrete harm to
honest players' EV and a denial-of-fair-formation.

**Fix.** Require a wallet-signed challenge (sign a server nonce / the txSig with the reporting
wallet) on every report and on `start`, and verify the signature server-side before any registry
mutation. At minimum, require an internal bearer token if these are meant to be gateway-only,
and have the gateway bind the authenticated wallet.

---

### 2. `createRoom` keys the registry on the client-supplied `matchPda`, not the verified PDA — High (PROVEN)

**File:** `services/matchmaking/src/formation.ts:196-243`, esp. `:204`, `:236`, `:287`.

`verifyCreate` is called with only `onchainMatchId` + `wallet` and returns the authoritative
`verified.matchPda` (`verify.ts:84-87`, `chain-verify.ts:14`). But `createRoom` then does:

```ts
const matchId = input.matchPda;          // :204  — CLIENT-SUPPLIED, never compared
...
matchPda: input.matchPda,                // :236, :287 — persisted everywhere
```

`verified.matchPda` is **never read**. The verifier derives the PDA from `onchainMatchId`, so the
on-chain check is correct, but the *registry/table key, persisted `match_key`, and lobby
listing* all use a string the attacker fully controls and that is never asserted to equal
`deriveMatchPdas(onchainMatchId).match`.

**Attacker scenario.** Report a valid `create_and_deposit` for `onchainMatchId = X` (passes
verification) but set `matchPda = "<arbitrary string>"`. The room, table, deadline zset entry,
Postgres `matches.match_key`, and all subsequent deposit lookups are now keyed on a value that
does **not** correspond to the real on-chain match. Two distinct creates can also be made to
collide on one `matchId` key (overwriting another host's room), or a single real match can be
registered under many fake keys (registry/lobby spam, DB-row pollution). Downstream
`begin_live`/settlement that resolve the PDA from `onchainMatchId` are safe, but anything keyed
off `matchId` (deposit routing in `verifyDeposit:579`, persistence, lobby) is corruptible.

**Economic impact.** Registry desync and DOS of honest rooms (overwrite / collision); deposit
reports routed to a table whose `onchainMatchId` no longer matches the funds — honest joiners
can be steered to deposit into a match they cannot be started/refunded through the registry.

**Fix.** After `verifyCreate`, set `const matchId = verified.matchPda;` and **reject** if
`input.matchPda` was supplied and differs. Use `verified.matchPda` for every persisted/keyed
value.

---

### 3. `deposit-verify.ts` gate defaults to `confirmed` and verifies essentially nothing — High (PROVEN, currently dead code)

**File:** `services/matchmaking/src/deposit-verify.ts:38, 67-90`.

`SolanaDepositVerifier` is **not currently wired** (grep shows no production import; the live
path is `chain-verify.ts` → settlement-chain `verify.ts`). But it is the file named as the
"primary target" and the doc-described gate, so it is a latent High: if anyone re-enables it,
it is exploitable.

Defects:
- **Default commitment `confirmed`** (`:38`) — `confirmed` can roll back; a deposit can be
  un-done after seating.
- **No amount check:** `expectedTotal`/`expectedBuyIn` are computed (`:69`) but never compared
  to any on-chain transfer. A 1-lamport or wrong-token tx is credited as a full buy-in.
- **No program / PDA / mint targeting:** the "program hit" check is
  `logs.some(l => l.includes(programId)) || signers.length > 0` (`:74`) — the
  `|| signers.length > 0` makes it **always true** for any non-empty tx. It never checks the tx
  touched the match PDA, the vault, or the chips mint.
- **No seat/account-state check:** it trusts `input.seatIndex` (`:68`) and the client's
  `wallet`/amounts wholesale.
- **Signer check is weak:** `message.accountKeys.includes(wallet)` (`:62-64`) treats *any
  account key* (incl. writable non-signers) as "signer".

**Attacker scenario** (if wired): submit any finalized-or-confirmed signature where your wallet
appears as any account key, with `expectedBuyIn` you control client-side → seated for free.

**Fix.** Delete the file, or harden it to delegate to `verify.ts`'s account-state predicate.
Never ship a deposit gate that doesn't re-read the seat account and compare `deposit == buy_in`
at `finalized`.

---

### 4. Non-atomic Redis CAS — TOCTOU double-seat / lost seat — Medium (PROVEN)

**Files:** `services/matchmaking/src/redis-store.ts:24-33`; Redis client
`services/gateway/src/redis.ts` has only `get/setex/incr/zadd/...` — **no `WATCH`/`MULTI`/`EVAL`**.

`saveTableCas` does `get(version)` → compare → `setex(version+1)` as two separate round trips.
Two concurrent `verifyDeposit` calls both read version *v*, both pass the compare, both write
*v+1*; one seat write is silently lost, or a seat is double-counted depending on interleave.
`verifyDeposit` (`formation.ts:594-616`) is exactly this read-modify-write under attacker-
controllable concurrency (the endpoint is unauthenticated, finding #1).

**Attacker scenario.** Fire N concurrent deposit reports (different real depositors, or the same
report racing) to inflate/under-count `seats.length`, defeating the `maxPlayers` guard
(`index.ts:77`) so a table can exceed capacity, or race a victim out of a seat slot. Combined
with `public_formation` auto-start (`formation.ts:633-645`), an over/under-filled table can be
pushed to `begin_live` with a registry seat set that disagrees with chain (chain is
authoritative, so the contract may reject — a void/grief, not theft).

**Economic impact.** Registry/seat-count corruption; forced voids; capacity-bypass griefing.

**Fix.** Implement CAS with a Lua `EVAL` (compare-and-set on a version field) or `WATCH/MULTI`,
or use `SET key val NX`/optimistic versioning that is genuinely atomic in one round trip.

---

### 5. Tx-replay cache is global, not scoped to (match, wallet) — Medium (PROVEN)

**Files:** `services/matchmaking/src/redis-keys.ts:25-27` (`depositCacheKey(sig)` =
`syndicate:deposit:pending:{sig}`), used in `formation.ts:177-178, 576-577, 737-748`.

The idempotency/replay key is the **bare signature**, with no match or wallet component, and the
cached value is the *success result*. `lookupReportedSig` returns the prior result if
`ok`, short-circuiting before verification (`:177`, `:576`).

**Attacker scenario.**
- *Cross-context replay short-circuit:* the first successful report of signature `S` caches
  `{ok:true, matchPda, seat,...}`. A later `POST /matches/<other>/deposits` with the same `S`
  returns the cached success **without re-verifying against the other match** (the early
  `return prior` at `:576` happens before the `loadRoom`/`verifyDeposit` for the new match).
  The new room's table is *not* actually mutated (seating happens after verify), so this is
  primarily a confusing/incorrect success response and a poisoning of any caller that trusts
  the returned `matchPda`/`seat` — but it bypasses the per-call verification entirely.
- Because the on-chain seat PDA binds (match, player), a *replayed-into-wrong-match* signature
  would fail real verification — which is exactly why short-circuiting **before** verify is
  wrong: it skips the check that would have caught the cross-match replay.

**Fix.** Key the cache as `pending:{onchainMatchId}:{wallet}:{sig}` and only treat it as
idempotent when match+wallet match the new request; otherwise fall through to full verification.

---

### 6. Client-claimed `configHash` selects the template and is never compared to the on-chain hash — Medium (PROVEN)

**File:** `services/matchmaking/src/formation.ts:181-187`; verifier `verify.ts:70-72`.

`createRoom` trusts `input.configHash` to (a) check the allowlist and (b) pick the template via
`getTemplateByHash(input.configHash)` (`:184`), which drives tier ranges, entry fee, blinds,
min/max players. `verifyCreate`/`verifyDepositTx` independently checks that the *on-chain*
`configHash` is allowlisted (`verify.ts:70`) but **never compares it to the client-claimed one**.

**Attacker scenario.** Create a real match on-chain with allowlisted config `B` (e.g. high
entry fee / specific blind structure), but report `configHash = A` (a different allowlisted
template with more favorable derived terms). Both pass their respective allowlist checks. The
registry, table-terms display, persisted `config_hash`, and the blind/stack config used by
`triggerStart` (`formation.ts:400-423`, derived from `rec.tierId`/template) now reflect template
`A`, not the on-chain rules `B`. Settlement reads chain so payouts are safe, but the **engine
runs with the wrong blinds/structure and players see wrong terms** — a fairness/economic-terms
mismatch.

**Fix.** After verification, derive the template from `verified.match.configHash` (the decoder
already exposes it) and reject if `input.configHash !== verified.match.configHash`.

---

### 7. Verifier does not assert the tx contained a deposit instruction to *this* program/match — Medium (SUSPECTED)

**File:** `services/settlement-chain/src/verify.ts:60-82`.

`verifyDepositTx` checks the tx finalized, didn't error, and the reporter is a signer — then
pivots entirely to **account state** (`MatchAccount` Filling + `SeatAccount` exists with
`deposit == buy_in`). It never inspects the tx's instructions to confirm *this signature* is the
one that created/funded the seat.

The account-state check is a strong proxy and likely sufficient *today* (the seat can only exist
with `deposit == buy_in` because the on-chain handler enforces it). The SUSPECTED gap: the
reported `sig` only needs to be *any* finalized tx the player signed (e.g. a 1-lamport self-
transfer) **as long as the seat already exists** from some other deposit. This decouples "the
signature you reported" from "the deposit that seated you". Impact is low *if* the only consumer
is the boolean "is this player legitimately seated" (which is true). It becomes a real problem if
any downstream logic attributes the *specific signature* to the deposit (e.g.
`depositSignature` persisted at `formation.ts:265, 605, 623` is used for accounting/audit or to
later prove which tx funded the seat).

**Fix.** Parse the tx instructions and assert at least one instruction is to `programId` with the
`deposit`/`create_and_deposit` discriminator targeting this match PDA + the player's seat; bind
the persisted `depositSignature` to that instruction.

---

### 8. Deadline-worker fabricates the on-chain id via `hashMatchId(matchId)` — Medium (PROVEN)

**File:** `services/matchmaking/src/deadline-worker.ts:79, 95`; helper
`orchestrator-client.ts:60-66`.

When a public-formation match hits its fill deadline, the worker triggers start/void with
`onchainMatchId: hashMatchId(matchId).toString()`. For player-created matches the *real*
`onchainMatchId` lives on the `FormationRecord` (`formation.ts:235`) and on the table, but the
worker ignores it and recomputes a synthetic id from the `matchId` string. For any match whose
real on-chain id is not `hashMatchId(matchId)` (i.e. every player-created match — its
`onchainMatchId` is the host's chosen value, and `matchId` is the *PDA string*, not the seed),
the derived PDA points at a **non-existent / wrong** match account.

**Attacker / honest-bug scenario.** A public-formation table that fills and reaches deadline is
sent to the orchestrator with a bogus `onchainMatchId`. `begin_live`/settlement then derive a
PDA for a match that doesn't exist → the start fails or, worse, collides with an unrelated
match id. Funds for the real match are stranded (no begin_live ever lands on the correct PDA);
honest joiners who deposited cannot be started or cleanly refunded through the automated path.

**Economic impact.** Fund stranding / failed settlement for deadline-started matches; potential
cross-match PDA collision.

**Fix.** Carry the verified `onchainMatchId` (and `matchPda`) on the table snapshot and use it in
the worker; never re-hash `matchId`. Remove `hashMatchId`/`syntheticOnchainId` from the live
path.

---

### 9. Optional `seatIndex` lets the registry seat order diverge from on-chain `seat_index` — Low (PROVEN)

**File:** `services/matchmaking/src/formation.ts:586-606`, `index.ts:71-82`.

`verifyDeposit` passes `seatIndex` through to the verifier only when the client supplies it
(`:590`); when omitted, the verifier does not pin the index (`verify.ts:79`). The registry then
assigns a seat index by **finality order** (`Table.requestSeat`, `index.ts:80-81`), while
persistence stores the **on-chain** `verified.seatIndex` (`:623`). These can differ.

Per design the registry is UX-only and `begin_live` reads chain, so this is **not** capital-
affecting. Impact: lobby/seat displays and any consumer that trusts the registry seat order can
show the wrong seat, and the persisted vs. displayed indices disagree.

**Fix.** Always require/derive `seatIndex` from the verified seat and use `verified.seatIndex`
consistently for both the registry table and persistence.

---

### 10. Single primary RPC for `finalized` verification; no quorum or slot sanity — Low (PROVEN)

**File:** `services/settlement-chain/src/main.ts:666-671` (`verifyRpcFor` builds one `Connection`
on `primaryRpcUrl` at `finalized`); `verify.ts:153-182`.

All deposit/create verification and seat enumeration trust a single RPC endpoint with no cross-
check, no slot/recency assertion, and no quorum. A compromised or buggy RPC could return a
forged "account exists with deposit == buy_in" or omit a seat from `getProgramAccounts`. Note
the settlement *submit* path *does* have a `verifyOnSecondary` (`main.ts:332, 409-414`), but the
**verify** path does not. `finalized` commitment is correctly used here (good), which bounds the
risk to RPC integrity rather than rollback.

**Fix.** For verification, cross-read `getAccountInfo` (and ideally `getProgramAccounts`) on the
secondary RPC and require agreement; assert the returned context slot is recent.

---

### 11. `wallet-rooms` anti-spam counter never decrements — Low (PROVEN)

**File:** `services/matchmaking/src/formation.ts:758-769` (`bumpWalletRooms` only `incr`s;
comment admits "no DECR"); cap checked at `:190`.

A host's active-room counter only goes up (24h TTL). After creating `walletRoomCap` (default 3)
rooms — even if all immediately void/cancel/settle — the host is locked out of creating new
rooms for up to 24h.

**Economic impact.** Honest hosts locked out of creating matches (lost rake/volume); a self-DOS
that an attacker can also induce against a victim if combined with finding #1 (report rooms as a
victim host). Not fund-affecting.

**Fix.** Decrement on room terminal (void/cancel/settle) via an atomic `DECR` (add it to the
Redis client) or track active rooms in a per-wallet set and count its cardinality.

---

### 12. `verifyOnSecondary` accepts any commitment — Low (PROVEN)

**File:** `services/settlement-chain/src/main.ts:409-414`.

The secondary-RPC cross-check uses `getSignatureStatus(txSig, { searchTransactionHistory: true })`
and only asserts `status.value` is non-null — it accepts a `processed`/`confirmed` (rollback-
prone) status, defeating the point of a second-source confirmation for settlement/void. It also
doesn't check `status.value.err` is null.

**Fix.** Require `status.value.confirmationStatus === 'finalized'` and `err == null` on the
secondary.

---

## Verified controls (do NOT regress these)

- **`verify.ts:60-82` re-reads on-chain state.** Confirms tx found at `finalized`, `!err`,
  reporter ∈ signers, match `Filling`, config allowlisted, seat exists for the *claimed player*,
  optional seat-index match, and `seat.deposit == match.buy_in`. This is the correct trust
  boundary and it does not trust client-decoded tx metadata.
- **Cross-player theft is blocked.** The seat PDA is `['seat', match, player]`
  (`custody.ts:192-198`) and the verifier checks `seat.player === expectedPlayer`
  (`verify.ts:78`). Player A reporting player B's tx cannot seat A.
- **Duplicate seat indices blocked on-chain** via `SeatIndexAccount` `init` PDA
  (`state.rs:255-270`, `lib.rs:243-248, 307-312`); the contract also enforces
  `status == Filling`, `player_count < max_players`, `seat_index < max_players`, and
  `now <= fill_deadline_ts` (`lib.rs:265-312`).
- **Decoder offsets are correct.** `decodeSeatAccount`/`decodeMatchAccount`
  (`matchAccount.ts:57-139`) match `state.rs` field-by-field, including `seat_index` u16 @72,
  `deposit` u64 @74.
- **`getProgramAccounts` memcmp is correct.** Offset 8 = `SeatAccount.match_key`
  (`verify.ts:176`), and `dataSize: SEAT_ACCOUNT_SIZE (168)` disambiguates it from
  `SeatIndexAccount` (83 bytes), which also has `match_key` at offset 8. An attacker cannot inject
  a fake seat into the enumeration without paying rent for a real 168-byte SeatAccount owned by
  the program — which the program only creates through `deposit`/`create_and_deposit`.
- **`begin_live` seat set comes from chain, not the registry** (`main.ts:148-163`,
  `verify.ts:134-150`), so registry desync (findings #2, #4, #9) cannot change who actually gets
  seated on-chain.
- **`finalized` commitment is used on the verify path** (`main.ts:668`), avoiding the rollback
  risk that finding #3's dead code reintroduces.
- **settlement-chain `/internal/*` is auth-gated** (`main.ts:108-109`, Bearer token) — the gap is
  purely on the *matchmaking* service (finding #1).
