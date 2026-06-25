# Ambassador & Chamber Program — the decentralized growth org

Syndicate has **no traditional ambassador program**, because Chambers already are one — better. A Web2 ambassador program pays flat stipends for posts nobody believes. A **Chamber** is a competitive team with public, on-chain standing whose members evangelize *to win*, not to collect a check. We do not bolt a marketing function onto the community; we make growth a **byproduct of the competition itself** (`../00_foundation/lexicon_and_status_system.md`, `../00_foundation/growth_model_and_flywheel.md`).

## The core insight: recruiting is a competitive act

A Chamber's standing rises with the **collective performance of its Operators**. To climb the Chamber leaderboard, a Chamber must field more and stronger Operators. Therefore:

- A Chamber Leader recruiting talent is not "doing marketing" — they are **drafting to win**.
- A member who brings a sharp friend into their Chamber is **strengthening their own team's standing**.
- Chamber-vs-Chamber Wars give recruiting *stakes and a scoreboard* (`./rituals_events_and_seasons.md`).

This is the whole trick: align self-interested competition with acquisition, and the growth org runs itself. Members evangelize because winning requires it.

## Standing up official Chambers

We seed the network with a tiered Chamber framework, then let it go decentralized.

| Chamber type | Seeded by | Purpose | Example |
|--------------|-----------|---------|---------|
| **Flagship Chambers** | house-founded, marquee | anchor culture, set the bar, house the early elite | "The First Table" |
| **Regional Chambers** | recruited regional leaders | own a geography's Operators | Chamber SEA, Chamber LATAM |
| **Language Chambers** | native-speaker leaders | localize culture + onboarding | Chamber 中文, Chamber Türkçe, Chamber Español |
| **KOL Chambers** | KOL-Operators | a creator's audience becomes their Chamber | (see `../01_acquisition/kol_and_creator_program.md`) |
| **Open Chambers** | any qualified Operator | bottom-up team formation | Operator-founded |

**Official status is earned, not granted.** A Chamber becomes "Official" (verified crest, recruiting tools, war eligibility, leader incentives) by clearing thresholds: a minimum of Seated Operators, a minimum collective rating, and a clean integrity record. This keeps the official tier scarce and prestigious — and prevents farmed shell Chambers.

### Standup checklist for a new official Chamber
```
1. Leader verifies as an Operator (wallet-bound profile, real seats played)
2. Charters the Chamber: name, crest, region/language, recruiting thesis
3. Recruits to threshold (min Seated Operators + min collective rating)
4. Passes integrity screen (anti-sybil, no multi-account roster padding)
5. Granted Official crest + Chamber category in Discord/TG + recruiting tools
6. Enters the Chamber leaderboard and War eligibility
```

## Chamber-leader incentives — tied to growth AND standing (never flat pay)

Flat pay rewards activity; we reward **outcomes that compound for Syndicate**. A Chamber Leader earns from a blend, all of it *earned, visible, and non-buyable* (`../05_economy_incentives/`):

| Lever | Rewards | Why it's right |
|-------|---------|----------------|
| **Chamber standing** | leaderboard rank + season-end Chamber prize pool | pays *winning*, not posting |
| **Active roster growth** | points scaled by **retained, active** Operators recruited | pays real members, not vanity sign-ups |
| **War performance** | trophies + points for Chamber War results | pays competitive output |
| **Member elevation** | bonus when a Chamber member enters The Council | aligns leaders with developing talent, not just volume |
| **Leader standing** | Chamber Officer insignia; path to personal Council seat | leaders are Operators first — they must also *play* |

**Anti-gaming guardrails (non-negotiable):**
- Rewards key off **retained, active, proof-of-personhood-verified** Operators — sybils and dormant invitees pay nothing (`../05_economy_incentives/incentive_and_anti_sybil_design.md`).
- No bounty per raw signup (that breeds spam and farms). Growth rewards are *standing-weighted*, so a Chamber is paid for fielding Operators who actually compete.
- Integrity violations (collusion, roster padding, multi-accounting) **revoke standing and incentives** and can de-Official a Chamber. Integrity is the brand.

This is why the model beats flat ambassador pay: a Chamber Leader's upside is **uncapped and tied to building a real competitive org**, which is exactly the growth we want — not a stipend for tweets.

## Chamber Leader tiers (a ladder inside the ladder)

Leaders themselves climb a visible standing, so leading a Chamber is its own status game — which keeps the best operators *running* Chambers rather than just playing in them.

| Leader tier | Reached by | Unlocks |
|-------------|-----------|---------|
| **Founder** | charter + clear the official threshold | crest, recruit channel, Blink draft tools |
| **Officer** | sustained roster + clean integrity | War scheduling, draft-window priority, member-elevation bonuses |
| **Warden** | top-N Chamber standing for a season | season prize-pool share, exhibition seeding rights, co-creation input |
| **Architect** | multi-season top Chamber + Council-grade play | governance voice, flagship status, brand spotlight |

A Warden or Architect is a public figure in the Syndicate world — which is the point: we want leading a winning Chamber to confer the kind of status that money cannot buy and that compounds the harder they recruit and win.

## Chamber economics (worked example)

The model rewards *retained competitive output*, not headcount. Illustrative shape (numbers tuned in `../05_economy_incentives/`):

```
Chamber season score =
    Σ(member season ratings, skill-weighted)
  + War-result points
  + (retained-active-Operator growth × decay-adjusted weight)
  − integrity penalties (sybil/padding/collusion)

Leader reward pool ∝ Chamber season score  (capped, standing-weighted)
Member-elevation bonus: flat grant when a member enters The Council
```

Why this shape: a Chamber that signs 500 dormant wallets scores ~0 (decay + anti-sybil zero them out); a Chamber that fields 40 Operators who *play, retain, and win Wars* scores high. We are paying for a real competitive org, which is precisely the growth Syndicate wants — and it is un-farmable because the reward keys off the same on-chain, proof-of-personhood-gated standing that the whole ladder runs on (`../05_economy_incentives/incentive_and_anti_sybil_design.md`).

## The localization play (Chambers as native beachheads)

Regional and Language Chambers are how Syndicate enters a new market **without spending on local marketing**. A native-speaker Warden:

- Translates onboarding and culture into the local idiom (while keeping the lexicon as untranslated proper nouns — Operator, Chamber, House stay capitalized and intact).
- Runs the local-hours Weekly Open and a localized recruit channel.
- Becomes the trusted local face — far more credible to that market than the central brand.

Each Language Chamber is a self-funding beachhead: the Warden's incentive to grow standing *is* the market-entry budget. This stacks directly with regional KOL-Operators (`../01_acquisition/kol_and_creator_program.md`).

## Recruiting mechanics (Solana-native)

- **Blink-powered "Join my Chamber" Actions:** a one-tap on-chain join posted in a tweet or DM — drafting becomes frictionless and trackable (`../03_virality_network_effects/chambers_and_houses.md`).
- **Recruit channels:** each Official Chamber gets a `#<chamber>-recruit` space; the Floor's `#leaderboards` advertises who's climbing and draftable (`./community_architecture.md`).
- **Draft windows:** at season open, free-agent Operators are visible and courtable — leaders compete to sign rising talent, generating CT recruiting theater.
- **Chambers ⊃ Houses:** a Chamber Leader (or members) can found Houses *within* the Chamber, stacking the K-factor invite loop on top of team recruiting — selfish referral nested inside team competition.

## Chamber rituals (the internal habit + the external artifact)

Rituals make a Chamber feel like an order and emit content (`./rituals_events_and_seasons.md`):

- **Chamber War (weekly/bi-weekly):** the headline ritual — scheduled head-to-head vs a rival Chamber; result moves both standings; emits a war scoreboard + decisive-hand clip.
- **Draft Day (season open):** leaders announce signings; rosters revealed; storylines and rivalries seeded — pure CT content.
- **War Room reviews:** members study hands together — turns retention into a *team practice habit* and develops the talent that wins wars.
- **Chamber colors & crest:** every member's profile and rank card carries Chamber identity, so each individual flex doubles as Chamber advertising.
- **Season banner:** the season-end Chamber standing is a permanent badge — a recruiting poster for next season.

## How Chambers become the decentralized growth org

```
Chamber wants to climb
   → must field more & stronger Operators
   → Leader + members recruit (to win, not for pay)
   → recruits play, retain, post rank flexes
   → Chamber standing rises → War wins → more visibility
   → more Operators want to join a winning Chamber
   → the network grows itself, no central marketing spend
```

Each loop turn is **self-interested competition producing acquisition + retention + content** at once:
- **Acquisition:** recruiting is a competitive necessity; every member is a scout.
- **Retention:** social obligation to a team you'd let down by churning — the stickiest lever (`../00_foundation/growth_model_and_flywheel.md`).
- **Virality:** Chamber pride and Chamber colors make every member a billboard; Wars and Draft Days are recurring CT theater.

## Ties to the rest of the program

- **KOLs run KOL Chambers** — a creator's audience becomes their team; their reach becomes recruiting; their standing compounds when the audience plays. Full creator economics: `../01_acquisition/kol_and_creator_program.md`.
- **Incentive design & anti-sybil** govern every reward lever so growth is earned and farm-resistant: `../05_economy_incentives/` and `../05_economy_incentives/incentive_and_anti_sybil_design.md`.
- **Houses** nest inside Chambers as the personal K-factor invite loop: `../03_virality_network_effects/chambers_and_houses.md`.
- **Rituals & seasons** give Chambers their war calendar and Draft Days: `./rituals_events_and_seasons.md`.
- **Community architecture** provides the channel territory each Chamber occupies: `./community_architecture.md`.

The test for any Chamber-program decision: *does it make recruiting a path to winning, and does it pay retained competitive Operators rather than raw signups?* If a lever can be farmed or rewards posting over winning, it corrupts the org — cut it.
