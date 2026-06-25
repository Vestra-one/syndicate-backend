# North Star & KPI Tree

A growth org with twenty equal goals has none. Syndicate optimizes one number, surrounds it with a disciplined metric tree, and measures every loop and experiment against it. The tree below maps directly to the seven loops (`../00_foundation/growth_model_and_flywheel.md`) and the canonical sequence **PMF → Retention → Virality → Community → Ecosystem**.

## The North Star

> **Weekly Active Operators who reach a CONTESTED REVEAL** (WAO-CR).

A *contested reveal* = an Operator plays a match to settlement where the sealed prediction is unsealed against the live market with ≥2 eligible Operators (a real hand, not a walkover). We chose it because it is the rare metric that **couples all three things that matter at once**:

- **Engagement** — reaching a reveal means the Operator actually played the core loop, didn't just deposit and idle.
- **Monetization** — every contested reveal sits on an entry fee (on join) and a pot rake (at settlement); WAO-CR is mechanically correlated with revenue.
- **Virality** — the reveal *is* the dramatic moment the Clip Engine harvests; more reveals = more shareable drama = more acquisition.

Two **co-pilot metrics** ride alongside the North Star (per the foundation canon): **K-factor** (the flywheel won't spin without it) and **W4 retention** (the floor of the growth equation). If WAO-CR, K-factor, and W4 rise together, the flywheel is compounding.

## Reading the tree: leading vs lagging

- **Leading indicators** move *first* and are *actionable this week* (time-to-aha, invites/Operator, clip share rate, first-reveal rate). Growth-ops steers on these.
- **Lagging indicators** confirm the strategy worked (W4 retention, ARPO, Council churn, LTV). They validate; they don't steer.
- Rule: **every experiment names the leading metric it moves and the lagging metric it should eventually lift** (`./growth_experiment_backlog.md`).

## The metric tree

```
                    NORTH STAR: Weekly Active Operators reaching a Contested Reveal (WAO-CR)
                                   co-pilots: K-factor · W4 retention
        ┌───────────────┬───────────────┬───────────────┬───────────────┬───────────────┐
        ▼               ▼               ▼               ▼               ▼               ▼
   ACQUISITION     ACTIVATION       RETENTION        VIRALITY      MONETIZATION      COMMUNITY
   CAC-by-loop    time-to-aha       D1/D7/W4       invites/Op       rake+fee rev    Chamber/House #
   K-factor       %→first reveal   rank-defense    House founding   ARPO            Council churn
                                    cohort          clip reach      tier mix
```

## Acquisition

| Metric | Definition | Lead/Lag |
|--------|------------|----------|
| **CAC by loop** | fully-loaded cost to acquire one activated Operator, attributed per loop (Clip, House, Status, Chamber, Points, KOL, Ecosystem) | lagging |
| **K-factor** | invites sent per Operator × conversion per invite; **K>1 = self-propagating** | leading |
| **Blink/quest acquisition rate** | activated Operators sourced via Blinks/Actions and quest platforms (`../05_economy_incentives/points_and_pre_token_meta.md`) | leading |
| **KOL-House yield** | activated Operators per seeded KOL House (`../01_acquisition/kol_and_creator_program.md`) | lagging |
| **Loop attribution mix** | share of new Operators by loop — tells us which loop to fund | lagging |

We track CAC **per loop** because the strategy funds *loops, not clicks* (`../00_foundation/executive_summary.md`). A blended CAC hides which engine is actually working.

## Activation (the "aha")

| Metric | Definition | Lead/Lag |
|--------|------------|----------|
| **Time-to-aha** | minutes from first open → **first SEALED-REVEAL** (target: a few minutes, via practice mode) | leading |
| **% reaching first reveal** | share of new Operators who reach *any* reveal in session 1 | leading |
| **Practice→real conversion** | share who move from no-stakes practice to a real buy-in | leading |
| **First-House / first-Chamber rate** | share who join/found a House or Chamber in week 1 (early-retention predictor) | leading |

Activation is where the North Star is *born* — a first reveal is the leading edge of WAO-CR. (`../02_activation_retention/`)

## Retention (the floor)

| Metric | Definition | Lead/Lag |
|--------|------------|----------|
| **D1 / D7 retention** | % of new Operators active 1 / 7 days later | leading→lagging |
| **W4 retention** | % active in week 4 — **co-pilot metric**; the durability signal | lagging |
| **Rank-defense cohort** | retention of Operators *with rank to defend* (in/near The Council) vs. those without — should be dramatically higher; proves status drives retention | lagging |
| **Streak / daily-ritual rate** | share maintaining a play streak (LOYALTY points input, `../05_economy_incentives/points_and_pre_token_meta.md`) | leading |
| **Chamber-membership retention lift** | retention delta for Chamber members vs. solo Operators (proves team stickiness) | lagging |

The **rank-defense cohort** is our most important retention diagnostic: if Operators with status retain far better than those without, the status civilization is doing its job (`../00_foundation/lexicon_and_status_system.md`).

## Virality

| Metric | Definition | Lead/Lag |
|--------|------------|----------|
| **Invites per Operator** | avg invites sent (the volume half of K) | leading |
| **Invite conversion** | activated Operators per invite (the quality half of K) | leading |
| **House founding rate** | share of Operators who found a House (the K-factor engine, `../03_virality_network_effects/viral_loops_and_referrals.md`) | leading |
| **Clip shares & reach** | clips minted × verified external reach (the Clip Loop) | leading |
| **Clip→Operator conversion** | activated Operators attributable to a clip | lagging |
| **Coronation/Council-move reach** | external reach of status broadcasts | leading |

## Monetization

| Metric | Definition | Lead/Lag |
|--------|------------|----------|
| **Rake + entry-fee revenue** | total take from the configurable entry fee + pot rake | lagging |
| **ARPO** | average revenue per (weekly) active Operator | lagging |
| **Revenue per contested reveal** | rake+fee per reveal — ties money directly to the North Star unit | lagging |
| **Tier mix** | distribution across Premium / Elite / Institutional / Royal | lagging |
| **House rev-share payout ratio** | share of rake routed to House founders (recruiting incentive health) | lagging |
| **LTV : CAC by loop** | lifetime value vs. acquisition cost, per loop | lagging |

Monetization is deliberately downstream — we never optimize ARPO at the expense of WAO-CR or the anti-casino brand (`../00_foundation/positioning_and_brand.md`). Revenue follows engagement, not the reverse.

## Community

| Metric | Definition | Lead/Lag |
|--------|------------|----------|
| **Chamber count & active-Chamber rate** | total Chambers and share with sustained activity (`../04_community/`) | lagging |
| **House count & active-House rate** | total Houses founded and share filling tables | lagging |
| **Council churn** | turnover in the top-100 per season — *some* churn = healthy aspiration; *too much* = instability | lagging |
| **Grand Operator / coronation engagement** | participation and reach of marquee rituals | lagging |
| **Points-leaderboard participation** | Operators with non-trivial Season 0 points (speculation-loop health) | leading |

## Phase-based targets

Directional targets per phase (`../08_roadmap/phased_gtm_roadmap.md`); calibrated, not contractual. The discipline is **sequencing** — we do not chase virality before retention clears its bar.

| Metric | Phase 0 (PMF) | Phase 1 (Retention) | Phase 2 (Virality/Community) | Phase 3 (Ecosystem) |
|--------|---------------|---------------------|------------------------------|---------------------|
| **WAO-CR (North Star)** | establish baseline | steady WoW growth | inflection / compounding | scaled, durable |
| **Time-to-aha** | < a few min (prove it) | hold | hold under volume | hold under volume |
| **% reaching first reveal** | prove the aha lands | rising | high & stable | high & stable |
| **D7 retention** | learn the curve | meaningfully positive | strong | strong |
| **W4 retention (co-pilot)** | n/a (too early) | the gate to scale | durable | durable |
| **K-factor (co-pilot)** | < 1 (seed) | approaching 1 | **K > 1** | K > 1, sustained |
| **House founding rate** | seed manually | growing organically | self-sustaining | self-sustaining |
| **Council churn** | n/a | establish Council | healthy turnover | stable prestige |
| **ARPO** | not optimized | baseline | growing | optimized w/o brand harm |

**The token does not launch until the Phase-1/2 retention gate (W4 + rank-defense cohort) clears** — see `../05_economy_incentives/token_strategy_and_airdrop.md`.

## Definitions table (canonical)

| Term | Precise definition |
|------|--------------------|
| **Operator** | a player with a real seat and wallet-bound profile (`../00_foundation/lexicon_and_status_system.md`) |
| **Active Operator** | played ≥1 real match in the period |
| **Contested reveal** | a match played to settlement, sealed prediction unsealed, ≥2 eligible Operators |
| **WAO-CR** | weekly count of distinct Operators reaching ≥1 contested reveal — **the North Star** |
| **Activated Operator** | reached their first reveal (the activation bar) |
| **K-factor** | invites/Operator × conversion/invite |
| **W4 retention** | % of a weekly cohort active in their 4th week |
| **Rank-defense cohort** | Operators in or adjacent to The Council, tracked for retention |
| **ARPO** | rake + entry-fee revenue ÷ weekly active Operators |
| **CAC by loop** | fully-loaded acquisition cost attributed to the originating loop |

## Operating cadence

- **Weekly growth review:** WAO-CR + K-factor + W4 on the wall; every owned loop reports its leading metric; experiment results from `./growth_experiment_backlog.md` are read out.
- **Per-Season review:** Council churn, retention cohorts, points-leaderboard health, tier mix, LTV:CAC — recalibrate point weights (`../05_economy_incentives/points_and_pre_token_meta.md`) and phase targets.
- **One number governs trade-offs:** when two initiatives compete, the one that moves **WAO-CR** (without harming the brand or capital safety) wins.
