# Retention Engine

Retention is the floor of the growth equation — `Operators(t+1) = Operators(t) × (Retention × K) + Paid` (`../00_foundation/growth_model_and_flywheel.md`). Virality multiplies a retained base; if Operators churn, K multiplies zero. We engineer retention from three durable forces Solana retail can't resist: **a rank to defend, a Chamber that depends on you, and a season that resets the chase.**

> You do not churn out of a game where you have rank to lose and teammates counting on you. Status and obligation are stickier than any reward schedule.

## The retention thesis: obligation > rewards

Most crypto apps retain with emissions; the moment yields fall, the base evaporates (mercenary churn). Syndicate retains with **social and status debt** that emissions can't replicate:

- **Status debt** — your rank decays / can be taken if you stop defending it.
- **Social debt** — your Chamber's standing needs your hands; absence lets teammates down.
- **Narrative debt** — a season has a finish line; quitting mid-season forfeits a story you're already in.

Rewards (points/token) ride on top as accelerant (`../05_economy_incentives/incentive_and_anti_sybil_design.md`), never the load-bearing structure.

## The "rank to defend" mechanic

Rank is not a trophy you keep — it is **a position under constant assault**.

- Season rating is **skill-over-volume** (poker-style; detailed in `progression_and_ranks.md`), but **inactivity decays standing**: miss the weekly active threshold and your rating soft-decays / you slide on the board as others play.
- **The Council (top 100) is a knife-fight.** Holding a seat means defending it; one strong week by a rival dethrones you. Scarcity (`../00_foundation/lexicon_and_status_system.md`) makes every seat contested every week.
- Defense is the most reliable daily trigger we have: *"someone is coming for your seat"* converts to a session better than any reward push.

## Seasons, resets & the chase

Seasons are the metronome of retention — they manufacture fresh goals on a cadence and reset the field so new Operators can climb (and lapsed ones can return without a hopeless deficit).

| Element | Design | Retention job |
|---------|--------|---------------|
| **Season length** | ~6–8 weeks | long enough for a real climb arc, short enough that a finish line is always near |
| **Soft reset** | ratings compress toward the mean; lifetime stats and lore persist | re-opens the chase without erasing identity |
| **Council refresh** | top 100 re-decided each season | recurring "who's in / who got dethroned" CT content |
| **Grand Operator coronation** | crowned at season end, ceremony | a finish line worth retaining for (`../04_community/rituals_events_and_seasons.md`) |
| **Pre-season** | next-season placement matches, House drafts | bridges the gap so there's no dead week between seasons |

The season clock also powers the most effective re-engagement window (see below).

## Streaks (light touch, status-flavored — never casino)

We use streaks for *rhythm*, not compulsion. They must read as discipline, not a slot machine.

- **Active-week streak** — consecutive weeks meeting the active threshold; visible on profile as an insignia, feeds rating stability.
- **No predatory daily-login casino loops.** No "spin to keep your streak," no fear-of-loss dark patterns — those violate the anti-casino positioning (`../00_foundation/positioning_and_brand.md`).
- Streaks reward the behavior we actually want (consistent competitive play), shown as a *credential* an Operator wants to flex, not a leash.

## Scheduled ritual play times (cold-start liquidity)

A multiplayer game dies on empty tables. We concentrate liquidity with **named, recurring ritual events** so an Operator always knows *when* the room is full — solving cold-start and creating appointment retention.

| Ritual | Cadence | Purpose |
|--------|---------|---------|
| **Prime Tables** | nightly, fixed hour per region | guaranteed full tables = liquidity anchor |
| **Chamber Night** | weekly | Chamber-vs-Chamber standings move (team retention) |
| **Council Hour** | weekly | top-rated Operators play marquee tables; spectated → clips |
| **Season Finale** | season end | Grand Operator decided; max attendance |

Rituals double as content: Council Hour and the Finale are the most clip-worthy, feeding the spectator/clip loop (`../03_virality_network_effects/spectator_and_clip_engine.md`). "Be there when it's full" is both a liquidity fix and a habit.

## Re-engagement & notification strategy

Notifications are **status and obligation signals**, not nags. Every push names a real, time-sensitive stake. Voice is terse and premium (`../00_foundation/positioning_and_brand.md`). We cap volume hard — a premium brand does not spam.

| Trigger | When it fires | Example copy |
|---------|---------------|--------------|
| **Rank threatened** | a rival closes within striking distance / decay looms | `Your Council seat is under fire. Rivera is 40 points behind and climbing. Defend it tonight.` |
| **Chamber needs you** | your Chamber is short for Chamber Night / contesting a result | `The Chamber is one Operator short for tonight's table. They're counting on your hand.` |
| **Council movement** | the board shifts near you / a dethroning | `The Council updated. You're now #97 — one seat from the edge.` |
| **Season ending** | final 72h / 24h of a season | `48 hours left in the season. You're 2 seats from The Council. This is the climb.` |
| **House activity** | your House has live tables / unclaimed share | `Your House is live — 3 seats open at the table you founded.` |
| **Comeback** | lapsed 7–14d | `A seat's been kept for you, Operator. The new season is open and the board is fresh.` |

**Volume cap:** ≤ ~1 high-signal push/day, ≤ ~4/week. Suppress anything that doesn't reference a real stake. The goal is that every notification, when it lands, is *true and consequential* — so Operators keep them on.

## Comeback hooks (winning back lapsed Operators)

- **Season reset is the natural re-entry** — a fresh board means a returning Operator isn't hopelessly behind. Re-engagement pushes cluster at season start.
- **Their House/Chamber pulls them back** — a teammate-/founder-initiated "we need you" is the highest-converting comeback (social debt). We surface a one-tap "rejoin your House's next table."
- **"Your legend persists"** — lifetime stats, signature reveals, and prior Council appearances survive resets, so returning feels like reclaiming a throne, not starting over.
- **Practice re-entry** — lapsed Operators can re-find the table feel in no-stakes mode before re-committing USDC (lowers re-activation friction; see `onboarding_and_aha_moment.md`).

## Retention targets

| Metric | Definition | Target |
|--------|------------|--------|
| **D1** | activated Operators returning next day | **≥ 40%** |
| **D7** | returning within 7 days | **≥ 25%** |
| **W4** | active in week 4 post-activation | **≥ 20%** (this is the flywheel-health gate) |
| **Chamber-attach lift** | W4 retention of Chamber members vs. non-members | **≥ +15pp** |
| **Council/near-Council retention** | W4 for top-rated Operators | **≥ 60%** |
| **Notification opt-out rate** | Operators disabling pushes | **< 10%** (proxy for signal quality) |
| **Ritual attendance** | active Operators hitting ≥1 ritual/week | **≥ 50%** |

**The one we obsess over: W4.** It is the truest read of whether status + Chambers + seasons retain a real base. W4 is also the multiplicand for K — virality investment only pays if W4 holds (`../00_foundation/growth_model_and_flywheel.md`).

## Why this ties to the loops

- Rank-to-defend + Council refresh feed the **Status / Council loop** (aspiration → play → recruit).
- Chamber dependence + Chamber Night feed the **Chamber / team loop** (retention × recruiting).
- Rituals + the season finale feed the **Clip loop** (marquee moments become shareable artifacts).
- Comeback-via-House feeds the **House referral loop** (teammates re-pull lapsed Operators).

Retention isn't a silo — it is the base the viral loops multiply.

## Cross-references

- The flywheel & growth equation: `../00_foundation/growth_model_and_flywheel.md`
- Status ladder & scarcity that powers defense: `../00_foundation/lexicon_and_status_system.md`
- Anti-casino voice for notifications/streaks: `../00_foundation/positioning_and_brand.md`
- The activation moment that feeds this engine: `onboarding_and_aha_moment.md`
- Rating, decay, and the climb: `progression_and_ranks.md`
- Chambers as team retention: `../03_virality_network_effects/chambers_and_houses.md`
- Rituals, seasons & coronations: `../04_community/rituals_events_and_seasons.md`
- Reward layer (points/token): `../05_economy_incentives/incentive_and_anti_sybil_design.md`
- Targets in context: `../07_growth_ops_metrics/north_star_and_kpis.md`
