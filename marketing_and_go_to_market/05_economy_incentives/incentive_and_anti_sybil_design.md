# Incentive & Anti-Sybil Design

Incentives are the wiring under the whole economy — Season 0 points (`./points_and_pre_token_meta.md`), the eventual token (`./token_strategy_and_airdrop.md`), House rev-share, Council multipliers, quest rewards. If that wiring is even slightly miscalibrated, it does the opposite of its job: it imports mercenary capital, invites sybil farms, and corrodes the non-buyable status that *is* the moat (`../00_foundation/lexicon_and_status_system.md`). This file states the design principles, the proof-of-personhood and wallet-cluster machinery, the anti-pay-to-win rules, the reward sinks, and the farming/collusion mitigations.

## The First Law of Syndicate incentives

> **Every incentive must reward PLAY, RETENTION, or RECRUITING — never pure deposits.**

This single rule, applied without exception, is what keeps Syndicate the anti-casino and keeps mercenary capital productive instead of parasitic. Three consequences follow directly:

1. **No deposits-for-rewards.** No points, tokens, multipliers, or perks accrue from wallet balance, deposit size, or USDC parked. Fresh per-match buy-ins (`../00_foundation/positioning_and_brand.md`) mean there is no "deposit" to reward in the first place — by design.
2. **Reward verbs, not balances.** The reward surface only attaches to *actions*: seating, surviving to reveals, daily streaks, founding/growing Houses, recruiting Operators who *play*, minting clips. (Formula-level in `./points_and_pre_token_meta.md`.)
3. **Status is never for sale.** Rank, Council seats, Grand Operator standing, and in-match outcomes are **non-buyable** with any currency, point, or token. Incentives can decorate and discount; they can never purchase prestige or edge.

## Why this matters more on Solana

Solana's points/airdrop meta is the primary speculative growth driver (`../00_foundation/growth_model_and_flywheel.md` loop 5) — which means **sybil farms attack it as a primary target**. A naive program is a faucet pointed at bots. Our defense is two-layered: (a) the *product itself* is expensive to fake (you must play skill-expressive, capital-at-risk matches to a reveal), and (b) an explicit personhood + cluster stack on top. Mercenary capital is welcome **only as fuel routed into play and retention** — never as deposits chasing rewards.

## Proof-of-personhood (the gate)

Personhood is a **hard gate** on reward vesting, not a nice-to-have. No personhood → reduced or zero accrual, regardless of activity.

- **Tiered personhood score (0–1):** built from stacked signals — wallet age/history, on-chain reputation, optional verified credentials (e.g. civic/identity attestations available in the Solana ecosystem), and Syndicate's own play-history. Higher score → higher multiplier on `final_score` (`./points_and_pre_token_meta.md`).
- **Personhood floor for the airdrop:** below the floor, token allocation is **zero** no matter the points (`./token_strategy_and_airdrop.md`).
- **Progressive trust:** new Operators can play and accrue *provisionally*; rewards vest as personhood and genuine play history accumulate. This avoids gating legitimate newcomers while denying instant bot payouts.
- **Privacy-respecting:** we prefer attestation/zk-style proofs over collecting raw PII where the ecosystem supports it — consistent with the premium, careful brand posture.

## Wallet-cluster & anti-sybil analysis

Farms operate fleets of wallets; the defense is to **collapse the fleet to one identity (or zero)**:

- **Funding-graph clustering:** wallets funded from a common source / in tight sequence are clustered; cluster shares **one** allocation, not N. `cluster_integrity` ↓ scales the whole cluster's rewards down.
- **Behavioral fingerprinting:** identical play timing, mirrored bet sizing, synchronized session windows, or templated House structures flag coordinated fleets.
- **Activity-cost asymmetry:** because earning requires playing contested matches to reveals (capital at risk, skill-rated), a farm must burn real buy-ins across thousands of wallets to farm meaningfully — usually **economically irrational**. The rake/fee model quietly taxes the farmer on every match.
- **Recruit-vesting trap:** RECRUIT points only vest when the recruited Operator *actually reaches a reveal* (`./points_and_pre_token_meta.md`). A sybil "recruiting" idle sub-wallets earns nothing. This single rule neutralizes the most common referral-farm.
- **Clawback windows:** points/airdrop snapshots are challengeable; flagged clusters are slashed before tokens or rewards settle.

## Anti-pay-to-win (protecting status)

A status civilization where money buys rank is worthless — the chase evaporates and the brand with it. The rules (also in `../00_foundation/lexicon_and_status_system.md`):

- **Skill-over-volume rating.** Rank is a poker-style skill rating, not a volume or balance counter — you cannot grind or buy your way up purely by spending.
- **No purchasable edge.** No currency, point, token, or perk improves your odds, information, or position in a live match. The sealed prediction stays unreadable to all; settlement (closest eligible prediction wins, poker side-pot rules) is untouched by any economy mechanic.
- **Perks are cosmetic or social, never competitive.** Token/points perks (`./token_strategy_and_airdrop.md`) decorate profiles, unlock Houses/events, and discount the *rake/fee* — they never touch match outcomes.
- **Tier ≠ advantage.** Tiers (Premium/Elite/Institutional/Royal) gate *stakes and prestige*, not *odds* — a Royal Operator has no edge over a Premium one at equal skill.

## Reward sinks & a sustainable economy

Faucets without sinks inflate to worthlessness and collapse post-airdrop. We engineer durable demand:

| Sink | What it absorbs | Effect |
|------|------------------|--------|
| **Entry fee + pot rake** | the core revenue take (configurable) | the foundational sink; every match recycles value, and *taxes farmers* |
| **House founding/upgrade stakes** | token locked to found or level up a House | recruiting-gated demand; ties tokens to the K-factor loop |
| **Cosmetic & insignia burns** | profile flair, ceremony access, season cosmetics | status-expression demand without pay-to-win |
| **Event/lounge access** | token spent for ritual/coronation entry (`../04_community/`) | converts prestige-seeking into a sink |
| **Retention-gated vesting** | rewards that only unlock via continued play | suppresses claim-and-dump (`./token_strategy_and_airdrop.md`) |

Design target: **sinks scale with engagement** so a healthier, more active Syndicate is a *deflationary-feeling* one — the opposite of the inflate-and-dump default.

## How incentives interact with the rake/fee model

- The **entry fee (on join)** and **pot rake (at settlement)** are the revenue engine *and* the primary sink — the two are the same lever viewed from two sides.
- **Token fee-discounts** reduce *Syndicate's* take for loyal holders/stakers; they **never** alter pot splits between Operators. Loyalty is rewarded out of the house's margin, not other players' winnings.
- **Incentive budget is funded from the rake**, not from selling status — so growth spend is a share of real revenue, keeping the economy self-funding and the brand un-compromised.
- **No incentive may invert the fee model** — e.g. paying points to deposit, or rebating buy-ins for volume — because that re-introduces deposits-for-rewards and casino dynamics. Hard prohibition.

## Collusion-adjacent & farming risks (and mitigations)

Multiplayer real-money + rewards invites coordination abuse. Risks and defenses:

| Risk | Vector | Mitigation |
|------|--------|------------|
| **Chip-dumping / soft collusion** | colluding Operators steer pots to one wallet to farm WIN/points | bet-pattern anomaly detection; `collusion_clawback` on `final_score`; table-composition randomization for ranked play |
| **Sybil referral farm** | fake "recruits" to harvest RECRUIT points | recruit-vesting trap (must reach a reveal) + cluster analysis |
| **Clip-view farming** | botted views to inflate DRAMA points | verified-reach only, per-clip caps, platform-side authenticity checks |
| **Quest/Blink multi-claim** | one human, thousands of wallets claiming quest points | personhood gate + cluster collapse at the rail (`./points_and_pre_token_meta.md`) |
| **Mercenary deposit-farming** | parking capital expecting balance rewards | structurally impossible — no balance/deposit ever earns; fresh per-match buy-ins only |
| **Wash-play for volume** | self-matched low-stakes games to farm PLAY | skill-rating + minimum contested-table requirements + rake tax makes wash-play unprofitable |
| **Post-airdrop mercenary exit** | claim and dump, activity craters | retention-gated vesting + escrowed emissions + non-buyable status anchor (`./token_strategy_and_airdrop.md`) |

## The compounding logic

Note the elegance: because the **product** requires skill-expressive, capital-at-risk, socially-costly actions to earn anything, most sybil/farming attacks are *priced out by the game design itself* before personhood and clustering ever engage. The economy is sybil-resistant **first** through what it rewards, **second** through who it lets claim. That layering is the whole defense.

## The single test for any incentive

*Does it reward PLAY, RETENTION, or RECRUITING (never deposits), keep status and match outcomes non-buyable, fund itself from the rake, and survive a sybil farm and a collusion ring?* If any clause fails, the mechanic does not ship. Behavioral and economic health are tracked in `../07_growth_ops_metrics/north_star_and_kpis.md`; new mechanics are A/B-validated via `../07_growth_ops_metrics/growth_experiment_backlog.md`.
