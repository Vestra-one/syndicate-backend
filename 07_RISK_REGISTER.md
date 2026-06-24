# Syndicate — Risk Register

**Status:** Canonical foundation, v1.0. Severity = blast radius if it occurs (Critical / High / Medium / Low). Probability = likelihood absent mitigation (High / Medium / Low). "Mitigation" states the canonical control and where it lives. Risks that are **foundation-level existential** are marked ⛔ — they must be solved before scaling, not after.

---

## A. Product & game-design risks

| ID | Risk | Severity | Probability | Mitigation |
|----|------|----------|-------------|------------|
| P1 ⛔ | **Mis-positioned as a forecasting/skill product**, then judged a coin-flip ("just gambling"). | Critical | High | Reframe skill to capital allocation, not forecasting (`BUILDER_VISION`); honest marketing; never claim "out-predict the market." |
| P2 ⛔ | **Poker layer kills the reveal** — good play folds everyone out, so the "sacred" showdown rarely happens. | Critical | High | Hidden symmetric info raises survival vs card poker; design the *uncontested* win as a premium beat; tune blinds/depth for more showdowns; validate in playtest (`02 §F1`, `OQ`). |
| P3 | **Pacing: "staring at a chart"** — long dead stretches in a 10-min match → poor D1/D7. | High | High | Observation→betting rhythm; live distance-to-conviction UI; test a Blitz format; instrument time-to-first-meaningful-decision (`OQ`). |
| P4 | **Prediction clustering** compresses showdown distances → winner feels random. | High | Medium | TWAP settlement prevents single-tick decisions; natural dispersion from genuine views; accept poker-style variance; monitor distance distributions. |
| P5 | **Nit equilibrium / dead pots** — fold-everything meta keeps pots at blind size; boring. | Medium | Medium | Blind/ante schedule; monitor median pot ÷ blinds as a health metric; tune. |
| P6 | **Round III anticlimax** — late price near-known, far players fold, final street collapses. | Medium | Medium | Numbers stay hidden so confidence ≠ certainty; muck-on-fold; playtest the endgame. |
| P7 | **Learning curve too steep** for non-poker users (premium audience may still be casual). | Medium | Medium | Guided first-match, clear exposure UI, practice/low-stake tier; onboarding is a launch requirement. |
| P8 | **Thin liquidity / empty tables** at launch → can't fill 2–5 seats → bad first impression. | High | Medium | Concentrate launch on few assets/tiers/times; bot-free fill incentives; clear VOID-refund so empty tables never cost users. |

## B. Economic & incentive risks

| ID | Risk | Severity | Probability | Mitigation |
|----|------|----------|-------------|------------|
| E1 | **No revenue model defined** in source; unmonetized real-money game. | High | High (until set) | Transparent capped pot rake (`GAME_MECHANICS §14`); set `rake_pct`/`rake_cap` (business `OQ`). |
| E2 | **Rake too high → negative-sum drives players away; too low → unsustainable.** | High | Medium | Model against poker benchmarks; A/B by tier; cap so small pots aren't over-raked. |
| E3 | **Predatory bankrolls/sharks farm casuals**, killing the funnel. | High | High | Skill bucketing, stake caps, anti-bot, healthy-table matchmaking (`REQ §2`). |
| E4 | **Minimum-tier economics broken by on-chain fees** (10 USDC stake vs fees/rent). | Medium | Medium | Sponsored/relayed tx or pre-disclosed fee model; validate unit economics per tier (`ARCH §11`, `OQ`). |
| E5 | **Settlement-price manipulation for profit** (push the print toward your number). | Critical | Low–Med | Window-median; **configurable buy-in/table caps** (`max_buy_in`, default ~$5M headroom, per-feed « market-impact size) are the v1 control; detailed manipulation telemetry / cross-match correlation **deferred to post-PFM**. |
| E6 | **Reward variance too high** → players feel it's luck and churn before skill shows. | Medium | Medium | Honest variance framing; volume-based loyalty; leaderboards over many matches not one. |

## C. Security & integrity risks

| ID | Risk | Severity | Probability | Mitigation |
|----|------|----------|-------------|------------|
| S1 ⛔ | **Oracle failure/degradation decides pots on bad data.** | Critical | Medium | Switchboard On-Demand (default, swappable); confidence/staleness guards; redundant readers; auto-VOID + refund; Sev-1 runbook (`ARCH §3`). |
| S2 ⛔ | **Smart-contract vulnerability drains the vault** (custody bug, reentrancy-class, math error). | Critical | Medium | Minimal-trust contract; explicit state transitions; conservation asserts on-chain; multiple independent audits; formal review of settlement & payout; bug bounty. |
| S3 | **Collusion at 2–5 handed tables** (chip-dumping, squeeze, out-of-band number sharing). | High | High | Muck-on-fold; VRF seating; collusion telemetry; T&S enforcement; accept residual risk and price for it (`ARCH §9`). |
| S4 | **Sybil / multi-accounting** to gain table majority or farm bonuses. | High | Medium | Proof-of-personhood at seating; one active seat per identity; wallet-cluster analysis. |
| S5 | **Prediction recovered from its sealed form before match end.** | High | Low | Time-lock encryption is IND-CPA — the ciphertext leaks nothing about a low-entropy price, and **no decryption key exists** until the beacon publishes it at match end (`ARCH §2`). |
| S6 | **Engine compromise / action forgery / replay tampering.** | Critical | Low | Signed intents; hash-chained log; on-chain validation of recomputed settlement; single-writer lease (`ARCH §4`). |
| S7 | **Latency exploitation** (act on later information than opponents). | Medium | Medium | Server-authoritative clock/timers; no client-trusted timing; consistent fan-out. |
| S8 | **Front-running deposits/settlement on-chain.** | Medium | Low | Seal before LIVE; settlement validated, not racing; idempotent payout. |
| S9 | **Public action feed leaks** a sealed prediction or collusion-useful info. | High | Low | Feed carries only table-public data, pseudonymous, read-only; sealed predictions are time-lock-protected until match end; no queued intents/pre-signed defaults exposed (`ARCH §13`). |

## D. Architecture & reliability risks

| ID | Risk | Severity | Probability | Mitigation |
|----|------|----------|-------------|------------|
| A1 ⛔ | **Non-determinism** makes settlement non-reproducible → disputes, can't validate on-chain. | Critical | Medium | Event-sourced signed log; recorded oracle samples + VRF; pure settlement fn; replay test in CI (`ARCH §4`). |
| A2 | **Side-pot math bug** mis-pays real money. | High | Medium | Shared pure module; property-based + exhaustive tests; on-chain conservation assert; VOID on failure (`ARCH §5`). |
| A3 | **Per-match engine crash** loses in-flight state. | High | Medium | Shard-per-match isolation; recover by log replay; snapshotting. |
| A4 | **Double-write / split-brain** on a match (two engines act). | High | Low | Single-writer lease/lock per match; fencing tokens. |
| A5 | **Spectator fan-out degrades active gameplay.** | Medium | Medium | Separate read path; backpressure isolation (carried from source requirement). |
| A6 | **Solana congestion / finality delays** stall deposits/claims. | Medium | Medium | Clear pending states; retries; priority fees; degrade gracefully, never silently. |
| A7 | **Refund/VOID engine fails to return capital** in a fault. | Critical | Low | Refund-from-last-verifiable-state path; reconciliation; capital-safety supersedes all. |
| A8 | **Time-lock beacon unavailable** at match end → predictions can't decrypt. | High | Low | Reputable decentralized beacon (e.g., drand League of Entropy); bounded grace → VOID + full refund; monitored like the oracle (`ARCH §2`, mechanics §12). |

## E. UX & trust risks

| ID | Risk | Severity | Probability | Mitigation |
|----|------|----------|-------------|------------|
| U1 | **Financial surprise** (unexpected loss, hidden fee, unclear exposure) destroys premium trust. | High | Medium | Pre-commit exposure clarity; disclosed rake; no ambiguous capital states (`BUILDER_VISION`, `REQ §15`). |
| U2 | **"The chart said X but I lost"** — perceived settlement mismatch. | High | Medium | One recorded feed drives chart and `S`; show samples; user-verifiable record (`ARCH §3`). |
| U3 | **Disconnect feels like theft** (folded/lost stake to a network blip). | High | Low–Med | Pre-signed default action; auto-check never folds a free check; all-in safe; reconnection; predictions auto-decrypt via time-lock so a disconnect can never cost a won pot (`REQ §13`). |
| U4 | **Onboarding overwhelm** for the financial/poker hybrid. | Medium | Medium | Guided first match; progressive disclosure; practice tier. |
| U5 | **Loss of funds perception during VOID/refund delay.** | Medium | Medium | Instant, communicated refund states; status transparency. |

## F. Regulatory / external (explicitly deferred by founder, tracked for completeness)

| ID | Risk | Severity | Probability | Mitigation |
|----|------|----------|-------------|------------|
| RG1 | **Real-money wagering = gambling/derivatives regulation** by jurisdiction. | Critical | High | **Geofencing implemented at launch** (Q18) blocks restricted jurisdictions; full legal classification still deferred ("regulation last step"); KYC reachable. Remains the largest external risk. |
| RG2 | **Spectator betting market** would compound regulatory exposure. | High | — | Out of v1 scope; sealed behind a seam (`ARCH §13`). |

---

## Top of the register (read this if nothing else)

The ⛔ existential set — **P1 (positioning), P2 (reveal-vs-fold), S1 (oracle), S2 (contract), A1 (determinism)** — carries the overwhelming majority of foundation risk. Four of the five are addressed structurally in the canonical mechanics and architecture; **P2 is the one that can only be resolved empirically, in playtest.** RG1 (regulation) is the largest *external* risk and is consciously deferred by the founder, not solved here.
