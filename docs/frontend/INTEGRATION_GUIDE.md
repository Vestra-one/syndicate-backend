# Syndicate — Frontend Integration Guide

**Audience:** the frontend team building the Syndicate client.  
**Handoff bundle:** this guide · [`protocol.ts`](./protocol.ts) · [`example-client.ts`](./example-client.ts) · IDL at [`idl/syndicate_program.json`](./idl/syndicate_program.json)

**Status legend:** 🟢 live in backend today · 🟡 contract defined / partial wiring · 🔵 client duty

Canon for player experience: `05_GAME_REQUIREMENTS_CANONICAL.md`. This doc is the wiring map.

---

## 1. System shape

The client talks to four surfaces:

| Surface | Role | Status |
|---------|------|--------|
| **Gateway (WebSocket)** | Auth, lobby, turns, signed actions, defaults, prediction seal | 🟢 |
| **Config (REST)** | Table terms, tiers, feed catalog | 🟢 |
| **Action-feed (REST)** | Live games, history, public timeline, replay export | 🟢 |
| **Solana (wallet)** | `deposit`, `claim`, `refund` against the Syndicate program | 🟢 on devnet |

**Client-owned (non-negotiable):**

- 🔵 Wallet signing — gateway auth nonce, every gameplay intent, prediction commitment messages.
- 🔵 Time-lock sealing — drand `tlock` encrypts the prediction in-browser; plaintext never leaves the client.

**Golden rule:** never surprise the user financially. Before any chip commitment, show wager, max risk, remaining stack, and total exposure. Every match has a refund/VOID path.

---

## 2. Environment config

Per environment (devnet staging / mainnet):

| Key | Devnet example | Notes |
|-----|----------------|-------|
| `GATEWAY_WS_URL` | `wss://gw.example.com` | Realtime socket |
| `CONFIG_URL` | `https://config.example.com` | `GET /config/table?matchId=…` |
| `ACTION_FEED_URL` | `https://feed.example.com` | History & discovery REST |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Tx build/send (client-side) |
| `PROGRAM_ID` | `FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS` | Team devnet staging id; yours may differ |
| `CHIPS_TOKEN_MINT` | SPL mint pubkey | Betting token (e.g. USDC on devnet) |
| `DRAND_API` | `https://api.drand.sh` | Time-lock beacon |
| `DRAND_CHAIN_HASH` | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` | quicknet chain |

**Do not hard-code:** blinds, timers, fees, geofence, Pyth feed ids, oracle window — these come from `TableTerms` / config service.

**Pyth:** settlement is **backend-only**. The frontend never calls Hermes and never sees `PYTH_API_KEY`. History may include a public `PythOracleProofView` audit block after settlement.

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
| Discover games | Action-feed REST 🟢 | `GET /active-games` |
| Connect | Gateway 🟢 | §3 handshake |
| Queue / join room | Gateway 🟢 | `queueStatus` / `lobbyState` |
| **Deposit** | Solana 🟢🔵 | Build + sign `deposit` (buy-in + entry fee) → wait **finality** |
| Lobby | Gateway 🟢 | `tableTerms` + `matchState` |
| **Seal prediction** | Client + Gateway 🟢 | tlock encrypt (§6) + signed `sealPrediction` / commitment |
| Betting | Gateway 🟢 | On `yourTurn`, send signed `act`; optional `setDefault` |
| Watch market | Gateway 🟢 | `event` feed + chart |
| Resolution | Gateway 🟡 | `settled` / `void` ceremonies |
| **Claim / refund** | Solana 🟢🔵 | After SETTLED → `claim`; after VOID → `refund` |
| History | Action-feed REST 🟢 | `/matches/history`, `/matches/:id/actions` |

Lifecycle UI: `FILLING → SEALING → LIVE → SETTLEMENT_WINDOW → DECRYPT → SETTLED` (or `VOID`).

---

## 5. Realtime messages

Full shapes in [`protocol.ts`](./protocol.ts).

**Server → client:** `tableTerms`, `matchState`, `yourTurn`, `event`, `settled`, `void`, `queueStatus`, `lobbyState`

**Client → server:**

- `act` — `{ matchId, action, signature }` with signed intent (see `SignedActionIntentWire` in protocol.ts). Amounts are **integer chip base units**.
- `setDefault` — pre-signed timeout policy (`check_fold` | `check_call_any`).
- `sealPrediction` — `{ matchId, ciphertext }` before LIVE.

Intent message bytes must match `services/shared/src/intent.rs` and `services/settlement-chain/src/intent.ts`.

---

## 6. Time-lock sealing 🔵

Prediction sealed with **drand tlock** — unreadable until match end.

1. `GET ${DRAND_API}/${DRAND_CHAIN_HASH}/info` → `{ public_key, period, genesis_time }`
2. Use `timelockTargetRound` from `TableTerms` (or compute from match end time).
3. Encrypt fixed-point price (16-byte LE i128 at feed `decimals`) toward that round.
4. Send `{ type: 'sealPrediction', matchId, ciphertext: base64 }` before LIVE.

Backend opens at match end via drand; user never manually reveals.

Also register an on-chain **prediction commitment** (hash + blinding) via the backend orchestration path — the gateway/engine records `SignedPredictionCommitmentWire` for settlement replay.

---

## 7. On-chain custody 🟢🔵

Program id (devnet staging): **`FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS`**. Use your operator's id in production.

| Instruction | Who signs | Frontend builds? |
|-------------|-----------|------------------|
| `create_match` | operator | no |
| `deposit` | player | **yes** |
| `lock` / sealing / action-log | operator/backend | no |
| `submit_settlement` | settlement admin + Pyth | no |
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
2. **Reference builders** — `services/settlement-chain/src/custody.ts` (operator path); mirror discriminators + Borsh for player ix

### Flow notes

- Seat granted only after deposit **finalizes** — show confirming state.
- `claim` is idempotent (safe retry).
- Entry fee refunded on VOID / leave-before-LIVE; disclosed in `TableTerms`.
- Match bootstrap returns `{ matchId, onchainMatchId, matchPda }` from matchmaking/orchestrator — propagate to deposit + gateway.

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

### Pyth audit block

When present, render `oracleProof` (`PythOracleProofView`):

- Feed id, price, publish time, confidence, exponent
- `priceUpdateAccount`, settlement tx signature(s)
- `settlementMode`: `atomic` or `two_step`
- Receiver / wormhole / push program ids, Hermes/binary hashes

Canonical VOID when oracle unavailable: **`Pyth Oracle price for settlement is unavailable.`**

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

Every VOID = **full refund** including entry fee.

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
- [ ] `tlock-js` prediction sealing (§6)
- [ ] Anchor IDL integration for `deposit` / `claim` / `refund` (§7)
- [ ] Signed intents for `act` / `setDefault` / prediction commitment
- [ ] Use `onchainMatchId` string + `PDA_SEEDS` for all PDAs
- [ ] Table/lobby UI from `protocol.ts` types
- [ ] History + oracle proof display (§8)
- [ ] All VOID/error paths (§9)
- [ ] Reference flow in [`example-client.ts`](./example-client.ts)

**Backend IDs in API responses:** matchmaking, orchestrator, and gateway `tableTerms` include `onchainMatchId` and `matchPda` when available — always prefer these over recomputing from UUID `matchId`.
