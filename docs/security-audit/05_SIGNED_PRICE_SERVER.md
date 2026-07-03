# Security Audit — Signed Price Server (`services/signed-price-server`)

**Auditor role:** Adversarial white-hat, focused on the secp256k1/EIP-191 settlement-price signer.
**Threat model:** Operator/company is trusted. Attackers are malicious players / external actors seeking to induce a wrong/manipulated signed price, replay a price, manipulate the exchange feed driving the signed mid, extract the key, or DoS settlement.
**Date:** 2026-07-01

## Summary

The signing path is architecturally sound in the ways that matter most for a price oracle: **there is no endpoint that signs attacker-supplied price/timestamp/token data.** Prices are signed only from the server's own exchange feed, the signed timestamp is always the server's wall clock at emit time (never a caller-chosen historical/future second), the EIP-191 message bytes exactly match the contract's verification layout, and signatures are deterministic-`k` low-`S` (go-ethereum/btcec), so classic replay-via-arbitrary-timestamp and signature-malleability attacks do not apply. Key handling is reasonable (env-only, not logged, not exposed).

The **dominant risk is economic, not cryptographic: the settlement price for each symbol is a raw top-of-book mid `(bid+ask)/2` from a SINGLE exchange**, with no cross-exchange aggregation/median, no deviation/outlier guard, no minimum book-depth requirement, and a permissive staleness window (`max_book_age_ms` = 1500–2000 ms). A player who can move one exchange's top-of-book — by pushing dust limit orders that briefly become the best bid/ask, or by trading into a thin book around a known `scheduled_end_ts` — can move the signed mid the server commits on-chain, and thus the outcome of price-prediction bets, **without the operator doing anything wrong**. This is the highest-severity finding because it is a manipulable input the contract blindly trusts (the per-seat-payout / action-log verification was removed for v1). Secondary issues: a stale-but-fresh-timestamped price (timestamp = wall clock while book is up to ~2 s old), the unauthenticated `book_mid` mid that can be skewed by a single crossed/zero-size level, and DoS/availability paths that can repeatedly grief settlement into the 300 s void.

### Severity table

| # | Title | Severity | Status |
|---|-------|----------|--------|
| 1 | Single-exchange top-of-book mid with no aggregation / outlier / depth guard is the settlement price | **Critical** | Proven |
| 2 | Stale book signed with a fresh wall-clock timestamp (price/timestamp decoupling, up to ~2 s) | **High** | Proven |
| 3 | No price monotonicity / deviation guard between consecutive signs — single-tick manipulation is signed instantly | **High** | Proven |
| 4 | Sub-second "last write wins" per second-bucket lets the manipulated tick win the settlement second | **Medium** | Proven |
| 5 | Feed-outage / DoS paths strand settlement into permissionless void (repeatable grief) | **Medium** | Proven |
| 6 | `book_mid` BBO accepted from a single WS connection with no spread/crossed-book sanity beyond `bid<=ask` | **Medium** | Proven |
| 7 | USDT→USD conversion silently falls back to 1.0 when the rate is stale | **Medium** | Proven (affects Binance-sourced symbols) |
| 8 | `/prices` and `/ws` are fully unauthenticated and `CheckOrigin` always true (info leak + connection DoS surface) | **Low** | Proven |
| 9 | `float64` round-trip in USDT conversion / Coinbase book parse loses precision in the signed price | **Low** | Proven |
| 10 | Verified controls (no attacker-signable surface, correct EIP-191 bytes, low-S, key hygiene, failover auth) | **Info** | Verified |

---

## Detail

### 1. Single-exchange top-of-book mid is the settlement price — no aggregation, outlier, or depth guard — **Critical**

**Proven. Files:**
- `provider/bookmid_emitter.go:176-261` (`emitEntry`) — builds the trade from one `bbo.Key` (one provider+symbol) and submits it for signing.
- `provider/pricemid.go:11-39` (`MidPriceFromBestBidAsk`) — mid = `(bid+ask)/2`; the only guards are non-empty, positive, and `bid <= ask`. No depth, no size, no deviation.
- `provider/coinbase_book.go:166-177` (`publishBBO`) — BBO is literally `bids.Max()` / `asks.Min()`; any resting level, including a dust order, becomes top-of-book.
- `config/config.toml:32-51`, `config/devnet.toml`, `config/config.us-east.toml`, `config/config.canada.toml` — every symbol (SOL/BTC/ETH USD) is configured with exactly ONE provider in `book_mid` mode (Coinbase, or Binance for some). There is no second feed to cross-check against.

**Attacker scenario:** Price-prediction bets settle at the price signed at the match's `scheduled_end_ts`. That price is `(best_bid + best_ask)/2` from a single exchange. An attacker who knows the upcoming `scheduled_end_ts` (it is derived deterministically from on-chain match params) and which exchange feeds that symbol can:
- Place a dust limit order one tick inside the spread on the target exchange so it momentarily becomes the new best bid or best ask, shifting the mid by ~half a tick to a full tick (more on a wide/thin book) for the ~tens-of-ms window the server emits in; or
- Trade through a thin book (low-liquidity symbols like SOL, or any symbol during thin hours) to walk the top-of-book to a chosen level for a sub-second window around the target second.

Because there is no median across exchanges, no comparison to recent prints, and no minimum displayed size at top-of-book, the server faithfully signs the manipulated mid and commits it on-chain. The contract trusts it absolutely (per-seat / action-log verification removed for v1).

**Economic impact:** Direct theft. Whoever controls the settlement price controls who wins every price-prediction bet ending at that second. The cost of a one-tick top-of-book nudge on a liquid venue is tiny relative to a pot; on thin symbols it is trivially cheap.

**Concrete fix (in priority order):**
1. Settle on a **cross-exchange aggregate** (median of ≥3 independent venues), not a single book. The code already has Binance + Coinbase providers and a per-provider BBO store — aggregate the per-provider mids per symbol before signing.
2. Add a **deviation guard**: refuse to sign (or VOID) if the candidate mid deviates more than X bps from a short trailing reference (e.g., last accepted mid, or a volume-weighted recent print). The offline `scripts/analyse_mid_vs_trade.go` already computes exactly this kind of tolerance — it just is not in the live path.
3. Add a **minimum top-of-book size / depth filter** so a dust order cannot define the BBO; require the best level to carry ≥ some notional, or use a small-notional sweep mid (e.g., mid of the price to fill N USD on each side) instead of raw L1.
4. Add a **maximum-spread guard** beyond `bid<=ask`: if the spread is abnormally wide (book thin / one side pulled), skip signing for that tick.

---

### 2. Stale book signed with a fresh wall-clock timestamp — **High**

**Proven. Files:** `provider/bookmid_emitter.go:177-255`. The snapshot's `bookUpdatedAt` may be as old as `maxBookAge` (`config.toml`/`devnet.toml`: **2000 ms**; us-east: 1500 ms) and still pass the `paused := bookAge > e.maxBookAge` check (line 185). The signed `Timestamp` is then set to `now.UnixMilli()` (line 249) — the server's wall clock at emit — **not** the book's observation time. `BookAgeMs` is carried only in observational `Meta`, which `signing/types.go:30-44` explicitly states is **not** part of the signed payload.

**Attacker scenario / impact:** The on-chain contract requires `publish_time (= timestamp_ms/1000) == scheduled_end_ts` and treats the price as "the price at that second." But the signed price can reflect a book that is up to ~2 seconds stale while bearing a timestamp that says "now." If a real move happens in the last ~2 s before `scheduled_end_ts` and the attacker's chosen exchange feed lags or is briefly stalled (see also #5/#6 — a single Coinbase product can silently stop streaming `l2_data`), the server signs a pre-move price stamped at the post-move second. An attacker who can predict or induce a brief feed stall right before settlement gets a price that does not reflect reality at the settled second, and the contract cannot tell.

**Fix:** (a) Tighten `max_book_age_ms` toward the emit interval (the validator only requires `>= 2 * emit_interval`, i.e. ≥90 ms — 2000 ms is ~22× looser than necessary). (b) Bind the signed timestamp to the **book observation time**, or refuse to sign for settlement if `now - bookUpdatedAt` exceeds a tight settlement-grade threshold (e.g., 100–250 ms), separate from the looser streaming threshold. (c) Have settlement reject/void a price whose `Meta.BookAgeMs` exceeds a hard cap — but note Meta is unsigned, so it must be enforced server-side at sign time, not trusted at settlement.

---

### 3. No monotonicity / deviation guard between consecutive signed prices — **High**

**Proven. Files:** `store/signed_price_store.go:55-103` (`Store`) only rejects prices with a **non-increasing timestamp** (`newTimestamp <= oldTimestamp`, line 88). There is no check that the new price is within a sane band of the previous one. The emitter signs every accepted tick (event-driven on any BBO change, debounced only 2 ms — `bookmid_emitter.go:22`, `134-163`).

**Attacker scenario / impact:** A single manipulated BBO change (finding #1) propagates to a signed, broadcast, archived price in milliseconds with zero sanity gate. There is no circuit breaker: a 5% instantaneous mid jump caused by a pulled book or a dust order is signed and committed exactly like a legitimate one. Combined with #1 and #4, the attacker only needs the manipulated tick to be the last write in the target second.

**Fix:** Reject (and alert) any candidate price that deviates more than X bps from the last accepted price for that symbol unless corroborated by a second feed. This is the same guard as #1.2 but enforced at the store boundary so it also protects the `last_trade` path.

---

### 4. Sub-second "last write wins" per second-bucket — **Medium**

**Proven. Files:** `store/signed_price_store.go:177-205` (`storeSecondBucket`) keys the durable archive by `timestamp_sec = Timestamp/1000` with `ON CONFLICT DO UPDATE ... WHERE excluded.payload_timestamp_ms > existing` — i.e., within a one-second bucket the **latest-millisecond** emit overwrites earlier ones. `api/handlers.go:105-132` (`handlePriceAt`) returns exactly that single bucket value for settlement.

**Attacker scenario / impact:** At a 45 ms emit interval there are ~22 signed prices per second. Settlement uses whichever has the largest sub-second timestamp. An attacker who lands a manipulated BBO change late in the target second (e.g., at xx.980) wins the bucket even if the book was honest for the first 980 ms. This sharpens #1: the manipulation window is "be the last emit of the second," which is easy to target given the deterministic `scheduled_end_ts` and the 45 ms cadence.

**Fix:** For settlement, select a **manipulation-resistant statistic over the whole second** (e.g., median or TWAP of all sub-second emits in the bucket) rather than the last write. Store all emits in the second and aggregate at lookup, or aggregate before archiving.

---

### 5. Feed-outage / DoS paths strand settlement into permissionless void — **Medium**

**Proven. Files:** `bookmid_emitter.go:179-197` skips emission entirely when the book is not ready, stale, or the failover gate says standby. `consumeSignedPrices` (`cmd/bot/main.go:352-355`) drops any sign the failover controller blocks. If no price is signed/archived for the target second, `handlePriceAt` returns 404 and the match cannot settle, falling to the documented permissionless void after 300 s.

**Attacker scenario / impact:** Funds are returned on void (no theft), but void is **griefable repeatedly**: anything that reliably suppresses a fresh sign at `scheduled_end_ts` for a targeted symbol denies settlement. Vectors include forcing the watched exchange's single product feed to stall (Coinbase can silently stop `l2_data` for one product — acknowledged in `coinbase.go:203-209`; the watchdog only reacts after `stale_threshold_ms` = 5 s and a 30 s reconnect cooldown), WebSocket connection exhaustion against the public `:8080` (no auth, `max_connections` 12000 — see #8), or repeatedly inducing failover handoffs. Each grief forces a 300 s void and a re-run, degrading the product and potentially enabling selective denial (void only matches the attacker would lose).

**Fix:** (a) Run redundant independent feeds per symbol so one stall cannot suppress signing (ties to #1). (b) Shorten the stale-book watchdog threshold/cooldown for settlement-critical symbols. (c) Put the public read/WS endpoints behind auth or a separate listener from any settlement-facing endpoint, and rate-limit connections per IP. (d) Persist/serve the freshest sub-`max_book_age` sign so a momentary gap at the exact second still yields a usable (and honestly book-aged) price.

---

### 6. `book_mid` BBO accepted from a single WS with weak sanity beyond `bid<=ask` — **Medium**

**Proven. Files:** `provider/coinbase.go:474-507` (`applyAdvancedEvent` → `bboStore.Update`) and `provider/binance.go:455-477` push whatever top-of-book the exchange streams; the only validation is `MidPriceFromBestBidAsk` (`pricemid.go`) which rejects empty/non-positive sides and `bid>ask`. `coinbase_book.go:139-161` (`applyToBookLocked`) silently drops levels with unparseable price or `size<=0`, so a transient empty side can leave a stale opposite top-of-book defining the mid. There is no minimum-size, max-spread, or cross-feed check.

**Attacker scenario / impact:** Same root cause as #1, but specifically: a one-sided book event (e.g., the best bid level momentarily pulled so the next-best — possibly a dust level — becomes BBO) is accepted and signed. There is no guard that the spread is economically normal, so a thin/dislocated book at the target second is signed as gospel.

**Fix:** Enforce a configurable max relative spread and minimum displayed size at top-of-book before accepting a BBO for signing; prefer a depth-aware mid (#1.3).

---

### 7. USDT→USD conversion silently falls back to 1.0 when the rate is stale — **Medium**

**Proven. Files:** `provider/binance.go:287-307` (`getUsdtUsdRate`) returns `1.0` if the USDT/USD rate is missing or older than `usdtRateMaxAge` (30 s), and `ConvertUsdtToUsd` (`binance.go:333-346`) uses it without surfacing an error. Binance-sourced book_mid symbols (e.g., us-east SOLUSD, canada SOLUSD/ETH per their configs) convert the mid through this rate.

**Attacker scenario / impact:** If the USDT/USD feed stalls (the rate is itself a single Binance `usdtusd@trade` stream), the server silently assumes 1 USDT = 1 USD and signs a settlement price off by the real USDT depeg (historically up to several percent). This is a silent wrong-price condition, not a void — settlement proceeds on a mispriced value. An attacker who can stall or has foreknowledge of a USDT dislocation profits.

**Fix:** Do not fall back to 1.0 for **settlement**; if the conversion rate is stale, skip the emit (force void) rather than sign a guessed price. At minimum make the fallback configurable and off by default for settlement-critical symbols, and add a deviation guard against a second USDT/USD source.

---

### 8. Public `/prices`, `/prices/at`, `/ws` unauthenticated; `CheckOrigin` always true — **Low**

**Proven. Files:** `api/server.go:64-67` registers `/ws`, `/prices`, `/prices/at`, `/health` with no auth middleware; `api/handlers.go:24-30` sets `CheckOrigin` to always return `true`; `writeJSON`/`handlePrices` set `Access-Control-Allow-Origin: *`. Only `/internal/failover/*` requires the shared secret.

**Impact:** Mostly information disclosure (signed prices and book metadata are arguably public). The real concern is that the WS endpoint is an unauthenticated connection sink (`max_connections` 12000) reachable by anyone, which contributes to the DoS surface in #5. `/prices/at` also lets anyone enumerate the exact signed value committed for any past second (useful reconnaissance for the manipulation findings).

**Fix:** Front the public read endpoints with a rate-limited gateway / per-IP connection caps, restrict `CheckOrigin` to expected origins, and keep settlement-facing lookups (`/prices/at`) on an authenticated internal path distinct from the public stream.

---

### 9. `float64` round-trips lose precision in the signed price — **Low**

**Proven. Files:** `provider/binance.go:333-346` parses price via `strconv.ParseFloat(...,64)`, multiplies by a `float64` rate, and re-formats — full `float64` precision loss on the settlement value for USDT-sourced symbols. `provider/coinbase_book.go:140` parses each level price to `float64` for sorting (the original string `priceS` is preserved for BBO output, so Coinbase L1 prices themselves are not lossy, but the mid is then computed in `big.Float` from those strings — OK). `pricebuild/wad.go:35-41` correctly uses `big.Float` and rounds half-up.

**Impact:** Sub-cent rounding differences in the signed price. Not directly exploitable for large value, but it means the committed price is not exactly reproducible from the raw feed for Binance-converted symbols, complicating dispute/audit. Low severity but worth removing for a value the contract treats as canonical.

**Fix:** Do the USDT conversion in `big.Float`/`big.Rat` end-to-end (the rate can be kept as a decimal string) rather than `float64`.

---

### 10. Verified controls (no finding) — **Info**

These were specifically checked and found correct — note them so they are not regressed:

- **No attacker-signable surface.** There is no HTTP/WS endpoint that signs caller-supplied price, timestamp, or token. Signing input comes exclusively from the internal feed callbacks (`cmd/bot/main.go:182-283`) and the book_mid emitter; the API is read-only plus authenticated failover control. (`api/server.go`, `api/handlers.go`, `api/failover_handlers.go`)
- **Timestamp is always "now," never caller-chosen historical/future.** book_mid uses `now.UnixMilli()` (`bookmid_emitter.go:249`); trade-mode uses the exchange's own event time. There is no path to request a signature for an arbitrary second, so the "sign a price for any `scheduled_end_ts`" attack is not reachable. (Caveat: see #2 re: book-vs-timestamp staleness.)
- **EIP-191 message bytes match the contract.** `signing/worker_pool.go:177-205` builds `token(20) || priceInWad(32 BE) || timestamp_ms(32 BE)`, keccak256, then `"\x19Ethereum Signed Message:\n32" || hash`, keccak256 again — exactly the layout the prompt states the contract verifies. `FillBytes` produces fixed-width big-endian; `Token.Bytes()` is the 20-byte address. Price cap (`pricebuild/wad.go:13`, 1e30) keeps `priceInWad < 2^256` so `FillBytes(32)` cannot panic/truncate. v is normalized to 27/28 (line 217).
- **WAD scale / exponent correct.** `PriceToWad` multiplies by exactly `10^18` with half-up rounding (`pricebuild/wad.go:10,35-41`), matching the contract's exponent −18.
- **No signature malleability / nonce reuse.** Signing uses go-ethereum `crypto.Sign`, which is RFC-6979 deterministic-`k` with canonical low-`S` (btcec/decred secp256k1). No custom crypto, no nonce handling in this codebase. (Recommend the contract also enforce low-S + a single canonical recovery id, but that is contract scope.)
- **Key hygiene.** The private key is read only from `ECDSA_PRIVATE_KEY` (`cmd/bot/main.go:36-40`), parsed once, held in memory; only the **public** key is ever stored/serialized (`worker_pool.go:74-76,231`). The key is never logged and never returned by any endpoint or metric. (Note: env-var keys are visible to anyone who can read the process environment / a core dump — a KMS or signer enclave would be stronger, but env-only is acceptable for v1 given the trusted-operator model.)
- **Failover endpoints are authenticated and fail-closed.** `/internal/failover/*` requires `X-Failover-Secret` via constant-time compare (`api/failover_handlers.go:83-94`), and `cmd/bot/main.go:132-135` refuses to start with `failover.enabled` and an empty secret, closing the fail-open hole. Lease/epoch logic (`failover/controller.go`) is designed to prevent dual-sign (monotonic epochs, lease TTL > renew validated, reclaim only after lease-expiry deadline). The dual-sign-prevention design looks careful; a deep concurrency proof of the failover state machine was out of scope here but is worth a dedicated review since a split-brain that signs two different prices for the same second would be severe.
- **Stale-timestamp replay into the store is rejected** (`store/signed_price_store.go:88`): a price with a non-increasing timestamp cannot overwrite a newer one. (This is monotonicity-by-timestamp only; it does not bound value — see #3.)

---

## Top recommendations (ranked)

1. **Aggregate the settlement price across ≥3 independent exchanges (median) and add a deviation + min-depth + max-spread guard before signing.** This single change closes findings #1, #3, #4, #6 — the entire economic-manipulation class. Today every symbol settles on one manipulable single-exchange L1 mid.
2. **Decouple settlement freshness from streaming freshness:** sign settlement prices only from a book observed within ~100–250 ms, and either bind the signed timestamp to the book time or hard-reject stale books at sign time (#2).
3. **Never silently assume USDT=USD for settlement** — void instead (#7).
4. **Harden availability**: redundant feeds, tighter stale-book watchdog for settlement symbols, and rate-limited/segmented public endpoints to blunt the repeatable-void grief (#5, #8).
