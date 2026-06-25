# Season 0 — Points & the Pre-Token Meta

On Solana, points are the most powerful **pre-product growth primitive** there is. A transparent, credible points season prices *future* upside today and turns speculative attention into present-tense behavior. The trap is that 99% of points programs reward the wrong thing — **deposits and TVL** — which imports mercenary capital that parks, farms, and dumps. Syndicate's **Season 0** is engineered to reward exactly one thing: **the right behavior** — play, retention, reaching reveals, recruiting via Houses, growing Chambers, and minting clips. Points are the speculation loop (`../00_foundation/growth_model_and_flywheel.md` loop 5), bent to fund the flywheel instead of bleeding it.

> Season 0 is not an airdrop campaign. It is a **leaderboard of conviction** that happens to be redeemable. The token strategy that sits behind it lives in `./token_strategy_and_airdrop.md`; the anti-sybil spine that protects it lives in `./incentive_and_anti_sybil_design.md`.

## First principles

1. **Points reward verbs, not balances.** You earn by *doing the things that make Syndicate win* — taking seats, surviving to reveals, recruiting, creating drama. Never by how much USDC you hold or deposit. (The rule, stated formally in `./incentive_and_anti_sybil_design.md`.)
2. **Points are status-adjacent but not status itself.** Points can buy perks and a claim on a future token; they can **never** buy a Council seat, a rank, or an edge at the table. Status stays non-buyable (`../00_foundation/lexicon_and_status_system.md`). This is the brand's life-support.
3. **Transparency is the product.** A live, public, on-chain-verifiable points leaderboard *is* a recruiting poster and a speculation venue. Opaque points (Web2-style "we'll decide later") kill credibility on CT. Every Operator can compute their own score.
4. **Capital safety is sacred.** Fresh per-match buy-ins, no deposits-for-rewards. Points never incentivize over-funding a wallet (`../00_foundation/positioning_and_brand.md` anti-casino posture).

## What earns points (the weighted ledger)

Points accrue to an **Operator's wallet-bound score**, computed nightly from on-chain match data and a small set of off-chain growth signals (clips, verified recruits). Five buckets:

| Bucket | What it rewards | Why it's weighted this way |
|--------|------------------|----------------------------|
| **PLAY** | volume of *real, contested* matches played to settlement | the North Star input — engagement + monetization |
| **DEPTH** | reaching the **contested reveal**, surviving deep, final-table finishes | rewards staying in the hand, not folding instantly to farm |
| **LOYALTY** | streaks, daily ritual, season-long activity, rank defense | retention is the floor of the growth equation |
| **RECRUIT** | founding/growing a **House**, verified Operators brought who *play* | K-factor; the referral engine made point-bearing |
| **DRAMA** | clips minted and their verified reach (views/reposts) | the Clip Loop; cheapest acquisition |

Explicitly **NOT** point-earning: deposit size, wallet balance, raw USDC moved, time-in-app idling, or any action a bot can do without skill or social cost.

## Example point formulas (Season 0 v1 weights)

These are illustrative and tunable (weight-tuning is itself an experiment — `../07_growth_ops_metrics/growth_experiment_backlog.md`). Let a *contested match* be one that reaches a reveal with ≥2 eligible Operators.

**Per-match base (PLAY + DEPTH):**
```
match_points = BASE_SEAT (10)
             + REACHED_REVEAL (25)            # the single most-weighted verb
             + FINAL_TABLE_BONUS (15)         # last 2 standing
             + WIN_BONUS (20)                 # closest eligible prediction
             + tier_multiplier × (above)      # Premium 1.0 / Elite 1.25 / Institutional 1.5 / Royal 2.0
```
Note the structure: a *win* is worth less than *reaching the reveal* + *playing*. We pay for engagement and drama, not just outcomes — and skill-weighting (poker-style rating) gates the multipliers so volume alone can't farm them.

**Loyalty (streaks & defense):**
```
daily_streak_bonus = min(STREAK_CAP (250), 10 × consecutive_active_days)
rank_defense_bonus = 100 × seasons_held_or_climbed_in_Council     # only if in/near The Council
```

**Recruit (House K-factor):**
```
recruit_points = Σ over recruited Operators r of:
    50 × is_activated(r)                      # r reached their first reveal (anti-sybil gate)
  + 0.05 × match_points(r)                    # founder earns a thin slice of recruits' PLAY
  + HOUSE_GROWTH_TIER(active_members)          # 100 @5, 300 @15, 800 @40 active members
```
Critically, recruit points only vest when the recruit **actually plays to a reveal** — a sybil that signs up and idles pays the recruiter nothing. This is where proof-of-personhood (`./incentive_and_anti_sybil_design.md`) does the heavy lifting.

**Drama (clips):**
```
clip_points = 30 × clip_minted
            + 0.5 × verified_external_views (capped 1,000 pts/clip)
            + 200 × clip_featured_by_Syndicate
```

**Anti-farm dampeners (applied last):**
```
final_score = Σ buckets
            × personhood_score (0–1, from proof-of-personhood)
            × cluster_penalty (↓ if wallet sits in a sybil cluster)
            − collusion_clawback (soft-collusion / chip-dumping detection)
```

## Live transparency & the points leaderboard

- A **public Season 0 leaderboard** (web + in-app + Blink-embeddable) ranks Operators, Houses, and Chambers by points, refreshed nightly. It is *the* CT artifact of the pre-token era.
- Every Operator gets a **points receipt**: a breakdown of exactly which verbs earned what, so the system reads as fair, computable, and ungameable-by-favoritism.
- **House and Chamber points** roll up — a House's standing is the sum of its Operators' RECRUIT + PLAY, giving founders a public scoreboard to rally around (and recruit against). This is the speculation loop and the community loop firing together.
- Leaderboard movements ("House X overtook House Y," "Operator Z entered top 50 points") are auto-clipped — points *manufacture drama* the same way reveals do.

## Solana-native distribution: Blinks & quests

Points are only as viral as their on-ramps. Season 0 distributes through Solana rails, not landing pages (see `../06_ecosystem_distribution/` for partner mechanics):

- **Blinks / Actions:** a single tweet carries a "Claim your first-seat points" or "Join my House" Blink — one-tap, in-feed, wallet-native (Phantom/Backpack). The invite *is* the point-earning action. Blink-invite vs link-invite is an A/B in the backlog.
- **Quest platforms:** time-boxed quests ("play 3 contested matches," "survive to a reveal at Elite tier," "found a House of 5") distributed via Solana quest aggregators, each granting points. Quests channel mercenary quest-farmers into **play and retention**, never deposits.
- **Partner co-quests:** wallets/perps partners surface a Syndicate quest to their users; completion requires *playing*, so partner traffic lands on real engagement.
- **Anti-sybil at the rail:** every Blink/quest claim passes the personhood + cluster check before points vest, so farms can't multiply across thousands of wallets (`./incentive_and_anti_sybil_design.md`).

## Season structure

| Element | Design |
|---------|--------|
| **Cadence** | discrete **Seasons** (~8–12 weeks) aligned to the rank/Council reset (`../00_foundation/lexicon_and_status_system.md`) |
| **Season 0** | the *pre-token* season — explicitly framed as priming the eventual claim; sets the precedent that points reward play |
| **Decay** | points are season-scoped for the leaderboard race; a **lifetime points** stat persists for status/lore but the *claimable* pool is per-season to keep urgency |
| **Caps** | per-Operator weekly point ceilings on RECRUIT/DRAMA to blunt industrial farming while leaving PLAY uncapped (we *want* unlimited play) |
| **Surprise multipliers** | unannounced "double DEPTH weekend," coronation-week boosts — manufactured drama + a retention spike |

## How points price early conviction (and feed speculation)

The speculation loop works because **points are a tradable belief about future value** even before a token exists:

- Early Operators rationally over-invest *play* to bank points, betting Season 0 converts to upside. That bet is settled honestly because the eventual airdrop maps to points (`./token_strategy_and_airdrop.md`).
- Because the *only* way to bank points is to **play, retain, recruit, and create**, speculative energy is forced through the product — the exact mercenary-to-marketing conversion the growth thesis demands.
- Speculators become **shillers of their own stake**: they want more eyeballs on Syndicate to validate their points, so they post clips and recruit Houses. Their self-interest is our distribution.
- The leaderboard makes conviction **legible and competitive**, which is itself content — points become a second status ladder running alongside rank (subordinate to it, never replacing it).

## Guardrails (what Season 0 must never do)

- Never let points or their future value imply **buyable rank** or **pay-to-win** — that detonates the brand (`../00_foundation/positioning_and_brand.md`).
- Never reward deposit size or balance — that imports parked mercenary capital and breaks capital safety.
- Never go opaque — the moment "we'll decide later" enters the narrative, CT prices in a rug and conviction evaporates.
- Never promise the token explicitly in restricted contexts — Season 0 communications stay careful and geofenced (regulation deferred; see `./token_strategy_and_airdrop.md`).

**The single test for any Season 0 mechanic:** *does it reward an Operator for playing, staying, recruiting, or creating drama — and is it computable, on-chain-verifiable, and sybil-resistant?* If not, it doesn't ship. Metric impact tracked in `../07_growth_ops_metrics/north_star_and_kpis.md`.
