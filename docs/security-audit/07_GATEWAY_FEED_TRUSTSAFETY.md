# 07 — Adversarial Audit: Gateway, Action-Feed, Trust-Safety, Store, Config

**Scope:** `services/gateway`, `services/action-feed`, `services/trust-safety`, `services/store`, `services/config` (the player-facing real-time edge). Threat model: malicious **players / external actors**. The operator is trusted; operator-malice is out of scope.

**Date:** 2026-07-01 · **Auditor:** white-hat adversarial review · **Method:** source read of every in-scope file plus cross-checks into `services/match-engine` for the trust boundary the gateway forwards into.

---

## Summary

The cryptographic auth handshake itself is sound (single-use unguessable nonce, real ed25519 verification, server-authoritative clock — no client-timestamp trust at the edge), and the action-feed public projection has a genuinely solid default-deny redaction core (`projectEvent`). However, the **authorization** layer is largely missing or misplaced. The single most serious issue is that **seat ownership is never verified**: the gateway forwards a client-chosen `seatIndex` verbatim, and the match-engine only checks that the signature is valid for the *self-asserted* `(wallet, seat_index)` pair — it never checks that `wallet` actually owns `seat_index`. A player with one valid seat can therefore sign and submit actions, default policies, and seal commitments **as any other seat in the same match**. Compounding this, a compiled-in env flag (`SYNDICATE_ALLOW_DEV_SIGNATURES`) disables signature checks entirely in a production binary. Secondary issues: unauthenticated profile writes (impersonation/stored-XSS vector), no per-message rate limiting (bet/seal/HTTP-amplification spam and match-griefing DoS), forgeable geofence headers, unbounded subscription/state-map growth, and an unhandled exception path in the config service that turns a query string into a request crash.

### Severity-sorted findings

| # | Severity | Title | Location |
|---|----------|-------|----------|
| 1 | **Critical** | No seat-ownership check — act/seal/policy as another seat | `gateway/relay.ts:148-196`, `match-engine/service.rs:648-687` |
| 2 | **Critical** | `SYNDICATE_ALLOW_DEV_SIGNATURES` disables all signature verification in prod binary | `match-engine/service.rs:896-905` |
| 3 | **High** | Unauthenticated profile write — wallet impersonation + unvalidated `avatarUri` (stored-XSS) | `action-feed/server.ts:127-137`, `profiles.ts:16-26` |
| 4 | **High** | No per-message rate limiting — bet/seal spam, HTTP fan-out amplification, void-griefing DoS | `gateway/server.ts:140-181`, `index.ts (main)` |
| 5 | **High** | Forgeable geofence — `x-syndicate-country` / `cf-ipcountry` trusted from client | `gateway/main.ts:61-64`, `server.ts:119-127` |
| 6 | **High** | Any authenticated wallet can `subscribe` to any matchId and read its state/deadlines/turn events | `gateway/relay.ts:87-105`, `server.ts:192-199` |
| 7 | **Medium** | Subscription / watcher / lobby maps never cleaned on disconnect — unbounded memory growth | `gateway/relay.ts:29-39, 87-146` |
| 8 | **Medium** | Config service crashes the request on out-of-range query params (`bindConfig` throws, no catch) | `config/main.ts:21-64`, `index.ts:242-247` |
| 9 | **Medium** | Action-feed `/ws` unauthenticated + no payload/connection caps | `action-feed/server.ts:227-252` |
| 10 | **Medium** | No WS `maxPayload` / no message size cap on gateway → large-message memory pressure | `gateway/server.ts:84, 140-146` |
| 11 | **Low** | `RedisRateLimiter` can permanently lock a key if `EXPIRE` fails after first `INCR` | `gateway/state.ts:125-130` |
| 12 | **Low** | Action-feed Postgres writes use string-interpolated SQL via `psql -c` (escaped, but not parameterized) | `action-feed/projector.ts:114-223, 345-421` |
| 13 | **Info** | `containsSecret` redaction guard is CI-only, never invoked at runtime | `action-feed/index.ts:54-56` |
| 14 | **Info** | Lobby feed intentionally exposes wallet + handle of seated players (copy-targeting aid) | `action-feed/lobby.ts:1-14, 76-96` |

### Verified controls (working as intended)

- **Auth handshake** (`server.ts:133-169`, `index.ts:29-46`): server-issued single-use nonce (`challengeStore.take` deletes on use), real ed25519 verification against the base58 wallet pubkey (`verifier.ts`), nonce expiry checked, session TTL enforced against the **server** clock (`sessionStillValid`). Cross-wallet nonce reuse is blocked because the nonce is consumed atomically and bound to the connection.
- **Action-feed redaction core** (`index.ts:31-51`): `projectEvent` is a strict allow-list; `seal`/`intent` ciphertext and pre-signed intents are dropped; `reveal` (the prediction) is emitted only when `timelockOpen`; wallets are stripped from all gameplay events; unknown shapes are default-denied.
- **Store SQL** (`postgres.rs`): every query is fully parameterized (`$1..$n`); event log is append-only and hash-chained with DB triggers (`schema.rs` tests confirm `reject_match_event_mutation`); settlement double-pay prevented by `idempotency_key UNIQUE`; duplicate-wallet-per-match rejected by unique `(match_id, wallet_address)` + a `CHECK (allow_duplicate_wallet_per_match = false)`.
- **config_hash allowlist** (`config/index.ts:224-247, 437-443`): the hash is **rules-only** (buy-in / fill-window / derived blinds excluded), so a player cannot smuggle attacker-favorable economics through the hash; the on-chain `ProtocolState` bounds re-check every create, and `validateConfig` rejects `rakeBps>100%`, shallow stacks, missing geofence, duplicate wallets, etc.
- **Gateway clock model** (`relay.ts:41-42, 274-292`): the gateway stamps `serverTime` and forwards engine ABSOLUTE deadlines verbatim, never fabricating one. Clients compute `deadline - serverTime` locally; the edge trusts no client timestamp, so client clock-skew cannot move a server-side deadline.

---

## Details

### 1. Critical — No seat-ownership check: act / seal / set-default as another seat

**Files:** `gateway/src/relay.ts:148-196` (forwards client `seatIndex`); `match-engine/src/service.rs:648-687` (validates signature but not ownership); `match-engine/src/verify.rs:44-66`.

**Proven.** The gateway relay forwards the player's intent to the match-engine with `seatIndex`/`playerId` taken **directly from the client message** and bound only to the authenticated `wallet`:

```ts
// relay.ts — 'act'
body: JSON.stringify({ wallet, action: msg.action, signature: msg.signature,
                       seatIndex: msg.seatIndex, nonce: msg.nonce, prevHeadHex: msg.prevHeadHex })
// relay.ts — 'sealPrediction'
body: JSON.stringify({ wallet, ciphertext: msg.ciphertext, playerId: msg.seatIndex,
                       targetRound: msg.targetRound, ... })
```

The match-engine then validates (`service.rs:648-685`):

- `intent.seat_index < self.engine.seats.len()` — range only;
- duplicate-nonce replay guard `(seat_index, nonce)`;
- `verify::verify_action_intent(wallet, signature, …, seat_index, …)` — checks the signature is valid for the message `(match_id, onchain_match_id, seat_index, pubkey, nonce, …)`.

What is **never** checked anywhere in `service.rs` / `engine` is whether `intent.wallet` is the wallet that actually owns `intent.seat_index`. The engine's `Seat` is positional and carries **no wallet field**; the wallet→seat binding lives only in the matchmaking/store registry (`match_seats` table) and is not consulted during action validation. The signed message binds `wallet` to `seat_index`, but that binding is *self-asserted by the signer* — a player signs "I, wallet W, act on seat 1" and it verifies, regardless of who really sits at seat 1.

**Attacker scenario.** Mallory legitimately deposits and takes seat 0 (she has a valid key and a real session). During the live match she crafts an `act` (or `setDefault`, or `sealPrediction`) message with her own wallet/signature but `seatIndex = 1` (Victor's seat). The signature is valid for `(Mallory, seat 1)`; the engine accepts it. Mallory can now fold Victor's hand, force a default policy on him, push bets in his name, or seal a garbage/no-seal prediction for him.

**Impact.** Critical. Direct economic harm: an attacker folds opponents to win pots, or forces a non-seal penalty / bad seal on a rival to forfeit their buy-in. This is action forgery as another player — the core integrity property of the game.

**Fix.** The engine must hold the authoritative seat→wallet map (populated at `begin_live` from the verified deposit registry) and reject any intent where `registered_wallet[intent.seat_index] != intent.wallet` *before* signature verification. The gateway should additionally pass the authenticated `wallet` as the sole identity and have the engine *derive* `seat_index` from it rather than accept a client-supplied index.

---

### 2. Critical — `SYNDICATE_ALLOW_DEV_SIGNATURES` disables all signature verification in the production binary

**File:** `match-engine/src/service.rs:896-905`.

**Proven (code path); SUSPECTED (deployment).** `allow_dev_signature` short-circuits validation in `validate_action_intent`, `validate_default_policy`, and `validate_prediction_commitment` (`service.rs:669, 696, 721`). The `"sig-"` test prefix is correctly gated behind `#[cfg(test)]`, but the env-var branch is **not** — it is compiled into the release binary:

```rust
std::env::var("SYNDICATE_ALLOW_DEV_SIGNATURES").map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
```

If this variable is ever set in a deployed environment (left over from a devnet config, a copied compose file, a debugging session), every signature check across actions, default policies, and seal commitments is skipped. Combined with finding #1 (client-chosen `seatIndex`), any client can submit any intent as any seat with no signature at all.

**Impact.** Critical if the flag leaks into a real deployment — total bypass of player authentication for gameplay intents.

**Fix.** Remove the env-var bypass from non-test builds entirely (gate the whole function on `#[cfg(test)]`, or behind a `debug_assertions` + explicit feature flag that cannot be enabled in release). At minimum, refuse to start the service if the flag is set while a mainnet/production profile is active, and log loudly.

---

### 3. High — Unauthenticated profile write: wallet impersonation + unvalidated `avatarUri`

**Files:** `action-feed/src/server.ts:127-137`; `action-feed/src/profiles.ts:16-26`.

**Proven.** `PUT /profiles/me` reads `wallet` from the request **body** and writes handle/avatar for that wallet with **no authentication and no signature**:

```ts
const wallet = String(body.wallet ?? '');
const meta = upsertProfileMetadata(wallet, { handle: ..., avatarUri: ... });
```

Anyone who can reach the action-feed HTTP port can set the public handle and `avatarUri` of **any** wallet, including a famous/known player's. `avatarUri` is stored verbatim with no scheme/host validation.

**Attacker scenario.** (a) Impersonation/defacement: set a rival's handle to something offensive, or set their handle to a name that misleads other players (social engineering at the lobby roster, which displays handles — see #14). (b) If any web client renders `avatarUri` into an `<img src>` / CSS without sanitization, an attacker stores a `javascript:`/`data:` or tracking URL → stored XSS / pixel-tracking against everyone who views that profile or lobby.

**Impact.** High — identity spoofing on a betting product plus a stored-content injection vector.

**Fix.** Require the same nonce→signature proof the gateway uses (or a gateway-minted session token) and derive `wallet` from the verified identity, not the body. Validate `avatarUri` against an allow-list of schemes/hosts (or store only an opaque asset id). Bound handle length and charset.

---

### 4. High — No per-message rate limiting: spam + HTTP fan-out amplification + void-griefing

**Files:** `gateway/src/server.ts:110-181`; `gateway/src/index.ts (main.ts):22-27`.

**Proven.** The rate limiter is consulted **once, at connection time**, keyed on the remote IP (`server.ts:113`). After the handshake, `onMessage` (`server.ts:140-181`) relays **every** inbound message with no further throttling. Each relayed `act` / `sealPrediction` / `setDefault` / `subscribe` / `fetchLobby` / `fetchQueueStatus` triggers one or more outbound `fetch` calls to match-engine / matchmaking / config (`relay.ts:99, 150, 168, 185, 200, 213`). A single authenticated socket can therefore:

- flood `act`/`sealPrediction` to spam the engine (bet/seal spam, and feeds the duplicate-nonce path / log churn);
- issue thousands of `subscribe`/`fetchLobby`/`fetchQueueStatus` per second, each amplified into a backend HTTP request the gateway pays for — classic amplification DoS that can starve the engine and **grief live matches into a void** when the engine can't service legitimate actions before deadlines.

Reconnecting resets the connection-time bucket, and because the key is the raw `req.socket.remoteAddress`, deployment behind a reverse proxy makes every user share the proxy's IP (one bucket for everyone, or trivially bypassable since `X-Forwarded-For` is not consulted).

**Impact.** High — resource exhaustion and match-griefing (voids strand/return funds and deny play), plus per-action spam.

**Fix.** Add a per-**session/wallet** token bucket enforced inside `onMessage`, with distinct (tight) limits for expensive ops (`act`, `sealPrediction`, `subscribe`, the `fetch*` lookups). Derive the rate-limit key from a trusted forwarded-for only when behind a known proxy; otherwise from the session. Cap concurrent connections per wallet.

---

### 5. High — Forgeable geofence: country headers trusted from the client

**Files:** `gateway/src/main.ts:61-64`; `gateway/src/server.ts:119-127`; `index.ts:53-56`.

**Proven (header trust); SUSPECTED (impact depends on deployment).** `countryFromHeaders` reads the country from `cf-ipcountry` / `x-vercel-ip-country` / `x-syndicate-country` request headers. These are all **client-settable** unless an upstream proxy strips and re-sets them. If the gateway WS port is reachable directly (or the proxy does not overwrite the custom `x-syndicate-country`), a player in a blocked jurisdiction (e.g. `IN`, blocked by default) simply sends `x-syndicate-country: US` and the geofence (`isGeoAllowed`) passes.

**Impact.** High — regulatory/compliance bypass of the jurisdiction block, which is a stated launch invariant.

**Fix.** Resolve country **server-side** from the real peer IP (a geo-IP lookup on `req.socket.remoteAddress`), or accept the header only from a trusted proxy hop and have that proxy strip any inbound `x-syndicate-country`/`cf-ipcountry` from the public edge. Never trust a custom country header that originates from the client.

---

### 6. High — Any authenticated wallet can subscribe to any match and read its state, deadlines, and turn events

**Files:** `gateway/src/relay.ts:87-105` (`subscribe`); `gateway/src/server.ts:192-199` (`sendToWallet`).

**Proven (authz gap); impact bounded by what the engine returns.** `subscribe` registers the caller as a watcher of an arbitrary `matchId` with **no check that the wallet is a participant or permitted observer**. The caller immediately receives `tableTerms`, the engine's `matchState`, and the forwarded ABSOLUTE deadlines (`relay.ts:97-103`), and is added to `matchWatchers` so it receives all subsequent engine pushes for that match — including `yourTurn` (with `toCall`/`minRaiseTo`/deadlines) and `settled` payloads (`relay.ts:71-76`, `normalizeEnginePayload`).

The `buildMatchStateView` projection is conservatively minimal (`seats: []`, `feedPrice: 0`, `currentBet: 0`), so this is **not** a direct prediction/hole leak today. The risks are: (a) the gateway path does **not** go through the action-feed `projectEvent` redaction — anything the engine includes in its `matchState`/`yourTurn`/`event` payloads is forwarded by `normalizeEnginePayload`'s catch-all (`return p`) more permissively than the public projection; (b) precise per-seat turn deadlines and pot/round state for matches a player is not in still aid copy/counter strategies and surveillance.

**Impact.** High as an authorization defect (no participant gate on a real-time match feed) and as a latent info-leak that depends entirely on what the engine chooses to emit.

**Fix.** Gate `subscribe` on the wallet being a seated participant (or an explicitly-allowed spectator) of `matchId`, checked against the registry. For genuine spectators, route them through the redacted action-feed projection rather than the raw engine relay, and ensure `normalizeEnginePayload` uses an allow-list (never `return p` for unknown kinds).

---

### 7. Medium — Subscription / watcher / lobby maps never cleaned up on disconnect

**Files:** `gateway/src/relay.ts:29-39, 87-146`.

**Proven.** `matchWatchers`, `roomWatchers`, and `lobbySubscribers` are module-level maps keyed by wallet, populated on `subscribe`/`subscribeRoom`/`subscribeLobby`. The WebSocket `close` handler (`server.ts:130`) only removes the `Conn` from `this.conns`; it never removes the wallet from any relay set. `unsubscribe*` exists but requires the client to call it. A wallet that subscribes to many matches and disconnects leaves its entries forever; `sendToWallet` keeps iterating them on every fan-out.

**Attacker scenario.** Open a socket, authenticate, `subscribe` to thousands of distinct `matchId` values (no participant check — see #6), disconnect, repeat. The maps grow without bound and each `roomsUpdated`/match push iterates ever-larger watcher sets.

**Impact.** Medium — memory growth and CPU on every broadcast → gradual gateway degradation (DoS).

**Fix.** On `ws` `close`, remove the wallet from all relay sets (track per-connection subscriptions and tear them down). Bound the number of simultaneous subscriptions per session.

---

### 8. Medium — Config service crashes the request on out-of-range query params

**Files:** `config/src/main.ts:21-64, 46-55`; `config/src/index.ts:242-247` (`bindConfig` throws); `table-terms.ts:96-117`.

**Proven.** `/config/table` builds a config from attacker-controlled `buyIn`/`fillWindowSec` query params via `tableTermsForTier` → `buildMatchConfig` → `bindConfig`, and `bindConfig` **throws** when `validateConfig` fails (e.g. `buyIn` below `BUY_IN_MIN`, above `BUY_IN_MAX`, non-integer, or a non-practice `buyIn=0`). The `route` handler has **no try/catch**, and the server is created with `(req,res) => void route(req,res)` (`main.ts:9`), so the rejected promise becomes an unhandled rejection and the request hangs / the handler throws.

**Attacker scenario.** `GET /config/table?buyIn=5&tierId=tier-standard&feedId=BTC/USD` (5 is below the $1 minimum) → `bindConfig` throws → request never gets a response; repeated calls leak sockets / spam unhandled rejections. Note the gateway itself calls this endpoint during `subscribe` (`relay.ts:97, 239`), so a malicious `matchId`/terms lookup can also wedge that path.

**Impact.** Medium — unauthenticated request-crash / resource-leak DoS on the config service (and indirectly the gateway subscribe path).

**Fix.** Wrap `route` in try/catch returning `400` on validation errors; range-check `buyIn`/`fillWindowSec` before calling `bindConfig`; add a top-level `unhandledRejection`/`server.on('error')` guard.

---

### 9. Medium — Action-feed `/ws` is unauthenticated with no payload/connection caps

**File:** `action-feed/src/server.ts:227-252`.

**Proven.** The `/ws` upgrade does a bare RFC-6455 accept with no auth, then stores the socket and broadcasts public events. This is by-design for a public spectator feed, and the data is redacted (`projectEvent`). The residual risks are operational, not info-leak: (a) the handshake reads `matchId` from the query and never validates it; (b) there is no cap on the number of WS clients and no read of incoming frames (so no inbound abuse, but also no ping/timeout management), and the server hand-rolls frames without backpressure handling.

**Impact.** Medium — connection-flood DoS against the spectator service (unbounded `wsClients`); no confidentiality impact given redaction holds.

**Fix.** Add a per-IP connection cap and idle/timeout reaping; validate `matchId`; consider requiring a lightweight token for the WS upgrade if spectator capacity is a concern.

---

### 10. Medium — No `maxPayload` / message-size cap on the gateway WebSocket

**Files:** `gateway/src/server.ts:84` (`new WebSocketServer({ noServer: true })`); `server.ts:140-146` (`JSON.parse(String(data))`).

**Proven.** No `maxPayload` is configured, so the `ws` default (100 MiB) applies, and each inbound frame is fully buffered then `String()`-ified and `JSON.parse`d. An authenticated (or even pre-auth) socket can send repeated ~100 MiB frames; with no per-message rate limit (#4) this is straightforward memory pressure.

**Impact.** Medium — memory/CPU DoS; large `JSON.parse` can stall the event loop, delaying legitimate actions toward deadlines (void-griefing again).

**Fix.** Set a small `maxPayload` (a few KiB is ample for these JSON intents) on the `WebSocketServer`, and reject oversized frames before parsing.

---

### 11. Low — `RedisRateLimiter` can permanently lock a key if `EXPIRE` fails

**File:** `gateway/src/state.ts:125-130`.

**Proven (logic).** `allow` does `INCR` then, only when the count is exactly 1, `EXPIRE`. If the process dies / the connection drops between `INCR` and `EXPIRE`, the key has no TTL and counts up forever; once it exceeds `limit` the IP is blocked indefinitely. The single-connection-per-command `RedisClient` (`redis.ts`) makes a transient failure between the two commands plausible.

**Impact.** Low — availability (a stuck key denies a legitimate user/IP) rather than an attacker advantage; an attacker could also intentionally race to wedge a shared proxy IP.

**Fix.** Use a single atomic operation (`SET key 1 EX win NX` then `INCR`, or a Lua script / `INCR` + `EXPIRE` pipelined in one round-trip with `EXPIRE NX`), so the TTL is always set.

---

### 12. Low — Action-feed Postgres writes use string-interpolated SQL via `psql -c`

**File:** `action-feed/src/projector.ts:114-223` (`PsqlProjectionSink`), `345-421` (`PsqlOutboxProjectionSource`).

**Proven (pattern); no live injection found.** Unlike `store/postgres.rs` (fully parameterized), the action-feed sink assembles SQL by string concatenation and shells out to `psql -c`. String values go through `sqlString` (doubles single quotes) and numbers through `nonNegativeInt`/`positiveInt`/`String(number)` guards; UUIDs are regex-validated. I did not find an exploitable break: the inputs (`summary`, `objectUri`, `eventRoot`, `matchId`) are server-derived from upstream events, not directly attacker-typed, and the escaping/guards hold for the values seen. The concern is defense-in-depth: a future field added to `summary`/`history` without a guard, or a value that is a number type but `NaN`/`Infinity` (`String(NaN)` → `"NaN"` → SQL error), would break or inject. `hydrateHistoricalGamesFromPsql` also splits on ``/`\t` and `JSON.parse`s `summaryRaw` without bounding.

**Impact.** Low today; medium latent.

**Fix.** Use a parameterized driver (`postgres`/`pg`) instead of `psql -c` with interpolation; if `psql` must stay, pass values via `psql` variables (`-v`) / `\copy` rather than inlining, and assert finiteness on every numeric.

---

### 13. Info — `containsSecret` is a CI guard, not a runtime check

**File:** `action-feed/src/index.ts:54-56`.

The regex guard that flags `ciphertext|presigned|wallet` in a serialized event is only described as a "defensive CI guard" and is **not** called anywhere in the projection/broadcast runtime path. Runtime safety rests entirely on `projectEvent`'s allow-list (which is solid). Consider invoking `containsSecret` as a last-line assertion in `broadcastPublicEvent`/`publish` so a future allow-list mistake fails closed at runtime, not just in CI.

---

### 14. Info — Lobby feed intentionally exposes seated players' wallets + handles

**File:** `action-feed/src/lobby.ts:1-14, 76-96`; `server.ts:94-119`.

Documented as a deliberate product decision: the `{ type: 'lobby' }` broadcast and `GET /upcoming-games` carry `wallet` + resolved `handle` for each seated player in a FILLING room, bypassing `projectEvent`. This does not leak predictions, but it does let an observer enumerate exactly which wallets are sitting at which forming table before it starts — useful for targeting/colluding against a specific opponent, and it ties real wallets to handles set via the **unauthenticated** profile endpoint (#3). Flagging for product/privacy awareness; combined with #3 it enables an attacker to map and label opponents pre-game.

---

## Cross-cutting recommendations

1. **Establish the seat→wallet authority in the engine** (fixes #1, hardens #6). The engine must own the verified seat roster and reject any intent whose wallet ≠ the seat's registered owner, independent of signature validity.
2. **Remove the dev-signature bypass from release builds** (#2).
3. **Authenticate every state-changing edge endpoint** (#3, #6) — derive identity from the verified session/signature, never from request body/query.
4. **Add per-session/per-wallet rate limits and payload caps inside the message loop** (#4, #7, #10), and resolve geofence + rate-limit keys from trusted server-side data, not client headers (#5).
5. **Make redaction fail-closed at runtime** (#13) and parameterize all SQL (#12).
