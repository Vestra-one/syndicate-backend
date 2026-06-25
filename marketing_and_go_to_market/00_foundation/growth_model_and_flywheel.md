# Growth Model & Master Flywheel

The strategy is a **compounding loop**, not a funnel. We optimize in the canonical order — **PMF → Retention → Virality → Community → Ecosystem Dominance** — because each stage is the fuel for the next. Virality before retention burns the brand; community before virality has no one to organize.

## The master flywheel

```
                ┌──────────────────────────────────────────────┐
                │                                              │
                ▼                                              │
        ┌───────────────┐                                      │
        │   ACQUIRE      │  CT drama · KOL-Operators · Blinks ·  │
        │                │  partner rails · points gravity      │
        └──────┬─────────┘                                      │
               ▼                                                │
        ┌───────────────┐                                      │
        │   ACTIVATE     │  practice mode → first SEALED-REVEAL  │
        │  (the "aha")   │  in < a few minutes                   │
        └──────┬─────────┘                                      │
               ▼                                                │
        ┌───────────────┐                                      │
        │   RETAIN       │  ranks to defend · seasons ·          │
        │                │  Chambers (team) · daily ritual       │
        └──────┬─────────┘                                      │
               ▼                                                │
        ┌───────────────┐                                      │
        │ REFER / VIRAL  │  Houses (K-factor) · Clip Engine ·    │
        │                │  status flexing · Council movements   │
        └──────┬─────────┘                                      │
               ▼                                                │
        ┌───────────────┐                                      │
        │  COMMUNITY     │  Council prestige · rituals ·         │
        │                │  Grand Operator lore · Chambers       │
        └──────┬─────────┘                                      │
               ▼                                                │
        ┌───────────────┐                                      │
        │  ECOSYSTEM     │  partner integrations · points/token  │
        │  GRAVITY       │  · distribution arbitrage             │
        └──────┬─────────┘                                      │
               └───────────────── compounds back into ─────────┘
```

**Why it compounds:** each loop turn deposits a durable asset — more clips in the wild, more Council storylines, more Houses recruiting, more partner surface, more points/token gravity. The cost to acquire the *next* Operator falls every turn because status, content, and speculation do the selling.

## The growth equation

```
Operators(t+1) = Operators(t) × (Retention × K) + Paid/Partner acquisition
```

- **Retention** is the floor — it's why we sequence PMF/retention first. Status (rank to defend) + Chambers (social obligation) + seasons (fresh goals) are the retention levers.
- **K (viral coefficient)** = invites sent per Operator × conversion per invite. We engineer K > 1 via **selfish referral** (Houses *need* members; founders share upside) and **status referral** (your rank only means something relative to people you bring).
- **Paid/Partner** is a *catalyst*, never the engine — used to seed loops, not to rent users.

## The seven engineered loops

Each is a self-reinforcing cycle with a trigger → action → reward → re-trigger.

### 1. Content / Clip Loop (the flagship)
Match produces a dramatic reveal → auto-generated beautiful clip/card → Operator posts it for status → viewers want the same moment → new Operators → more matches. **This is our cheapest, highest-volume acquisition.** (`03_virality_network_effects/spectator_and_clip_engine.md`)

### 2. Referral / House Loop (K-factor)
Operator founds a **House** → House needs Operators to fill tables (and founder shares House activity/points) → founder recruits → recruits found their own Houses. Selfish, social, status-bearing — not a coupon. (`03.../chambers_and_houses.md`)

### 3. Status / Council Loop (aspiration)
Visible rank → desire to climb → more play + recruiting to climb → entering **The Council** is broadcastable → spectators aspire → new Operators. Scarcity (top 100, one Grand Operator) keeps the chase permanent. (`02_activation_retention/progression_and_ranks.md`)

### 4. Chamber / Team Loop (retention × recruiting)
Join a **Chamber** → collective standing → social obligation retains you → Chambers recruit to win → members evangelize. Turns solo churn into team stickiness. (`04_community/`)

### 5. Speculation / Points Loop (mercenary energy → free marketing)
Season 0 points + token path → speculators farm by *playing and retaining* (designed that way) → they shill to pump their own stake → attention → Operators. Channels mercenary capital productively. (`05_economy_incentives/`)

### 6. KOL-as-Operator Loop (leverage)
KOL gets a House + Council fast-lane + upside → KOL's status compounds when audience plays → KOL recruits their audience → audience produces clips → more KOLs want in. (`01_acquisition/kol_and_creator_program.md`)

### 7. Ecosystem / Distribution Loop (rails)
Integrate where Solana users already are (wallets, perps, oracles, Blinks/Actions, quests) → partners surface Syndicate to their users → those users bring clips/Houses → Syndicate's audience becomes worth partnering with → more partners. (`06_ecosystem_distribution/`)

## "Every user a distribution channel" — the concrete mechanisms

| Mechanism | How the Operator distributes | Surface |
|-----------|------------------------------|---------|
| Clip Engine | posts their dramatic hand (wants to, for status) | CT, TG |
| House founding | recruits to fill their table / earn House share | invite links, Blinks |
| Rank flex | shares profile/Council card | profiles, leaderboards |
| Chamber recruiting | drafts strong Operators to win | Discord, CT |
| Referral Blinks | one-tap on-chain "join my House" Action in a tweet | Solana Blinks |
| Coronations | Grand Operator/Council ceremonies are shared | streams, threads |

Every one of these is a *default behavior driven by self-interest or status* — not an ask. That is the definition of a distribution channel that scales for free.

## Sequencing the loops (don't light them all at once)

- **Phase 0–1:** PMF + Retention + Clip Loop + KOL-as-Operator (seed culture, prove the reveal sells).
- **Phase 1–2:** House + Status/Council + Chamber loops (turn retained players into recruiters and teams).
- **Phase 2–3:** Speculation/Points + Ecosystem loops at full power (scale + token gravity once retention is proven, so speculation lands on a real product, not vaporware).

(Phase detail in `08_roadmap/phased_gtm_roadmap.md`.)

## The single number that tells us it's working

**Weekly Active Operators who reach a contested reveal**, plus **K-factor** and **W4 retention**. If those three rise together, the flywheel is spinning. Full metric tree: `07_growth_ops_metrics/north_star_and_kpis.md`.
