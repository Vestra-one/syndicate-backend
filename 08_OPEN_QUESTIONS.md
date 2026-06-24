# Syndicate — Decision Log (resolved Open Questions)

**Status:** Canonical foundation, v1.1. Every question from the prior `OPEN_QUESTIONS` has been answered by the founder. This file is now a **decision log**: each item is **✅ LOCKED** (decided and propagated into the canonical docs) or **⏭ DEFERRED** (intentionally pushed to post-PFM). Tags: **[BUSINESS] [DESIGN] [TECH] [LEGAL]**.

> **Engineering is unblocked.** The Tier-0 items that gated all build work (oracle/settlement, manipulation caps, time-lock, determinism boundary, fees) are resolved below.

---

## Tier 0 — settlement & money (were blocking everything)

**OQ1 ✅ [TECH] Oracle provider + settlement-window parameters.**
**Locked: Switchboard On-Demand** as the default pull adapter; Pyth and others remain pluggable. *Evaluation:* Pyth moved Pyth Core to paid on-chain fees (DAO-mandated quarterly pricing); Switchboard On-Demand is pull-based, cost-effective, and provides on-chain-verifiable signed updates, with a low-latency **Surge** tier available to drive the live chart. Window params: 1 Hz sampling, final-60s **median**, confidence/staleness guards, VOID below a minimum valid-sample count. (Mechanics §11; Arch §3.)

**OQ2 ✅ [DESIGN] Manipulation caps.**
**Locked: configurable** `max_buy_in` / table cap, which may be set high (e.g., up to ~$5M), held **per-feed below market-impact size**. This cap is the v1 control. Detailed manipulation telemetry (settlement-window pressure, cross-match correlation) is **⏭ deferred to post-PFM**. (Mechanics §11.)

**OQ3 ✅ [TECH] Time-lock scheme + beacon + grace.**
**Locked: drand `tlock`** (League of Entropy) to a round at match end; decryption **verified on-chain** against recorded ciphertexts; **~60s grace** → VOID + full refund if the key fails to materialize. (Mechanics §12; Arch §2.)

**OQ4 ✅ [TECH] Determinism boundary / on-chain verification.**
**Locked: full on-chain verification.** Deposits and settlement happen on-chain and the chain recomputes/validates the full settlement (pots + `S`) before any payout. This is **non-negotiable** — a core user-trust guarantee, never traded for cost or latency. (Mechanics §18; Arch §4, §11.)

---

## Tier 1 — gameplay

**OQ5 ✅ [DESIGN] Blinds & stack depth.** Flat blinds posted once, ante 0, ~100 BB start; escalation/antes configurable, revisited only if pots prove too small. (Mechanics §6.)

**OQ6 ✅ [DESIGN] Action timer & time bank.** 25s/turn + a **60s replenishing time bank** — the bank is drawn only when a turn overflows 25s and **refills each round**, so it is a recurring cushion, not a one-time reserve. All values configurable for tuning. (Mechanics §8.)

**OQ7 ✅ [DESIGN] Round structure.** **Round count and per-round durations are configurable** (default 3 → 4/3/3 min). Per the founder mandate, **all numbers are config-driven** so PMF is reached through config changes, not code changes. (Mechanics §2, §7.)

**OQ8 ✅ [DESIGN] Feed & token menu.** Configurable; **default BTC/USD feed + USDC token.** Feed and token are decoupled — any oracle-supported instrument against any supported token. (Mechanics §2.)

**OQ9 ✅ [DESIGN] Post-match number reveal.** **All sealed numbers open post-match** — winners, survivors, and players who folded/busted early alike — as a deliberate emotional + spectator beat ("how close was I?"). Inherent to the time-lock. (Mechanics §12; Requirements §9.)

**OQ10 ✅ [DESIGN] Heads-up.** Supported as first-class; standard heads-up blind/action order. (Mechanics §6–§7.)

---

## Tier 2 — economics

**OQ11 ✅ [BUSINESS] Rake.** Configurable; default benchmarked to online-poker norms (low single-digit %, capped on small pots); A/B by tier. (Mechanics §14.)

**OQ12 ✅ [BUSINESS/TECH] Fee model & gas.** **Two-point fees, both configurable:** an **entry fee on joining** (at deposit) + a **pot rake at settlement**. They fund **platform-sponsored** settlement/claim transactions (no surprise gas). Entry fee refunded on VOID/leave-before-LIVE. (Mechanics §14; Arch §11.)

**OQ13 ✅ [BUSINESS] Launch tiers & token.** USDC; **3 buy-in tiers + a no-stakes practice mode** for onboarding. (Requirements §4.)

**OQ14 ✅ [BUSINESS] Cold-start.** **Manual fill** (scheduled play times + organic/community demand). **No house bots** ever pose as players or seed tables — integrity over speed. (Requirements §2; Arch §9.)

---

## Tier 3 — trust & safety

**OQ15 ✅ [DESIGN/TECH] Sybil resistance.** Progressive: device/wallet-cluster heuristics at launch, stronger proof-of-personhood for higher tiers; minimal PII. (Requirements §2; Arch §9.)

**OQ16 ✅ [DESIGN] Collusion policy.** Published fair-play policy; ban + forfeiture of future access for proven collusion; **no retroactive clawback** of settled on-chain funds (expectations set accordingly). (Arch §9; Risk S3.)

**OQ17 ✅ [DESIGN] Pre-signed default templates.** Offer **check/fold (preselected)** and **check/call-any**. (Mechanics §8; Requirements §8.)

---

## Tier 4 — deferred (acknowledged, intentionally post-v1)

**OQ18 ✅/⏭ [LEGAL] Regulatory.** **Geofencing implemented at launch** to block restricted jurisdictions (the v1 control). Full legal classification + KYC depth remain **⏭ deferred** ("regulation last step"). Geofencing/KYC hooks are architecturally in place. (Requirements §2; Arch §9; Risk RG1.)

**OQ19 ⏭ [DESIGN] Spectator prediction market.** **Not in phase 1.** Only the read-only public action feed (its future seam) ships. (Mechanics §21; Arch §15.)

**OQ20 ✅ [DESIGN] Progression & discovery.** Lightweight verifiable **leaderboards over volume** at launch, **plus a live-games dashboard**: live games **ranked by popularity** (a "rated" score), **sortable by game time, pot size, buy-in, feed,** and other metrics. Deeper seasons/meta deferred. (Requirements §2; Arch §13.)

---

## Intentionally deferred to post-PFM (single list)

1. Detailed manipulation telemetry beyond buy-in caps (OQ2).
2. Spectator prediction market (OQ19).
3. Deep progression / seasons beyond baseline leaderboards (OQ20).
4. Full regulatory/legal classification & deeper KYC beyond geofencing (OQ18).

Everything else is locked and reflected in the canonical mechanics, requirements, architecture, and risk documents. **The foundation is complete for v1 build.**
