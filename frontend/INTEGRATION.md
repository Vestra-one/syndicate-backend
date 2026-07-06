# Syndicate v2 — Frontend Integration Guide

Everything the UI needs to build the three screens — **Play** (public lobby + private
rooms), **Live games** (spectate), **Historical games** — plus wallets, sealing, betting,
reconnect, and claims. This is the single authoritative frontend guide for v2.

## 1. Environments & endpoints

| | Devnet |
|---|---|
| REST base | `https://api.devnet.satoshitable.fun/v1` |
| WebSocket | `wss://api.devnet.satoshitable.fun/v1/ws` |
| Price feed (read-only) | `https://price.devnet.satoshitable.fun` (`GET /prices`, WS `/ws`) |
| Solana cluster | devnet |
| Program id | `91BSZ2pEGCk7Scq9bnfTwrHCYGo8CzGBq5mbpKHAR5FK` |
| Chips mint (SPL) | `3Gdd9ew2Dq63QeJETc7krKB2JJ1GaHfBZvMzBdAy541X` (6 decimals) |
| IDL | [`docs/frontend/idl/syndicate_program.json`](idl/syndicate_program.json) |
| drand beacon | quicknet — chain `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, genesis `1692803367`, period `3s`, scheme `bls-unchained-g1-rfc9380` |

Conventions: chips are u64 JSON numbers (USDC base units, 6 decimals); prices are decimal
strings with an `expo` field (fixed exponent −18 on-chain); all timestamps are **ms epoch
u64**; every REST/WS payload from the server carries `server_time_ms` — use it for clock
sync (`skew = server_time_ms - Date.now()`), and render all countdowns from absolute
deadline timestamps, never from "seconds remaining".

## 2. Auth

Identity = wallet. Session flow:

```
FE                                  backend
│ POST /v1/auth/nonce {wallet}        │
│◄─ {nonce}                           │   (2-min TTL)
│ wallet.signMessage(nonce utf8)      │
│ POST /v1/auth/verify                │
│   {wallet, signature: base64}       │
│◄─ {session, expires_at}             │   (24h; sha256(token) stored server-side)
```

Use `Authorization: Bearer <session>` on wallet-bound REST routes. The same
challenge/response runs inside the WS (`challenge` → `auth` → `authenticated`).
Spectating (lobby + match channels, public reads) needs **no** auth.

## 3. Who signs what

| Signed by the **player's wallet** (FE builds from IDL or server template) | Signed by the **backend operator** (automatic) |
|---|---|
| `create_and_deposit` (create room + first seat) | `lock` (confirm seats, start sealing) |
| `deposit` (join as seat candidate) | `begin_live` (start betting; button derived on-chain) |
| `register_prediction_commitment` (seal) | `submit_settlement` |
| `claim` (winnings) / `refund` (voids + unseated candidates) | `void_before_start` / `void_live_after_deadline` (also permissionless) |

PDAs (program `91BS…`): protocol `["protocol"]` · match `["match", u64_le(onchain_match_id)]` ·
vault `["vault", match_pda]` · seat `["seat", match_pda, player_pubkey]`. There is **no
seat-index PDA in v2.**

Gameplay actions (bet/fold/…) and seals are **off-chain ed25519 message signatures** (§8,
§9) — no transaction, no fees, instant.

## 4. Create a room (public or private)

```
FE                                          backend                          chain
│ (private only) implicit — code comes from the intent
│ POST /v1/rooms/intents  (session)           │
│  {feed:"BTC/USD", buy_in:50000000,          │ validates bounds,
│   fill_window_sec:300, min_players:2,       │ allocates onchain_match_id,
│   max_players:5,                            │ generates room_code if private
│   streets:{count:3, durations_sec:[220,160,120],
│            observation_sec:[20,20,40]},     │
│   visibility:"private"}                     │
│◄─ 201 {intent_id, onchain_match_id,         │
│        match_pda, room_code?,               │   room_commitment =
│        room_commitment,                     │   sha256(roomcode ‖ creator_pubkey)
│        create_params:{...full v2 CreateParams incl. config_hash...},
│        timelock_target_hint, expires_at}    │   (reservation TTL 10 min)
│ build create_and_deposit(create_params) ──────────────────────────────────► sign+send
│ POST /v1/rooms {intent_id, tx_sig}          │ RPC-verifies at finalized
│◄─ 202 {match_id, seat_status:"pending_verify"}
│ poll GET /v1/matches/{match_id} or subscribe WS ─ lobby renders when verified
```

- The **creator becomes the first seat candidate** in the same transaction.
- `create_params` is byte-exact: encode the fields in order with Borsh (or use the IDL);
  the server already computed `config_hash` (sha256 of the canonical param JSON — recipe
  in Appendix A) and `room_commitment` (zeroed 32 bytes for public rooms).
- Idempotent: re-POSTing the same `{intent_id, tx_sig}` returns the prior result.

## 5. Join a room

**Public**: pick from `GET /v1/lobby`. **Private**: user pastes the code →
`GET /v1/rooms/code/{code}` (session) → `200 {match_id, params, seats_confirmed,
candidates, fill_deadline, join_commitment}` or `404` if unknown/expired/full.
`join_commitment = sha256(roomcode ‖ joiner_pubkey)` — the server computes it for you.

```
│ build deposit(join_commitment) tx  ────────────────────────────────────► sign+send
│    (public rooms: join_commitment = 32 zero bytes)
│ POST /v1/matches/{id}/deposits {tx_sig, room_code?}   (code required if private)
│◄─ 202 {candidate_id, status:"pending_verify"}
│ GET /v1/matches/{id}/candidates/{wallet}
│◄─ {status: pending_verify → candidate → confirmed | not_confirmed | rejected,
│    seat_index?, finalized_slot?, reason?}
```

**Candidate → confirmed semantics (show this in the UI):** an on-chain deposit makes you a
*candidate* only. Seats are confirmed first-come-first-served by **deposit finality order**
when the game locks. If the table fills before your deposit finalizes, you become
`not_confirmed` and your full deposit + entry fee is **refundable immediately** (§12) —
surface it via `/v1/wallets/{wallet}/claimables`.

## 6. Lobby & lists (the three screens)

- **Play / Public**: `GET /v1/lobby?feed=&buy_in_min=&buy_in_max=&cursor=` → filling
  public rooms `{match_id, onchain_match_id, feed, buy_in, streets, confirmed, candidates,
  min_players, max_players, fill_deadline, phase}`. Private rooms never appear here.
  Subscribe WS channel `lobby` for `lobby_delta` pushes (upsert / started / retired).
- **Live games**: `GET /v1/matches/live?cursor=` → Sealing/Live matches with
  `{pot, round, to_act_seat, scheduled_end, feed_price}`. Anyone can open one and
  spectate over WS (no auth).
- **Historical**: `GET /v1/matches/history?cursor=` → settled/voided matches, keyset-paginated.
- **Detail**: `GET /v1/matches/{id}` → params, phase, seats (wallet, stack, committed,
  folded, sealed flag, engine_seat), timing (street schedule with absolute open/close
  timestamps), pot, `to_act` + deadline, and after settlement a `reveal` block
  `{settlement_price, predictions:[{seat, price, source:"sealed"|"spot"}]}`.
- **Event log**: `GET /v1/matches/{id}/events?after_seq=&limit=` — every action with its
  `feed_price` stamp (§8). Sealed ciphertexts are redacted until reveal.

## 7. Game start, sealing, dealer

When the room fills (or the fill deadline passes with ≥ min players) the backend locks
on-chain. WS pushes `phase {phase:"sealing", seal_deadline, timelock_target, ...}`.

**Sealing UX** (the player has `seal_window_sec` — default 20s — to seal):

1. Player picks a price prediction (i128, exponent −18 — e.g. $64,123.50 → `64123.5e18`).
2. Encrypt it with **tlock** to the drand round the server gave you (`timelock_target` in
   the `phase` message — already bounds-checked to publish just after match end):
   ```ts
   import { timelockEncrypt, roundTime } from "tlock-js";      // pin tlock-js@^0.9
   import { HttpChainClient, HttpCachingChain } from "drand-client";
   const chain = new HttpCachingChain("https://api.drand.sh/52db9ba7...971");
   const ciphertext = await timelockEncrypt(timelock_target, priceBytesLe, new HttpChainClient(chain));
   ```
3. `commitment = sha256(ciphertext)` (32 bytes).
4. Send the on-chain tx `register_prediction_commitment {commitment, timelock_target}`
   (player-signed; seat must be confirmed).
5. Submit to the backend (WS `seal` or `POST /v1/matches/{id}/seal`):
   `{ciphertext_b64, commitment_hex, timelock_target, signature, seal_tx_sig}` where
   `signature` is the ed25519 seal-intent signature (message layout in Appendix B).

**If a player doesn't seal, they still play**: the backend snapshots the signed feed price
at the seal deadline and uses it as their prediction (revealed as `source:"spot"`). Show
non-sealers a "price assigned at seal close" badge.

**Dealer button** is derived **on-chain** from the sealing data (keccak over the seal
commitments — Appendix A) — WS `phase {phase:"live", button, live_start, scheduled_end}`
tells you the seat. The button advances clockwise every street.

## 8. Betting loop

Streets and their durations are exactly what the creator configured. Turn flow over WS:

- `your_turn {seat, to_call, min_raise_to, deadline_ms}` — the fixed per-action timer;
  `deadline_ms` is absolute and already capped by the street close.
- Send `act {match_id, seat_index, nonce, prev_head_hex, action, signature}` with
  `action ∈ fold | check | call | bet_to{amount} | raise_to{amount} | all_in`.
  `nonce` increments per seat; `prev_head_hex` is the current action-chain head from the
  last `action` message / snapshot (replay protection). Signature layout in Appendix B.
- Acting early passes the turn immediately — the next `your_turn` fires at once.
- `set_default {policy: check_fold | check_call_any, signature}` — applied automatically
  on timeout (check when free, else fold / call anything).
- Broadcast to everyone: `action {seq, seat, action, pot, current_bet, to_act, feed_price,
  feed_price_expo, feed_price_ts, head_hex}` — **`feed_price` is the live feed price at
  the moment the action was accepted**; render it next to the bet (the bluff-reading
  feature). History replays return identical stamps.
- `phase` messages carry street transitions with the full street schedule.

## 9. Reconnect / cold return (logged out, tab closed, network drop)

All state lives server-side; the socket is stateless.

1. Re-auth (§2).
2. `GET /v1/wallets/{wallet}/active` → every non-terminal seat/candidacy + settled-unclaimed:
   `[{match_id, phase, seat_index, your_turn?, deadline_ts}]`. Deep-link the user straight
   back to the table.
3. WS `subscribe {channel:{match:{match_id}}, last_seq:0}` → server sends
   `snapshot {state, last_seq}` (current table view) followed by `event {seq, ...}` for the
   **complete ordered history**, then the live stream — gap-free, dedup by `seq`. Pass your
   last seen `last_seq` instead of 0 to fetch only the delta.
4. Deadlines are absolute; if the player timed out while away, the default action is
   already in the history.

## 10. Settlement & reveal

At `scheduled_end` the backend decrypts the sealed predictions (drand key is public by
then), assigns spot prices to non-sealers, fetches the signed settlement price for exactly
`scheduled_end_ts`, computes pots/side-pots (closest prediction to the settlement price
wins; ties split, earliest seal wins remainders), and settles on-chain.

WS: `reveal {settlement_price, predictions:[{seat, price, source}]}` then
`settled {payouts:[{seat, amount}], rake, tx_sig}` — or `voided {kind, refunds}` if the
oracle/timelock failed (capital safety: full refunds, never a guessed outcome).

## 11. Claims & refunds

`GET /v1/wallets/{wallet}/claimables` →
```json
{"claimables": [
  {"match_id":"…","onchain_match_id":10412,"kind":"payout","amount":180000000,
   "reason":"won main pot","claimed":false},
  {"kind":"refund","amount":50000000,"reason":"candidate_not_confirmed_at_lock", ...},
  {"kind":"refund","amount":50000000,"reason":"void:emergency", ...}]}
```
FE builds the tx from the IDL: `claim` for settled payouts (confirmed seats),
`refund` for voids **and** for unconfirmed candidates (available the moment the match
leaves Filling). Accounts (both): `player(signer,w)`, `match_pda(w)`, `seat_pda(w, closes
to player)`, `vault(w)`, `player_token(w)`, `token_program`. Amount is always full
`deposit + entry_fee` for refunds; `payout[engine_seat]` for claims. Both are idempotent —
a second attempt fails (seat account closed).

## 12. WebSocket reference

Envelope: every server frame is `{"v":1, "t":"<type>", "server_time_ms":…, …}`. Client
frames: `{"t":"<type>", …}`. Unknown fields/types MUST be ignored (additive versioning;
breaking changes bump `v`). Heartbeat: `ping`/`pong` every 30s.

Client → server: `auth {wallet, signature}` · `subscribe {channel: "lobby"|{"match":id}|"wallet", last_seq?}` ·
`unsubscribe {channel}` · `act {…}` (§8) · `set_default {…}` · `seal {…}` (§7) · `ping`.

Server → client: `challenge {nonce}` · `authenticated {wallet, session}` ·
`snapshot {match_id, state, last_seq}` · `event {match_id, seq, event}` ·
`lobby_delta {kind, room}` · `seat_update {match_id, confirmed, candidates, seats}` ·
`phase {match_id, phase, fill_deadline?, seal_deadline?, timelock_target?, live_start?,
scheduled_end?, button?}` · `your_turn {…}` · `action {…}` · `seal_status {sealed[],
deadline_ms}` · `reveal {…}` · `settled {…}` · `voided {…}` · `pong` · `error {code, msg}`.

## 13. Error catalog

REST errors: `{"error": {"code": "<snake_case>", "message": "…"}}` with proper HTTP status
(400 validation, 401 auth, 403 geofence/enforcement, 404, 409 duplicate/conflict, 410
expired intent, 429 rate limit). WS errors: `error {code, msg}` frames.

On-chain `SyndicateError` highlights (Anchor error codes, from the IDL):
`BadStatus` (wrong phase — usually a race; refresh), `CandidateLimitReached` (32 deposits
cap), `InvalidRoomCommitment` (private/public commitment mismatch — wrong room code),
`SeatNotConfirmed` (candidate tried to seal/claim — use refund), `SealWindowClosed`,
`AlreadySealed`, `InvalidDrandRound` (wrong timelock round — recompute from the `phase`
message), `AlreadyClaimed`, `MatchFull`, `NotEnoughPlayers`, `RefundUnavailable`. Retryable:
`BadStatus`-as-race and RPC blockhash errors; everything else is a UX correction.

## Appendix A — normative hashes (test vectors ship with the backend tests)

- **Room commitment**: `sha256(utf8(roomcode_trimmed_uppercased) ‖ wallet_pubkey_32B)`.
  Public rooms: 32 zero bytes.
- **Prediction commitment**: `sha256(tlock_ciphertext_bytes)`.
- **config_hash**: `sha256` of the canonical JSON (sorted keys, no whitespace, integers as
  numbers) of `{feed_symbol, buy_in, entry_fee, rake_bps, rake_cap, min_players,
  max_players, streets:[{duration_sec, observation_sec}…], seal_window_sec,
  begin_live_window_sec, fill_window_sec, action_timeout_ms, time_bank_sec, small_blind,
  big_blind, visibility}` — the server computes it; verify if you want.
- **Button seed** (on-chain): `keccak256("syndicate:button:v2" ‖ match_pda ‖ lock_ts_u64le
  ‖ per confirmed seat in engine order: player_32B ‖ commitment_set_u8 ‖ commitment_32B ‖
  timelock_target_u64le)`; `button = u64_le(seed[0..8]) % confirmed_count`.
- **CreateParams**: 167-byte Borsh, field order exactly as the IDL `CreateParams` type.

## Appendix B — off-chain intent signatures

Domain `syndicate/action/v1` (see `services/shared/src/intent.rs` for the byte-exact
builders; the backend rejects anything else):

- **Action**: `action_intent_message(match_id, onchain_match_id, seat_index, seat_pubkey,
  nonce, prev_head, action_tag, amount)` — sign the message bytes with the seat wallet
  (ed25519 `signMessage`), send hex/base64 in `act.signature`.
- **Default policy**: `default_policy_message(match_id, onchain_match_id, seat_index,
  seat_pubkey, policy_tag)`.
- **Seal**: the prediction-commitment message binds `(match, seat, commitment,
  timelock_target)`; additionally the on-chain `register_prediction_commitment` tx
  signature is itself the strong seal proof.

Action tags: fold=0, check=1, call=2, bet_to=3, raise_to=4, all_in=5. Policy tags:
check_fold=0, check_call_any=1.
