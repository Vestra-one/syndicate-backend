# Syndicate — Architecture Implications

**Status:** Canonical foundation, v1.0. For each major mechanic, this document states the **backend**, **smart-contract**, **real-time infrastructure**, and **operational** consequences. It is descriptive of constraints the mechanics impose, not a final system design; it defines the boundaries any design must respect.

---

## 0. The architecture in one diagram

```
            ┌─────────────────────────────────────────────────────────┐
   Client → │  Edge / WS Gateway  ──  Authoritative Match Engine        │
 (wallet)   │        │                      │   (deterministic, 1 per   │
            │        │                      │    match, event-sourced)  │
            │        ▼                      ▼                           │
            │   Auth & Nonce         Signed Action Log (hash-chained)   │
            │                              │                            │
            │   Oracle Adapter ───────────▶│◀──── VRF (button seed)     │
            │   (pull, swappable)          │◀──── Time-lock key @ end   │
            └──────────────────────────────┼────────────────────────────┘
                                           ▼
                         Settlement Builder (pure fn)  →  Solana Program
                         (recompute + verify)              (vault PDA, escrow,
                                                            settlement validation,
                                                            idempotent payout)
```

**Trust model:** the match engine is *authoritative for gameplay ordering* but *not trusted for outcomes*. Outcomes are recomputable by anyone and validated on-chain before funds move. The chain is the source of truth for custody and final settlement.

---

## 1. Custody & per-match deposits (fresh buy-in, no off-chain balance)

- **Smart contract:** a **match vault PDA** holds all buy-ins for one match, keyed by match ID. Deposits are SPL-token transfers in the table's `chips_token` (e.g., USDC) with finality gating seat reservation — **deposit is the eligibility/anti-spam gate** for both public and private play. The program enforces: locked after LIVE, refundable in FILLING/SEALING/VOID, payable only via the validated settlement instruction. Idempotent claim per (match, player).
- **Backend:** watches deposit finality to confirm seats (no seat without finalized deposit, which blocks spam/Sybil lobby flooding); reconciles vault balance against expected buy-ins before allowing LIVE. Refund engine for VOID/leave/cancel.
- **Real-time:** seat-reservation events pushed to lobby subscribers; deposit-finality latency (Solana ~400ms–slot finality) must be surfaced as a clear "confirming" state.
- **Ops:** vault balance invariant monitoring (sum of player ledgers == on-chain vault) on every transition; alert on drift. Per-match PDA lifecycle (rent, close-on-settle to reclaim rent).

## 2. Time-lock encryption of predictions

- **Scheme:** each prediction is sealed with **time-lock encryption (TLE)** to `timelock_target` (match end) — e.g., a drand/`tlock`-style scheme where the decryption key is published by a public beacon at a future round, or a verifiable-delay-function construction. The scheme must be **IND-CPA** (randomized, so the ciphertext leaks nothing about a low-entropy price) and have **no key holder** — not the operator, not the backend. This is strictly stronger than the prior commit-reveal: predictions open *automatically*, eliminating the entire non-reveal / disconnect-at-showdown failure class.
- **Smart contract / chain:** record each player's TLE ciphertext (and its submission proof) **before LIVE**; at match end, take the published time-lock key, decrypt deterministically, and verify each plaintext was bound by the pre-LIVE ciphertext. Settlement is validated against these decrypted values.
- **Backend:** never holds any decryption key (none exists until the beacon publishes it); stores ciphertexts, pulls the key at match end, decrypts, and feeds the settlement builder. Verifies ciphertexts were submitted before LIVE.
- **Real-time:** "sealed" confirmation to the sealing client; seal receipts broadcast (ciphertext hash only) so all players see everyone has sealed before LIVE.
- **New dependency — beacon liveness:** the only added external dependency is availability of the time-lock key at match end. Mitigate with a reputable, decentralized beacon (e.g., the drand League of Entropy) and a **bounded grace period → VOID + full refund** if the key fails to materialize (mechanics §12/§17). Treat beacon outage like oracle outage: Sev-1, capital-safe VOID, never a stuck match.
- **Ops:** monitor seal completeness before LIVE; monitor beacon health alongside the oracle.

## 3. Settlement price `S` — pull oracle, window-median, fault guards (most critical)

- **Modular pull adapter:** the oracle sits behind a **provider-agnostic adapter** with a single "pull a signed price sample for `price_feed_id` now" interface. Providers are **pull-based** — the latest signed update is fetched on demand and posted/recorded on-chain at sampling time — and are **swappable/upgradable without touching settlement logic**. The feed may be crypto, equity, commodity, or FX.
- **Locked default provider — Switchboard On-Demand:** pull-based, cost-effective, with on-chain-verifiable signed updates (chosen over Pyth after Pyth moved Pyth Core to paid on-chain fees). Its low-latency **Surge** tier can drive the live chart while On-Demand pulls feed the recorded settlement samples. Switching provider remains a config-level change.
- **Smart contract / chain:** settlement instruction consumes the **recorded oracle samples** and recomputes `S` = window median, applying confidence/staleness guards, and validates the submitted settlement against this. It reads the provider account(s) on-chain through the adapter or accepts attested samples whose authenticity it can verify. The VOID path triggers if valid samples < minimum.
- **Backend:** an **oracle reader** pulls the feed at a fixed cadence across the match (and densely across the settlement window), persisting every (timestamp, price, confidence) tuple to the action log. This is the highest-integrity data path in the system and must be redundant (multiple readers, agreement check).
- **Real-time:** the live chart is driven by the same feed; the displayed price and the settlement price must derive from one recorded source to avoid "the chart said X but I lost" disputes.
- **Ops:** oracle health dashboards, confidence-interval alerting, automatic VOID on degradation, and a documented incident runbook. Treat oracle outage as a Sev-1. Detailed manipulation telemetry (settlement-window pressure, cross-match correlation) is **deferred to post-PFM**; the v1 control is **configurable buy-in/table caps** (`max_buy_in`, default headroom ~$5M, set below market-impact size per feed).

## 4. Authoritative match engine, signed actions, determinism & replay

- **Backend:** one **authoritative, single-writer engine instance per match** owns the canonical state machine (§3 of mechanics). Every player action is a **signed intent**, validated for legality and appended to an **ordered, hash-chained event log** (event sourcing). State is a fold over the log; recovery = replay. This guarantees the determinism invariant and makes "replay the game" (REQ §12) real rather than aspirational.
- **Smart contract:** does not run gameplay; it validates the *result* by recomputing settlement from (log digest, time-lock ciphertexts + published key, oracle samples, VRF seed, table config). The log's hash-chain root is committed so tampering is detectable.
- **Real-time:** clients hold *optimistic* views but the engine is the sole arbiter; turn timers run on the server clock to prevent latency exploits. WebSocket fan-out to 2–5 players + spectators.
- **Ops:** per-match engine isolation (a crash affects one match, recovers by replay); structured logs; the hash-chain enables forensic audit. Single-writer-per-match must be enforced (lease/lock) to avoid double-action races.

## 5. Betting streets, side pots, and settlement math

- **Backend:** pure, heavily unit-tested **pot-construction module** implementing the §9 algorithm on integer chips (uncalled-bet returns, dead-money layering, multi-tier all-ins, conservation assertion). This module is shared verbatim by the engine and the on-chain validator's reference to guarantee agreement. Property-based tests (random contribution vectors must always conserve chips) are mandatory.
- **Smart contract:** distributes per the computed pot map; the conservation invariant (`Σ payouts + Σ returns + rake == Σ deposits`) is asserted on-chain before release.
- **Real-time:** live pot/side-pot visualization; all-in side-pot formation shown clearly.
- **Ops:** any conservation-assertion failure is an automatic VOID + Sev-1, never a "best effort" payout.

## 6. Blinds, button, and VRF

- **Smart contract / chain:** records the button seed posted at SEALING via `set_button_seed`; seed + audit hash stored for replay (`submit_settlement` binds `vrf_seed`).
- **Backend (v1):** `settlement-chain` generates CSPRNG randomness server-side and submits `set_button_seed` — **server-attested**, not on-chain oracle VRF. Engine derives blind positions from the recorded seed.
- **Future:** decentralized VRF (Switchboard/ORAO with on-chain verification) if button fairness must be trustless.
- **Ops:** no external VRF oracle liveness dependency in v1; button assignment is synchronous with settlement-chain custody txs.

## 7. Action timers, timeouts, disconnect/reconnect

- **Backend:** server-authoritative timers (timer + time bank) per turn. On timeout, the player's **pre-signed default action** (held by the backend) is submitted on their behalf — it is player-signed, so it enters the log as a genuine intent and keeps replay faithful and attribution clean; absent a default, the safe auto-check/auto-fold is recorded as an engine-authored event. Disconnect == inaction → same path; all-in players exempt. Pre-signed defaults are the primary anti-timer-collapse mechanism.
- **Real-time:** heartbeat/presence; reconnection re-syncs state from the engine snapshot + log tail; graceful degradation if a client's network is poor (the server clock, not the client, governs fairness).
- **Ops:** monitor timeout/auto-fold rates as both a UX and a collusion/abuse signal.

## 8. Time-lock decryption (automatic; no reveal window)

- **Backend:** at match end, pull the published time-lock key, decrypt **all** sealed predictions deterministically, verify each was bound by its pre-LIVE ciphertext, then feed the settlement builder. **No reveal window, no non-reveal forfeiture, no per-player reveal action** — the failure class is gone.
- **Smart contract:** decrypts/verifies (or validates an attested decryption) against the recorded ciphertexts and the public key; only the validated settlement releases funds.
- **Ops:** monitor beacon/key availability (the sole liveness dependency); on failure, grace-period → VOID + refund (§2, mechanics §12). No griefing surface remains.

## 9. Matchmaking, anti-Sybil, anti-bot, anti-collusion

- **Backend:** matchmaking service with rating buckets, **deposit-to-enter as the first spam gate**, proof-of-personhood / Sybil resistance at seating, and **collusion/bot telemetry** (correlated wallets, chip-dumping patterns, timing signatures, repeated co-seating). This is a standing service, not a feature — it runs continuously and feeds enforcement.
- **Geofencing:** enforced at the edge/auth layer — connections from restricted jurisdictions are blocked before seating (Q18). Legal classification stays deferred; geofencing is the v1 control. Tables fill **manually** (scheduled/organic); **no house bots** ever seed tables or pose as players (Q14).
- **Smart contract:** can enforce some constraints (e.g., one active seat per identity) but most detection is off-chain analytics.
- **Ops:** a trust-and-safety function with investigation tooling, seat bans, and clawback policy (within the bounds of on-chain custody). Small-table collusion can be mitigated, never eliminated — staffing and tooling must reflect that.

## 10. Real-time infrastructure & performance

- **Constraints from the vision:** premium feel demands low, *consistent* latency for turn-based betting (fairness depends on it), a smooth live chart, no layout shift, and near-instant transitions. WebSocket gateways close to users; the per-match engine co-located with its gateway to minimize action round-trips.
- **Scale shape:** many small (2–5 player) matches running concurrently rather than a few huge rooms — favors a **shard-per-match** model that scales horizontally and isolates failure. Spectator fan-out (read-only) scales separately and must never contend with active gameplay (an explicit requirement carried from the source docs).
- **Ops:** capacity planning around concurrent-match count; autoscaling engine shards; backpressure isolation between the betting path and the broadcast path.

## 11. On-chain cost & fee-payer policy

- **Constraint:** deposit, settlement, and claim are on-chain (**non-negotiable** — this is a core trust guarantee, Q4). At low tiers, Solana fees + rent are small but non-trivial relative to stake.
- **Decided — two-point fee model funds sponsored gas.** Fees are taken at **two points**: an **`entry_fee` on joining** (at deposit) and a **pot rake at settlement** (mechanics §14), both configurable and disclosed up front. These fund **platform-sponsored settlement/claim transactions**, so players are never surprised by gas. Entry fees are refunded on VOID/leave-before-LIVE.

## 12. Configurability & feed/token model

- **Configuration service:** every game number (round split, durations, blinds, antes, timers, time bank, settlement window, sample cadence, rake, caps, min/max players, `timelock_target` offset) is a **versioned, validated config** bound to a table at creation and recorded in the audit log so replay uses the exact parameters the match ran under. No constant is hard-coded. This is what lets the game be tuned toward product-market fit from live feedback without redeploys.
- **Feed/token decoupling:** `price_feed_id` (what is predicted/settled against) and `chips_token` (what is staked/paid) are independent fields. Predictions and `S` are in feed price units at the feed's precision; custody, pots, and payouts are in `chips_token` units. The settlement builder treats them as separate dimensions — there is no implicit coupling, so any oracle-supported instrument (crypto/equity/commodity/FX) can be offered against any supported token.

## 13. Public action data feed (read path)

- **What it serves:** a read-only, real-time + historical stream of *public* match events — feed price at each action, bet/raise/call/all-in amounts, pot evolution, fold events, round transitions, settlement price, pot awards, and the predictions that become decryptable at match end. It is sourced directly from the signed action log (the data already exists), so marginal cost is low.
- **Hard isolation:** served on a **separate read path / fan-out tier** that can never contend with or stall the authoritative betting path (backpressure-isolated; independently scalable to large spectator counts).
- **Integrity guards:** the feed **must not** expose any sealed prediction before the time-lock opens, nor queued intents, pre-signed defaults, or private metadata. Attribution is pseudonymous (wallet/handle). It exposes only information already public at the table, so it grants no new advantage to active players or colluders.
- **Live-games dashboard:** a **ranking service** consumes this same feed to power the discovery dashboard — games ordered by popularity (a "rated" score from spectator count + betting activity), **sortable by game time, pot size, buy-in, feed,** and other metrics. Read-only, cached, and isolated, so ranking/sorting never touches the gameplay path.
- **Why it's in v1:** drives spectator pull, virality, trust, and player learning; it is also the exact seam the deferred spectator market (§15) would later build on.

## 14. Operational complexity summary (by mechanic)

| Mechanic | Backend | Smart contract | Real-time | Ops burden |
|----------|---------|----------------|-----------|------------|
| Per-match custody (deposit gate) | Med | Med | Low | Med (vault reconciliation) |
| Time-lock encryption | Low | Med | Low | Low (beacon health) |
| **Settlement pull-oracle / median** | **High** | **High** | Med | **High (Sev-1 path)** |
| Authoritative engine / replay | High | Med | High | High (single-writer, isolation) |
| Side-pot math | Med | Med | Low | Med (must be provably correct) |
| VRF button | Low | Med | Low | Low |
| Timers / pre-signed defaults | Med | Low | High | Med (abuse signal) |
| Time-lock decrypt | Low | Med | Low | Low |
| Matchmaking / T&S | High | Low | Med | **High (standing function)** |
| Real-time fan-out + action feed | Med | – | High | Med (read-path isolation) |

**The two architecture-level existential dependencies are the oracle/settlement path (§3) and the deterministic authoritative engine (§4).** Build, test, and red-team these first. Everything else can be hardened iteratively; these two cannot be retrofitted without re-pouring the foundation.

---

## 15. Deferred-module seam (spectator market)

The public action feed (§13) is also the seam for a future spectator prediction market: that market would consume the same read-only stream and add its own wagering/settlement, with **no coupling to core match settlement**, no shared liquidity, and no schema commitments beyond the public event contract. This keeps the option open without taxing v1 integrity. Regulatory architecture for any wagering is out of scope here and tracked in `OPEN_QUESTIONS`.
