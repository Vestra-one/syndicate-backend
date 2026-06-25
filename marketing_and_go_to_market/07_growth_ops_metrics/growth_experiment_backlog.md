# Growth Experiment Backlog

Growth is a **rate of validated learning**, not a list of opinions. This is the prioritized, ICE-scored backlog of Solana-native experiments. Every experiment names a **hypothesis**, the **loop** it serves (`../00_foundation/growth_model_and_flywheel.md`), the **metric it moves** (`./north_star_and_kpis.md`), and a measurement plan. We run the highest-ICE items first, ship learnings to the weekly growth review, and recycle wins back into the flywheel.

## How we score (ICE)

**ICE = Impact × Confidence × Ease**, each scored 1–10; ICE shown as the product-normalized average (1–10). High ICE ≠ "do forever" — it means "test next."

- **Impact:** expected lift on the named metric, weighted toward the North Star (WAO-CR), K-factor, and W4 retention.
- **Confidence:** strength of prior evidence (Solana precedent, internal data, analogous loop performance).
- **Ease:** eng + design + ops cost to ship a *valid* test (instrumentation included).

## How we run & measure (standing rules)

- **Randomized assignment** at the Operator (or invite) level; never compare time-periods when a controlled split is possible.
- **Pre-registered metric + guardrails:** every test declares its primary leading metric, the lagging metric it should eventually lift, and **brand/capital-safety guardrails** (no test may make rank buyable, push casino framing, or reward deposits — `../05_economy_incentives/incentive_and_anti_sybil_design.md`).
- **Minimum runtime:** run to a pre-set sample / through ≥1 weekly cycle to clear day-of-week effects; status/retention tests run through a Season where relevant.
- **Anti-sybil sanitation:** results are filtered through personhood + cluster checks so farms don't fake a "win" (`../05_economy_incentives/incentive_and_anti_sybil_design.md`).
- **One-pager per result:** hypothesis → result → decision (scale / iterate / kill) → flywheel implication.

## The backlog

| # | Experiment | Hypothesis | Loop | Metric moved | ICE |
|---|------------|------------|------|--------------|-----|
| 1 | **Blink invite vs. link invite A/B** | A one-tap on-chain **Blink** "Join my House" Action converts higher than a standard link because it removes signup friction in-feed | House referral (2) | invite conversion, K-factor | **9.0** |
| 2 | **Auto-share clip prompt on reveal** | Prompting an Operator to post their auto-generated clip *at the dramatic reveal moment* lifts clip-share rate vs. a passive gallery | Clip (1) | clip shares/reach, WAO-CR | **8.7** |
| 3 | **Practice→real conversion nudge** | A contextual nudge after a strong practice reveal ("take a real seat — a table is open") lifts practice→real conversion | PMF/activation | practice→real conv., % reaching first reveal | **8.5** |
| 4 | **Council-entry push notification** | Notifying an Operator the moment they're *one rank from The Council* drives a play burst to break in (and a clip) | Status/Council (3) | session frequency, WAO-CR, clip reach | **8.3** |
| 5 | **House rake-share level test** | A higher founder rake/points-share for active Houses lifts House founding + recruiting without harming margin | House referral (2) | House founding rate, K-factor | **8.0** |
| 6 | **Points-weight tuning: DEPTH↑** | Raising the **reaching-reveal** point weight (vs. win bonus) lifts the share of Operators who survive to reveals (the North Star unit) | Points (5) | WAO-CR, % reaching reveal | **8.0** |
| 7 | **KOL House seeding** | Seeding a KOL with a pre-built House + Council fast-lane yields more activated Operators than equivalent paid CT spend | KOL-as-Operator (6) | KOL-House yield, CAC-by-loop | **7.8** |
| 8 | **Quest-platform campaign** | A "play 3 contested matches" quest on a Solana quest aggregator channels mercenary quest-farmers into *play*, lifting activated Operators at low CAC | Ecosystem (7) + Points (5) | Blink/quest acquisition, activation | **7.7** |
| 9 | **Coronation broadcast lift** | Broadcasting the **Grand Operator** coronation as a marquee event lifts external reach and same-week new Operators | Status/Council (3) + Community | coronation reach, acquisition | **7.5** |
| 10 | **"Rank to defend" re-engagement** | Notifying a lapsing Operator that their rank is *under threat* wins back more than a generic "come back" message (proves status-retention) | Status (3) / retention | D7/W4 retention, rank-defense cohort | **7.5** |
| 11 | **Chamber draft mechanic** | A visible Chamber "draft window" where Chambers recruit strong Operators lifts Chamber-membership and team retention | Chamber (4) | Chamber count, retention lift | **7.3** |
| 12 | **Folder "what-would-have-happened" clip** | Auto-generating a clip showing the outcome a *folded* Operator dodged/missed drives shares even from non-winners | Clip (1) | clip volume/reach | **7.2** |
| 13 | **Points leaderboard embed (Blink)** | A Blink-embeddable live **Season 0** points leaderboard in tweets drives click-through to play | Points (5) + Ecosystem (7) | leaderboard CTR, acquisition | **7.0** |
| 14 | **Wallet partner co-quest** | A co-branded quest surfaced inside a partner wallet (Phantom/Backpack) sends pre-qualified Solana users into activation | Ecosystem (7) | partner acquisition, activation | **7.0** |
| 15 | **Tier-up reveal teaser** | Showing Premium Operators a glimpse of Elite/Institutional prestige (cosmetic, never odds) lifts tier mix without pay-to-win | Status (3) / monetization | tier mix, ARPO | **6.8** |
| 16 | **Streak-save mechanic** | A one-time "streak shield" earned by play (not bought) increases daily-ritual rate and LOYALTY-point accrual | Points (5) / retention | streak rate, D7 retention | **6.7** |
| 17 | **Spectator-to-Operator CTA** | A "take the next seat" CTA on live/clip spectator surfaces converts watchers into Operators | Clip (1) | clip→Operator conversion | **6.7** |
| 18 | **Onboarding time-to-aha cut** | Shaving steps before the first sealed-reveal (skip-to-practice) lowers time-to-aha and raises first-reveal rate | PMF/activation | time-to-aha, % first reveal | **6.5** |
| 19 | **House-vs-House leaderboard rivalry** | A public House-vs-House points race (with auto-clipped lead changes) drives recruiting and drama | House (2) + Clip (1) | House founding, K-factor, clip reach | **6.5** |
| 20 | **Retention-gated reward escrow A/B** | Escrowing a slice of Season-0 reward to vest on continued play reduces post-reward churn vs. immediate grant (de-risks the airdrop, `../05_economy_incentives/token_strategy_and_airdrop.md`) | Points (5) / retention | W4 retention, post-reward churn | **6.3** |

## Reading the backlog

- **Top cluster (ICE ≥ 8):** all hit the North Star, K-factor, or activation directly and are cheap to instrument — Blinks, the Clip auto-share, the practice-conversion nudge, and Council/points mechanics. These are the **fund-first** set.
- **Loop coverage is deliberate.** Every one of the seven loops appears; we never over-index one engine. If a loop is under-represented in *wins*, we add experiments there next cycle.
- **No experiment violates the First Law.** Nothing here rewards deposits, makes rank or table-edge buyable, or pushes casino framing — those are auto-rejected at design (`../05_economy_incentives/incentive_and_anti_sybil_design.md`, `../00_foundation/positioning_and_brand.md`).

## Sequencing against the roadmap

Experiment priority tracks the phase we're in (`../08_roadmap/phased_gtm_roadmap.md`):

- **Phase 0–1 (PMF/Retention):** #3, #6, #16, #18, #20 — prove the aha, the reveal weighting, and retention before amplifying.
- **Phase 1–2 (Virality/Community):** #1, #2, #4, #5, #7, #9, #10, #11, #12, #17, #19 — turn retained Operators into recruiters, teams, and content.
- **Phase 2–3 (Ecosystem/Token):** #8, #13, #14, #15 — scale via Solana rails and partner surfaces once retention is proven and the points→token path is credible.

## From experiment to flywheel

A winning experiment isn't "done" — it's **wired into a loop** so it compounds: a higher-converting Blink becomes the default invite; a sharper reveal-clip prompt becomes the standard Clip Engine behavior; a tuned point weight ships into the next Season (`../05_economy_incentives/points_and_pre_token_meta.md`). The backlog is the *engine of the flywheel's acceleration* — each validated win lowers the cost of the next Operator (`../00_foundation/growth_model_and_flywheel.md`). Losses are equally valuable: a killed hypothesis is budget saved and a sharper prior for the next test.
