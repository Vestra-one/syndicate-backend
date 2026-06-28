# Syndicate — Frontend Integration Guide

**Audience:** the frontend team building the Syndicate client.
**Status legend used throughout:**
🟢 **Live** = implemented in the backend today · 🟡 **Contract** = interface defined here, backend wiring in progress · 🔵 **Client duty** = the frontend owns this.

This guide + `protocol.ts` (copy-paste types) + `example-client.ts` (reference flow) are the complete handoff. Read `05_GAME_REQUIREMENTS_CANONICAL.md` for the player experience and `03_BUILDER_VISION_CANONICAL.md` for the UX bar; this doc is the wiring.

---

## 1. The shape of the system

The client talks to three surfaces:

1. **Gateway (WebSocket)** — the realtime channel for gameplay: auth, lobby, turn prompts, betting actions, and the public event feed. One socket per session. 🟢 (auth handshake + broadcast) / 🟡 (game messages)
2. **Solana (on-chain, via the user's wallet)** — custody: the client builds & the wallet signs **deposit**, **claim**, **refund** transactions against the Syndicate Anchor program. 🟡 (program is deployed on Devnet; IDL ships from `anchor build`)
3. **Discovery/History (read)** — live-games dashboard, historical-game archive, per-match public action timeline, profile, and leaderboard REST endpoints. 🟢

Two things the client owns end-to-end:
- 🔵 **Wallet signing** (ed25519): the login nonce, and each gameplay intent.
- 🔵 **Time-lock sealing** of the prediction (drand `tlock`) — see §6. This is non-negotiable: the prediction must be encrypted **client-side** so no one (including the server) can read it.

**Golden rule for the UI (from the vision):** never surprise the user financially. Before any chip commitment, show current wager, max risk, remaining stack, and total exposure. Every match has a defined refund/VOID path — surface it, never leave the user stuck.

---

## 2. Environments & config

The client needs these per environment (devnet/mainnet):

| Key | Example | Notes |
|-----|---------|-------|
| `GATEWAY_WS_URL` | `wss://gw.syndicate.example` | the realtime socket |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | for building/sending tx |
| `PROGRAM_ID` | `FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS` on Devnet | Syndicate program; IDL from `anchor build` |
| `CHIPS_TOKEN_MINT` | USDC mint | the betting token (default USDC) |
| `DRAND_API` | `https://api.drand.sh` | time-lock beacon |
| `DRAND_CHAIN_HASH` | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` | **quicknet** (the tlock chain) |

Feeds (launch default `BTC/USD`, `ETH/USD`, `SOL/USD`), tiers, blinds, timers, geofence blocklist, fees, and the Pyth bounded exact-after oracle window are **server-driven config** — the client reads them from the table/lobby payload, never hard-codes them (the game is tuned via config).

---

## 3. Connect & authenticate (wallet) 🟢

The gateway auth is a nonce-challenge over the WebSocket. ed25519 (Solana wallets sign ed25519 natively).

```
client →           (opens WS)
server → { "type": "challenge", "nonce": "<random>" }
client →  sign the nonce string with the wallet (ed25519) → base64
client → { "type": "auth", "wallet": "<base58 pubkey>", "signature": "<base64>" }
server → { "type": "authenticated", "wallet": "<base58>" }      // success
   or  → { "type": "error", "reason": "bad signature" } then close
```

- The **wallet (base58 pubkey) is the player identity** for the whole session and the settlement destination.
- `reason` values you must handle: `"bad signature"`, `"nonce expired"`, `"wallet mismatch"`, `"geo-blocked"` (§9).
- **Reconnect:** reopen the socket and repeat the handshake; the engine restores your seat state. All-in players are never affected by a disconnect.

The signature is over the **raw nonce string** (UTF-8), encoded base64. (Backend verifies with `crypto.verify(null, nonce, ed25519PubKey, sig)`.)

---

## 4. The player journey → what to call

| Step | Surface | Client does |
|------|---------|-------------|
| Discover games | REST read 🟢 | render the live-games dashboard (ranked by popularity; sortable by time/pot/buy-in/feed) |
| Connect wallet | Gateway 🟢 | the §3 handshake |
| Choose table & **deposit** | Solana 🟡🔵 | build + sign `deposit` tx (buy-in + entry fee) → seat is granted on **finality** |
| Enter lobby | Gateway 🟡 | show table terms (feed, token, buy-in, blinds, rake, capacity, timers, match length) |
| **Seal prediction** | Client + Gateway 🔵🟡 | tlock-encrypt the price (§6), send `sealPrediction` with the ciphertext **before LIVE** |
| Betting (3 rounds) | Gateway 🟡 | on `yourTurn`, show legal actions + exposure; send a **signed** `act`; optionally `setDefault` (check/fold) |
| Watch the market | Gateway 🟡 | render the live chart + your distance-to-conviction from the `event` feed |
| Resolution | Gateway 🟡 | uncontested win, or the sequential reveal ceremony; **all numbers open post-match** |
| **Claim / refund** | Solana 🟡🔵 | after SETTLED build+sign `claim`; after VOID build+sign `refund` |
| History | REST read 🟢 | list historical games; open a match to show settlement summary and chronological public actions |

Match lifecycle the UI should reflect: `FILLING → SEALING → LIVE(Round 1..N) → SETTLEMENT_WINDOW → DECRYPT → SETTLED` (or `VOID`).

---

## 5. Realtime gameplay messages 🟡 (contract)

Full shapes in `protocol.ts`. Summary:

**Server → client**
- `matchState` — authoritative snapshot (phase, round, pot, your stack/exposure, seats, current bet).
- `yourTurn` — `{ matchId, toCall, minRaiseTo, deadline }`. Render legal actions; the server clock governs `deadline` (don't trust local time for fairness).
- `event` — a **public** action-feed event (action/fold/round/settlement/reveal). Drives the chart, pot, and spectator view.
- `settled` / `void` — terminal; show resolution or refund.

**Client → server**
- `act` — `{ matchId, action, signature }` where `action` ∈ {fold, check, call, betTo(amount), raiseTo(amount), allIn}. **Amounts are integer chip base units** (token smallest unit). The action must be **signed** by the wallet (replay-safe intent log).
- `setDefault` — `{ matchId, default }` (`check_fold` | `check_call_any`): the pre-signed action auto-applied on timeout so a slow connection never costs a free check or stalls the table.
- `sealPrediction` — `{ matchId, ciphertext }` (§6).

**Legality (mirror server-side, but the server is authoritative):** `check` only when `toCall == 0`; `raiseTo` must be ≥ `minRaiseTo`; `call` caps at your stack (becomes all-in). The server validates and will reject illegal actions.

---

## 6. 🔵 Client-side time-lock sealing (critical)

The prediction is sealed with **drand `tlock`** so it is mathematically unreadable — by opponents *and the server* — until the match ends, when it opens automatically. **The encryption happens in the browser; the plaintext never leaves the client.**

Use drand's `tlock-js` (or `tlock_age`-compatible) library:

1. Fetch chain info from `DRAND_API/DRAND_CHAIN_HASH/info` → `{ public_key, period, genesis_time }`.
2. The lobby payload gives `timelockTargetRound` (the round at match end). If not provided, compute it: `round = floor((matchEndUnix - genesis_time + period - 1) / period) + 1`.
3. Encrypt the fixed-point price (16-byte LE i128, at the feed's precision) toward `timelockTargetRound` with the chain public key.
4. Send `{ type:'sealPrediction', matchId, ciphertext: <base64> }` **before LIVE**.

That's it — there is no "reveal" step for the user. At match end the backend fetches the round signature and decrypts everything. (The backend runs the identical scheme; it's verified live against drand.)

> Fixed-point: a price like `63000.42` at 2 decimals is the integer `6300042`. The feed's `decimals` comes from config. Do all money/price math as integers.

---

## 7. On-chain (custody) 🟡🔵

Custody is on Solana. The client builds the instruction and the **wallet signs**; the backend never holds user keys. Use `@solana/web3.js` + the Anchor IDL (emitted by `anchor build`). Current Devnet program id: `FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS`.

Program instructions and who calls them:

| Instruction | Caller | Frontend builds? |
|-------------|--------|------------------|
| `create_match` | operator | no |
| `deposit(seat_index)` | player | **yes** — buy-in + entry fee → seat eligibility |
| `lock` | operator | no |
| `submit_settlement` | backend | no |
| `claim` | player | **yes** — pull your payout after SETTLED |
| `void` | operator | no |
| `refund` | player | **yes** — reclaim deposit + entry fee after VOID |

PDAs (for deriving accounts): match `["match", match_id]`, vault token account `["vault", matchPda]`, seat `["seat", matchPda, playerPubkey]`. The IDL encodes these; with Anchor's TS client you mostly call `program.methods.deposit(...).accounts({...}).rpc()`.

Flow notes:
- **Deposit gates the seat** — the player is only seated once the deposit **finalizes**; show a clear "confirming" state and only enter the lobby on finality.
- **Claim is idempotent and pull-based** — safe to retry; the program rejects double-claims.
- Fees: an entry fee (at deposit) and a pot rake (at settlement) are disclosed in the table terms; the entry fee is refunded on VOID/leave-before-LIVE.
- Pyth settlement is backend-only. The frontend never calls Hermes and never sees `PYTH_API_KEY`; history/replay may show the public `PythOracleProofView` fields from `protocol.ts`.

---

## 8. Discovery, history & spectating 🟢

- **Live-games dashboard:** a list of live games ranked by popularity (a "rated" score), sortable by `gameTime | potSize | buyIn | feed`. Each item: `{ matchId, feed, buyIn, potSize, spectators, startedAt }`.
- **Spectate:** `subscribe` to a match to receive its public `event` feed (same redacted events players see). Spectators never receive sealed predictions, queued intents, or wallets — only public, pseudonymous (seat-indexed) data. Numbers open for everyone post-match.

### REST read endpoints 🟢

Base URL is the action-feed read service.

| Endpoint | Purpose |
|----------|---------|
| `GET /active-games` | Returns `{ games: LiveGame[] }`, ranked by live popularity. |
| `GET /matches/history?limit=50&cursor=<opaque>&status=settled\|voided\|live\|all` | Returns `{ matches, nextCursor? }`. With no `status`, only historical terminal games (`settled`/`voided`) are returned. Use `status=all` only for admin/internal views that also need live matches. |
| `GET /matches/:matchId/history` | Returns `{ match }` for the historical-game detail header: status, feed, buy-in, settlement price, replay URI, and summary counters. |
| `GET /matches/:matchId/actions` | Returns `{ matchId, events }`, a chronological public timeline for the history page. This is the endpoint to render "what happened in the game". |
| `GET /matches/:matchId/replay` | Returns `{ bundle }` and uploads/returns an object-store replay URI for durable sharing/audit export. The UI can use `/actions` for normal page rendering and `/replay` for downloadable proof bundles. |
| `GET /profiles/:userId` | Returns `{ profile }` with public aggregate stats. |
| `GET /leaderboard` | Returns `{ entries }`. |

Redaction guarantee: `/matches/:matchId/actions` and `/matches/:matchId/replay` emit only `PublicEvent` records from `protocol.ts`. They never include wallet addresses, sealed ciphertexts, queued/pre-signed intents, or hidden predictions before the time-lock opens. Public identity inside the history timeline is `seat` only.

Settlement proof display: when present, render `oracleProof` as the audit block for the match. It contains the Pyth feed id, selected publish time, selected price, confidence, exponent, Pyth Receiver price update account, atomic settlement tx signature, Pro-compatible Receiver/Wormhole/Push ids, Hermes response hash, and binary update hash. The canonical unavailable/VOID message is exactly `Pyth Oracle price for settlement is unavailable.`

Frontend archive flow:
1. Call `GET /matches/history?limit=50` for the archive page.
2. Use `nextCursor` for infinite scroll or pagination; treat it as opaque.
3. On match open, call `GET /matches/:matchId/history` for the header and `GET /matches/:matchId/actions` for the action timeline.
4. Offer a replay/export button backed by `GET /matches/:matchId/replay` when the user wants a durable audit bundle.

---

## 9. Errors, geofencing & VOID — the UI must handle all of these

| Situation | Signal | UI |
|-----------|--------|----|
| Restricted region | `error: geo-blocked` on connect | block entry with a clear message |
| Auth failure | `error: bad signature / nonce expired / wallet mismatch` | re-prompt sign |
| Table didn't fill | `void` (reason: not enough players) | auto full refund — reassure + offer refund/claim |
| Oracle degraded / beacon down | `void` | full refund; "match voided, funds returned" |
| You disconnect mid-hand | (reconnect) | pre-signed default protects you; all-in stake safe; resume on reconnect |
| Settlement done | `settled` | resolution UI + enable `claim` |

Every VOID is a **full refund** (entry fee included). Never present a VOID as a loss.

---

## 10. UX invariants to honor (acceptance bar)

From `03_BUILDER_VISION_CANONICAL.md` / `05 §15` — these are requirements, not suggestions:
1. Show exposure (wager, max risk, remaining stack, total exposure) **before** every commit.
2. Never display a prediction before the time-lock opens; folded numbers stay hidden until post-match.
3. Disconnect must never auto-fold a free check or endanger an all-in stake; offer the pre-signed default.
4. Every state has a path out (refund/void) — no dead ends.
5. Settlement is independently verifiable — expose the match record (price, samples, tx) in history.
6. Both the uncontested win and the contested reveal are **premium ceremonies**, not instant pops.
7. Positioning: a contest of conviction & capital discipline — never claim the player will "out-predict the market."

---

## 11. Getting started checklist

- [ ] Implement the WS auth handshake (§3) with the wallet adapter (ed25519 sign of the nonce).
- [ ] Integrate `tlock-js` for client-side prediction sealing (§6).
- [ ] Wire `@solana/web3.js` + the Anchor IDL for `deposit` / `claim` / `refund` (§7).
- [ ] Build the table/lobby + betting UI against `protocol.ts` types; render the `event` feed + chart.
- [ ] Handle every error/VOID path (§9) and the UX invariants (§10).
- [ ] Use `example-client.ts` as the reference for the end-to-end flow.

**Coordinate with backend on:** the final `matchState`/`yourTurn`/`lobby` payload fields, the IDL/`PROGRAM_ID`, and the per-environment config in §2. Those are the 🟡 items being finalized.
