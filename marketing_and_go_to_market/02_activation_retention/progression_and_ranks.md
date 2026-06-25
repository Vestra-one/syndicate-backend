# Progression & Ranks

The Operator → The Council → Grand Operator climb is not cosmetic XP — it is **the product surface where retention and virality are the same system**. A visible, earned, non-buyable rank is simultaneously the reason an Operator stays (rank to defend) and the reason they recruit (rank is only legible relative to others). This doc specs progression as a product-and-growth machine: a rating that honors skill, a status ladder with scarcity, and a designed growth EVENT on every rung of the spine.

> Status is the retention engine and the referral engine at once. Build the ladder right and it does our acquisition for free (`../00_foundation/lexicon_and_status_system.md`).

## The progression spine (each arrow is a growth event)

```
First seat (Operator)
   → join / found a House      (invite loop fires — K-factor)
   → join a Chamber             (team retention)
   → climb season rating        (skill + volume)
   → enter The Council (top 100)(public elite — broadcastable)
   → crowned Grand Operator     (apex — lore)
```

Every arrow has a **trigger → reward → shareable artifact**. Progression that doesn't emit a shareable artifact is a missed acquisition event.

## A skill-over-volume rating (poker-style, anti-pay-to-win)

The rating must reward *how well you play your conviction and read the table*, not how much USDC you push. This protects the skill brand (`../00_foundation/positioning_and_brand.md`) and keeps the ladder worth chasing.

**Design principles:**

1. **Skill-expressive, variance-aware.** Single matches are high-variance by design (poker). Rating is an **Elo/Glicko-style** measure that updates on *outcome relative to expectation given the field*, so beating stronger tables moves you more, and one lucky pot doesn't crown anyone. Skill emerges over volume.
2. **Stakes ≠ rank.** Higher tiers earn bigger *pots*, not *rating shortcuts*. A whale gets a bigger table, not a bought Council seat. Rating per match is **stake-normalized** so a small-stakes sharp can out-rank a high-roller.
3. **Volume gates legitimacy, doesn't buy it.** A minimum hand count per season qualifies you for the board (anti-luck), but past the floor, *quality of play* drives rank — grinding volume alone plateaus.
4. **Contribution counts.** Founding active Houses and growing a winning Chamber feed a contribution component — so the ladder rewards the recruiting/community behavior that grows the network, not just solo play.
5. **Anti-sybil / proof-of-personhood** underwrites the whole board so farmed accounts can't manufacture rank (`../05_economy_incentives/incentive_and_anti_sybil_design.md`). A buyable/farmable ladder is worthless; integrity *is* the prestige.

Illustrative rating delta (conceptual, not final tuning):

```
Δrating = K · (S_actual − S_expected) · stake_norm · field_strength
   S_expected = logistic(your_rating − table_avg_rating)
   stake_norm  = dampens raw USDC so skill > size
   field_strength = beating a strong table pays more
```

## The status ladder & its rewards

| Rung | Trigger to reach | Reward | Shareable artifact |
|------|------------------|--------|--------------------|
| **Operator** | first real contested reveal | public profile, on-chain identity, base insignia | Operator profile card (`onboarding_and_aha_moment.md`) |
| **House founder/member** | found or join a House | private tables, founder points/rev share, House page | "Join my House" Blink card (`../03_virality_network_effects/viral_loops_and_referrals.md`) |
| **Chamber member** | join a Chamber | collective board, Chamber rituals, team identity | Chamber crest + standing card |
| **Ranked Operator** | qualify on the season board | tier insignia, rating, signature-reveal reel | season rank card with rating + best hand |
| **The Council** | finish a season in top 100 | Council insignia, priority access, governance voice, points/rev multipliers | Council induction card ("You entered The Council") |
| **Grand Operator** | #1 (or apex tier) at season end | crown, hall of champions, featured/interviewed, max multipliers | Coronation card + ceremony clip |

Scarcity is load-bearing: **100** Council seats, **one** Grand Operator. Participation trophies destroy status; contested scarcity manufactures it.

## Badges & insignia (the credential layer)

Insignia are **wearable, screenshot-native proof** that render on the profile, leaderboards, Blinks, and shareable cards — so status is visible everywhere (the precondition for flexing).

- **Rank insignia:** tier marks, Council seal, Grand Operator crown.
- **Achievement insignia:** *Cold Read* (won from behind on the reveal), *Iron Nerve* (held conviction through pressure), *Founder* (House with N active Operators), *Season Veteran* (active-week streak).
- **Lore insignia:** prior Council appearances, past Grand Operator titles — **persist across season resets** so identity compounds even as ratings soft-reset (`retention_engine.md`).

Design bar: every insignia is a luxury object (gold/serif/mono authority, `../00_foundation/positioning_and_brand.md`), never a cartoon sticker.

## The designed growth EVENT for each arrow

Each progression arrow is instrumented as a discrete event with notification, reward, and an auto-generated shareable.

### 1. First seat → Operator
- **Trigger:** first contested reveal completes.
- **Reward:** Operator profile minted, base insignia, first rating placement.
- **Artifact:** Operator card + first reveal clip → seeds the Clip loop on session one.
- **Notification:** `You're an Operator now. Your profile is live. Operators don't sit alone — join a House.`

### 2. Operator → House (invite loop fires)
- **Trigger:** founds or joins a House.
- **Reward:** founder points/rev share or member access to private tables.
- **Artifact:** **"Join my House" Blink** — one-tap on-chain invite embedded in a tweet (the K-factor engine, `../03_virality_network_effects/viral_loops_and_referrals.md`).
- **Notification:** `Your House is open. Bring Operators — fill your table, grow your share.`

### 3. House → Chamber (team retention)
- **Trigger:** joins a Chamber.
- **Reward:** team identity, Chamber-board standing, Chamber Night eligibility.
- **Artifact:** Chamber crest card; teammate "X joined the Chamber" feed post.
- **Notification:** `You play for a side now. The Chamber rises and falls with your hands.`

### 4. Climb season rating
- **Trigger:** crossing tier thresholds / personal-best rating.
- **Reward:** tier insignia upgrade, bigger-table eligibility.
- **Artifact:** rank-up card (rating + signature reveal) — recurring flex fuel.
- **Notification:** `Tier up. Your rating just cracked [X]. The Council is [N] seats away.`

### 5. Enter The Council (the broadcast moment)
- **Trigger:** finish a season top 100.
- **Reward:** Council insignia, priority access, governance voice, multipliers.
- **Artifact:** **Council induction card** — the single most aspirational shareable; the leaderboard itself is a recruiting poster.
- **Notification:** `You entered The Council. Top 100 on Solana's financial sport. The board knows your name.`
- **Growth role:** drives the **Status / Council loop** — spectators see the induction and aspire (`../00_foundation/growth_model_and_flywheel.md`).

### 6. Crowned Grand Operator (the mythology)
- **Trigger:** apex at season end.
- **Reward:** crown, hall of champions, feature/interview, max multipliers.
- **Artifact:** **Coronation ceremony clip** — a marquee, broadcastable event (`../04_community/rituals_events_and_seasons.md`).
- **Notification (to the field):** `The season is decided. A new Grand Operator has been crowned. Witness the reveal.`
- **Growth role:** the lore north star — every Operator's chase, every season's headline.

## Season cadence (progression's clock)

- **~6–8 week seasons** with a **soft reset**: ratings compress toward the mean; **insignia, lifetime stats, and lore persist** (see `retention_engine.md` for the retention mechanics of resets).
- Each season produces a **fresh Council** and **one Grand Operator** — recurring, datable content beats (CT knows when the headline drops).
- **Pre-season placement** + **House drafts** bridge seasons so the climb never goes cold.

## How progression feeds the Status loop and the Clip loop

- **Status / Council loop:** visible rank → desire to climb → more play + recruiting (rank is relative) → Council inductions are broadcastable → spectators aspire → new Operators. Scarcity keeps the chase permanent.
- **Clip loop:** every rung emits a beautiful shareable (rank-up card, Council induction, coronation). The Clip Engine turns these into CT-native artifacts the Operator *wants* to post (`../03_virality_network_effects/spectator_and_clip_engine.md`). Progression is a *content generator* as much as a retention system.

Together: progression makes Operators stay (defend rank), recruit (legibility), and broadcast (artifacts) — the three jobs of every growth asset, in one system.

## Cross-references

- Status civilization & lexicon: `../00_foundation/lexicon_and_status_system.md`
- Skill positioning & insignia design language: `../00_foundation/positioning_and_brand.md`
- Flywheel & loop roles: `../00_foundation/growth_model_and_flywheel.md`
- The aha that mints the first Operator: `onboarding_and_aha_moment.md`
- Rank-to-defend, decay, season-reset retention: `retention_engine.md`
- House invite loop (arrow 2): `../03_virality_network_effects/viral_loops_and_referrals.md`
- Chambers & Houses network effects (arrows 2–3): `../03_virality_network_effects/chambers_and_houses.md`
- Council/coronation rituals: `../04_community/rituals_events_and_seasons.md`
- Anti-sybil / anti-pay-to-win underwriting the rating: `../05_economy_incentives/incentive_and_anti_sybil_design.md`
