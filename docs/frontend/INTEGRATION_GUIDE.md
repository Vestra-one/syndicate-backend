# Syndicate — Frontend Integration Guide

**Audience:** the frontend team building the Syndicate client.  
**Handoff bundle:** this guide · [`protocol.ts`](./protocol.ts) · [`example-client.ts`](./example-client.ts) · IDL at [`idl/syndicate_program.json`](./idl/syndicate_program.json)

**Status legend:** 🟢 live in backend today · 🟡 contract defined / partial wiring · 🔵 client duty

Canon for player experience: `05_GAME_REQUIREMENTS_CANONICAL.md`. This doc is the wiring map.

---

## 1. System shape

The client talks to five surfaces:

| Surface | Role | Status |
|---------|------|--------|
| **Gateway (WebSocket)** | Auth, lobby push, turns, signed actions, defaults, prediction seal | 🟢 |
| **Matchmaking (REST)** | Create/join rooms by **reporting txhashes**, lobby feed (`GET /rooms`) | 🟡 |
| **Config (REST)** | Table terms, tiers, feed catalog, template allowlist | 🟢 |
| **Action-feed (REST)** | Live games, history, public timeline, replay export | 🟢 |
| **Solana (wallet)** | `create_and_deposit`, `deposit`, `register_prediction_commitment`, `claim`, `refund` | 🟢 on devnet |

**v1 model — player-created, no indexer:** the backend NEVER creates matches. A host runs
`create_and_deposit` and **reports the txhash** (`POST /rooms`); joiners run `deposit` and report
theirs (`POST /matches/:matchId/deposits`). The backend verifies each finalized tx on-chain before
registering it. Settlement uses a **company-signed price** (secp256k1/EIP-191), not Pyth.

**Client-owned (non-negotiable):**

- 🔵 Wallet signing — gateway auth nonce, every gameplay intent, and the on-chain `create_and_deposit` /
  `deposit` / `register_prediction_commitment` / `claim` / `refund` instructions.
- 🔵 Time-lock sealing — drand `tlock` encrypts the prediction in-browser; plaintext never leaves the client.
- 🔵 Txhash reporting — after each on-chain tx finalizes, report its signature to matchmaking.

**Golden rule:** never surprise the user financially. Before any chip commitment, show wager, max risk, remaining stack, and total exposure. Every match has a refund/VOID path.

---

## 2. Environment config

Per environment (devnet staging / mainnet):

| Key | Devnet example | Notes |
|-----|----------------|-------|
| `GATEWAY_WS_URL` | `wss://gw.example.com` | Realtime socket |
| `CONFIG_URL` | `https://config.example.com` | `GET /config/table?matchId=…` |
| `ACTION_FEED_URL` | `https://feed.example.com` | History & discovery REST |
| `PRICE_FEED_URL` | `https://price.devnet.satoshitable.fun` | Signed-price feed REST (`/prices`, `/prices/at`) — read-only |
| `PRICE_FEED_WS_URL` | `wss://price.devnet.satoshitable.fun/ws` | Live price ticker (`?symbols=BTCUSD,…`) |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Tx build/send (client-side) |
| `PROGRAM_ID` | `2LR4uxkMoGCGZZ9vVGeyyVAxtGF3DC3P5Y9RP7zmuAPT` | Team devnet staging id; yours may differ |
| `CHIPS_TOKEN_MINT` | SPL mint pubkey | Betting token (e.g. USDC on devnet) |
| `DRAND_API` | `https://api.drand.sh` | Time-lock beacon |
| `DRAND_CHAIN_HASH` | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` | quicknet chain |

**Do not hard-code:** blinds, timers, fees, geofence, the price-feed token, `config_hash` — these come from `TableTerms` / config templates (`GET /config/templates`).

**Oracle:** settlement uses a **company-signed price** (secp256k1/EIP-191), produced backend-side by the signed-price-server — the frontend never signs prices, and settlement is driven entirely backend-side. The FE **may read** the public signed-price feed for display only: a live ticker over `PRICE_FEED_WS_URL` (`/ws`) and exact-second lookups over `PRICE_FEED_URL` (`/prices`, `/prices/at`). Each payload carries the signer's `token/price_in_wad/timestamp/v/r/s` and can be verified client-side against the on-chain `price_signer`. History also includes a public `SignedPriceView` audit block after settlement. There is no Pyth/Hermes. The feed's admin/ops routes (`/internal/*`, `/metrics`) are not exposed.

Refresh IDL after program upgrades (operator runs on build host):

```bash
./scripts/emit-anchor-idl.sh
# → docs/frontend/idl/syndicate_program.json
```

---

## 3. Connect & authenticate 🟢

```
client →           (opens WS)
server → { "type": "challenge", "nonce": "<random>" }
client →  sign UTF-8(nonce) with wallet → base64
client → { "type": "auth", "wallet": "<base58>", "signature": "<base64>" }
server → { "type": "authenticated", "wallet": "<base58>" }
   or  → { "type": "error", "reason": "bad signature" | "nonce expired" | "wallet mismatch" | "geo-blocked" }
```

- Wallet base58 pubkey = session identity and settlement destination.
- Reconnect: repeat handshake; engine restores seat state.

---

## 4. Player journey

| Step | Surface | Client |
|------|---------|--------|
| Discover games | Matchmaking REST / gateway 🟡 | `GET /rooms` or `subscribeLobby` (pushed `roomsUpdated`) |
| Connect | Gateway 🟢 | §3 handshake |
| **Host create** | Solana + Matchmaking 🟢🔵 | `create_and_deposit` → **report** `createTxSig` via `POST /rooms` |
| **Join (deposit)** | Solana + Matchmaking 🟢🔵 | `deposit` → **report** `depositTxSig` via `POST /matches/:id/deposits` → wait **finality** |
| Lobby | Gateway 🟢 | `tableTerms` + `matchState` |
| **Seal prediction** | Client + Solana + Gateway 🟢🔵 | tlock encrypt (§6) + **one popup** `register_prediction_commitment` + `sealPrediction` |
| Betting | Gateway 🟢 | On `yourTurn`, send signed `act`; optional `setDefault` |
| Watch market | Gateway 🟢 | `event` feed + chart |
| Resolution | Gateway 🟡 | `settled` / `void` ceremonies |
| **Claim / refund** | Solana 🟢🔵 | After SETTLED → `claim`; after VOID → `refund` |
| History | Action-feed REST 🟢 | `/matches/history`, `/matches/:id/actions` |

Lifecycle UI: `FILLING → SEALING → LIVE → SETTLEMENT_WINDOW → DECRYPT → SETTLED` (or `VOID`).

---

## 5. Realtime messages

Full shapes in [`protocol.ts`](./protocol.ts).

Every server envelope carries **`serverTime`** (gateway clock, ms). Sync your local clock to it and
render countdowns as `deadline - serverTime + localOffset` (`remainingMs` helper in protocol.ts)
against the **absolute** engine deadlines — the gateway never synthesizes a deadline, so an absent
one means "unknown", not "now + 25s".

**Server → client:** `tableTerms`, `matchState`, `yourTurn` (+ `yourTurnDeadline`/`sealEndsAt`/
`bettingEndsAt`/`matchEndsAt`), `event`, `settled`, `void`, `queueStatus`, `lobbyState`, `lobbyList`,
`roomsUpdated`.

**Client → server:**

- `act` — `{ matchId, action, signature }` with signed intent (see `SignedActionIntentWire` in protocol.ts). Amounts are **integer chip base units**.
- `setDefault` — pre-signed timeout policy (`check_fold` | `check_call_any`).
- `sealPrediction` — `{ matchId, seatIndex, ciphertext, commitmentHex, targetRound, blindingHex, signature }` during SEALING (after the on-chain commitment, §6).
- `subscribeLobby` / `unsubscribeLobby` — opt into pushed `roomsUpdated` lobby updates (discard stale ones by `update.version`).

Intent message bytes must match `services/shared/src/intent.rs` and `services/settlement-chain/src/intent.ts`.

---

## 6. Time-lock sealing 🔵

Prediction sealed with **drand tlock** — unreadable until match end.

1. `GET ${DRAND_API}/${DRAND_CHAIN_HASH}/info` → `{ public_key, period, genesis_time }`
2. Use `timelockTargetRound` from `TableTerms` — it satisfies the on-chain two-sided bound
   `(latest_match_end, latest_match_end + 20s]`. Never use a placeholder round.
3. Encrypt fixed-point price (16-byte LE i128 at feed `decimals`) toward that round → `ciphertext`.
4. Compute `commitmentHex = H(prediction || blinding)` — **must** match the contract's
   `prediction_commitment` semantics (verify against `services/programs` + `services/timelock`).
5. **One wallet popup:** sign + submit `register_prediction_commitment({ onchainMatchId, commitmentHex, timelockTargetRound })`. No session key / delegate.
6. Send `{ type: 'sealPrediction', matchId, seatIndex, ciphertext, commitmentHex, targetRound, blindingHex, signature }` so the gateway stores the ciphertext + blinding.

**Store contract:** the ciphertext you upload here is EXACTLY what the worker reads at settlement
(same store, same key derivation) to decrypt + binding-check against the on-chain commitment. The
backend opens at match end via drand; the user never manually reveals.

---

## 7. On-chain custody 🟢🔵

Program id (devnet staging): **`2LR4uxkMoGCGZZ9vVGeyyVAxtGF3DC3P5Y9RP7zmuAPT`**. Use your operator's id in production.

| Instruction | Who signs | Frontend builds? |
|-------------|-----------|------------------|
| `create_and_deposit` | host (player) | **yes** — then report `createTxSig` |
| `deposit` | player | **yes** — then report `depositTxSig` |
| `register_prediction_commitment` | player | **yes** (one popup, during SEALING) |
| `lock` / `begin_live` | operator/backend | no |
| `submit_settlement` | settlement admin (carries the signed price) | no |
| `claim` | player | **yes** (after SETTLED) |
| `refund` | player | **yes** (after VOID) |

### PDAs

Use **`onchainMatchId`** (string u64) — never `Number()` it for large ids.

```typescript
import { PDA_SEEDS } from './protocol.ts';

const [matchPda] = PublicKey.findProgramAddressSync(
  PDA_SEEDS.match(onchainMatchId),
  programId,
);
```

Seeds: match `["match", u64_le(onchainMatchId)]`, vault `["vault", matchPda]`, seat `["seat", matchPda, player]`.

### Integration options

1. **Anchor TS client** — IDL at `docs/frontend/idl/syndicate_program.json`
2. **Reference builders** — `services/settlement-chain/src/custody.ts`; mirror discriminators + Borsh for player ix

### Flow notes

- The host derives `onchainMatchId` + `matchPda` client-side, runs `create_and_deposit`, then reports `createTxSig` to `POST /rooms`. The backend verifies the finalized tx before the room appears.
- Joiners run `deposit` then report `depositTxSig`; the seat is granted only after the backend verifies the **finalized** tx — show a confirming state.
- `claim` is idempotent (safe retry). Entry fee refunded on VOID / leave-before-LIVE; disclosed in `TableTerms`.
- The registry is **UX-only**: even a room the backend never heard about can still be refunded on-chain permissionlessly. Capital safety never depends on reporting succeeding.

---

## 8. Discovery & history 🟢

Base: **action-feed** service.

| Endpoint | Purpose |
|----------|---------|
| `GET /active-games` | Live dashboard |
| `GET /matches/history?limit=50&cursor=…` | Archive (terminal matches default) |
| `GET /matches/:matchId/history` | Match header + settlement summary |
| `GET /matches/:matchId/actions` | Public action timeline |
| `GET /matches/:matchId/replay` | Durable replay bundle URI |
| `GET /profiles/:userId` | Public stats |
| `GET /leaderboard` | Rankings |

Redaction: public endpoints never expose wallets, sealed ciphertexts, or pre-signed intents before time-lock open. Identity in timelines = **seat index** only.

### Signed-price audit block

When present, render `oracleProof` (`SignedPriceView`):

- `tokenHex` (20-byte price token), `price` (display) + `priceInWadHex`, `timestampMs`
- `signerHex` — the recovered signer; equals `ProtocolState.price_signer`
- `v` / `rHex` / `sHex` — the secp256k1/EIP-191 signature
- `settlementTxSignatures` — the settle tx that carried this price + payouts

Canonical VOID when the oracle is unavailable: the backend emits `void` with a reason string such as
`"OracleDegraded"` — the signed-price-server failed to produce a valid signed price (no Pyth).

---

## 9. Errors & VOID

| Situation | Signal | UI |
|-----------|--------|-----|
| Geo-blocked | `error: geo-blocked` | Block entry |
| Auth fail | `bad signature` / `nonce expired` | Re-prompt sign |
| Table didn't fill | `void` | Full refund messaging |
| Oracle/beacon failure | `void` | Full refund |
| Disconnect mid-hand | reconnect | Default policy protects free check |
| Settled | `settled` | Resolution + enable `claim` |

VOID refund rules (see `VoidKind` in contract `state.rs`):
- `FillingVoid` / `Emergency` — **full refund** to everyone (deposit + entry fee).
- `UnderMinSealed` (too few sealed at `begin_live`) — sealers: full refund + pro-rata share of non-sealer penalty pool; non-sealers: `deposit − penalty` only (entry fee forfeited to treasury).

---

## 10. UX invariants

1. Show exposure before every commit.
2. Never show predictions before time-lock opens.
3. Disconnect must not auto-fold a free check or endanger all-in.
4. Every state has an exit (refund/void/claim).
5. Post-match: expose verifiable settlement record (price, oracle proof, tx).
6. Uncontested win and contested reveal are ceremonies, not instant pops.

---

## 11. Checklist

- [ ] WS auth handshake (§3) with wallet adapter
- [ ] `tlock-js` prediction sealing + on-chain `register_prediction_commitment` (one popup, §6)
- [ ] Anchor IDL integration for `create_and_deposit` / `deposit` / `claim` / `refund` (§7)
- [ ] Txhash reporting: `POST /rooms` (host) + `POST /matches/:id/deposits` (joiner)
- [ ] Signed intents for `act` / `setDefault`
- [ ] Clock-sync: track `serverTime`, render countdowns from forwarded absolute deadlines (`remainingMs`)
- [ ] Use `onchainMatchId` string + `PDA_SEEDS` for all PDAs
- [ ] Lobby UI from `GET /rooms` + pushed `roomsUpdated`
- [ ] History + `SignedPriceView` proof display (§8)
- [ ] All VOID/error paths (§9)
- [ ] Reference flow in [`example-client.ts`](./example-client.ts)

**Backend IDs in API responses:** matchmaking, orchestrator, and gateway `tableTerms` include `onchainMatchId` and `matchPda` when available — always prefer these over recomputing from UUID `matchId`.
