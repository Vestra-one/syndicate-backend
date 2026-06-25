# Community Architecture — the status civilization, made navigable

The community is not a Discord with a game attached. It is **the same status civilization the app runs on, projected onto social surfaces**. Every space, role, and ritual must map 1:1 to an in-app concept — Operator, Chamber, House, The Council, Grand Operator — so that climbing the community ladder *is* climbing the in-app ladder. There is one world, two viewports (the app and the social layer), never two parallel worlds. See `../00_foundation/lexicon_and_status_system.md`.

## Design principle: spaces mirror the ladder

| In-app concept | Discord surface | Telegram surface | On-chain surface |
|----------------|-----------------|------------------|------------------|
| **Syndicate** (institution) | the server itself | the announcements channel | the registry program |
| **Operator** (identity) | wallet-verified member + auto-roles | verified member | wallet-bound Operator profile |
| **Chamber** (team) | a Chamber category + private channels | Chamber group/topic | Chamber standing on-chain |
| **House** (invite crew) | founder-owned private channel | founder's House group | House page + rev/points share |
| **The Council** (top 100) | gated `#council-floor` + insignia role | Council-only group | publicly ranked, on-chain |
| **Grand Operator** (apex) | crowned role + dedicated lore channel | pinned across surfaces | hall-of-champions record |

If a community space cannot be traced back to a row in this table, it does not get built. Channels are not topics — they are **territory tied to standing**.

## Roles, and exactly how you earn them

Roles are **synced from on-chain state, never hand-assigned**. A bot reads the wallet-bound Operator profile and grants Discord/Telegram roles automatically. This is the anti-shill, anti-LARP firewall: you cannot talk your way into a rank, you play your way in.

| Role | Earned by | Confers | Visible as |
|------|-----------|---------|------------|
| **Operator** | first verified seat (real match) | server access, profile sync, clip-posting | base insignia, rank flair |
| **Seated Operator** | active this season (≥ N hands) | ranked-channel access, event entry | season flair |
| **House Founder** | founding a House (fills tables) | founder channel, House role for members | House crest |
| **Chamber Officer** | leadership seat in a ranked Chamber | Chamber channel admin, draft tools | Chamber color + officer mark |
| **The Council** | top 100 season rating | `#council-floor`, governance vote, priority access | Council insignia (auto-revoked on dethroning) |
| **Grand Operator** | season #1 / apex tier | own lore channel, ceremonial powers, the crown | the crown, pinned everywhere |

**Key mechanic — roles decay.** Council and Seated roles are recomputed every sync against live standings. Drop out of the top 100, lose the insignia the same day. The drama of *losing* a role is as much content as earning it, and it keeps the ladder honest (`./the_council_and_grand_operator.md`).

## Channel & space architecture (Discord)

```
SYNDICATE
├─ THE GATE (public, pre-verification)
│   ├─ #the-doors          ← wallet-verify to enter (Blink-powered)
│   ├─ #the-pitch          ← what Syndicate is; read-only
│   └─ #seat-requests      ← onboarding to first match
├─ THE FLOOR (verified Operators)
│   ├─ #operators-lounge   ← general; premium tone enforced
│   ├─ #live-tables        ← match alerts, "a seat opened" pings
│   ├─ #the-reveal-room    ← auto-posted reveal clips (Clip Engine)
│   ├─ #leaderboards       ← bot-posted standings, Council deltas
│   └─ #strategy           ← honest skill talk, hand reviews
├─ CHAMBERS (one category per ranked Chamber)
│   ├─ #<chamber>-war-room  ← members only
│   └─ #<chamber>-recruit   ← drafting strong Operators
├─ HOUSES (founder-owned, invite-only)
│   └─ #<house>             ← private tables, House chatter
├─ THE COUNCIL (top 100 only)
│   ├─ #council-floor       ← elite discourse
│   ├─ #governance          ← proposals, signal votes
│   └─ #summit              ← IRL/virtual event coordination
└─ THE THRONE
    └─ #hall-of-champions   ← Grand Operator lore, every past crown
```

Telegram mirrors this with a leaner footprint: a broadcast-only **announcements** channel (the institution's voice), an **Operators** group (the Floor), per-Chamber and per-House groups, and a gated **Council** group. CT (`X`) is the *public theater* — where Council deltas, coronations, and reveal clips are performed for non-members as recruiting (`../03_virality_network_effects/spectator_and_clip_engine.md`).

## On-chain Operator profile as the identity primitive

The Operator profile is **wallet-bound and is the source of truth** for everything above. It carries: rank, season rating, lifetime hands, Chamber affiliation, Houses founded/joined, badges, signature reveals, and Council/Grand Operator history. Properties that make it a growth asset:

- **Screenshot-native:** rendered as a luxury card, shareable in one tap — a rank flex is free advertising.
- **Non-portable reputation:** a whale can move USDC anywhere; they cannot move a Council seat or a Chamber legend. This is the moat.
- **Composable:** partners, Blinks, and future token/NFT access read the same profile, so status follows the Operator across the ecosystem (`../06_ecosystem_distribution/`).
- **Proof-of-personhood gated:** one human, one Operator identity — defends the ladder from sybil farming (`../05_economy_incentives/incentive_and_anti_sybil_design.md`).

Verification flow uses a **Blink**: `#the-doors` posts a one-tap Action; the Operator signs; the bot reads the profile and grants roles. No forms, no manual review — Solana-native onboarding.

## Light governance — the Council's voice (not its hands)

Governance is a **prestige perk, not a DAO**. The Council gets *voice*, the house keeps *operational control* — deliberately, to protect the premium product from governance capture.

- **Signal votes** in `#governance` on map/asset rotation, event formats, exhibition matchups, ceremony themes. Binding only where pre-declared; advisory elsewhere.
- **Council Proposal Window:** once per season, the Council can put forward up to N proposals; the house commits to shipping or publicly answering each.
- **Veto-by-prestige:** if a supermajority of the Council flags an integrity concern (e.g., a suspected exploit), it auto-escalates to a freeze review.

This makes a Council seat *consequential*, which raises its aspirational value — feeding the Status/Council loop (`../00_foundation/growth_model_and_flywheel.md`).

## Moderation & culture guardrails (premium tone is a product feature)

The brand is **Royal × Institutional × Elite × Premium** (`../00_foundation/positioning_and_brand.md`). The community must read like a private bank's members' floor, not a degen casino chat. Enforced, not hoped for:

- **Anti-shill firewall:** no price-prediction spam, no "wen 100x," no referral coupons in chat. Status is the only flex; rank cards are the only brag. Violations are removed on sight.
- **No casino/meme language** from official accounts or moderators. We say *"a seat opened," "Sealed. The market will decide," "The Council updated"* — never *"jackpot," "degen," "ape in."*
- **Integrity above all:** collusion, multi-accounting, and ladder-farming are bannable and revoke on-chain standing. Integrity is the foundation of provable fairness — the brand collapses without it.
- **Restraint as flex:** moderators model low-emoji, high-gravity tone. The room that *doesn't* shill reads as the premium one on CT.
- **Moderators are Operators first** — drawn from respected Seated Operators and Chamber Officers, given a "Steward" mark. Culture is enforced by peers with standing, not anonymous admins.

### Culture covenant (pinned in `#operators-lounge`)
> This is a table of Operators. We flex rank, not bags. We out-play, we don't out-shill. We respect the seal, the table, and each other. Status here is earned and visible — and it can be lost. Sit accordingly.

## The Operator-bot — the nervous system

A single service bot (Discord + Telegram + on-chain reader) is the connective tissue that keeps the social layer welded to the app. It is read-mostly: it *reflects* on-chain truth, it does not *grant* status.

| Function | Trigger | Behavior |
|----------|---------|----------|
| **Verify** | `/verify` Blink in `#the-doors` | reads wallet, mints Operator role, posts welcome to `#operators-lounge` |
| **Sync** | every N minutes + on match settlement | recomputes Council/Seated/House/Chamber roles from on-chain state |
| **Announce** | Council delta, dethroning, coronation | posts the standing-change card to `#leaderboards` / CT |
| **Clip relay** | match reveal | pushes the auto-generated reveal card to `#the-reveal-room` |
| **Decay** | sync detects rank drop | revokes Council/Seated insignia, posts the dethroning |

Because the bot is the *only* path to roles, there is no manual back-door — which is what makes the insignia trustworthy. A role on the server is a cryptographic claim about on-chain standing, not an admin's favor.

## Pre-verification: the Gate as a filter, not a funnel

Most communities optimize the top of funnel for raw volume. Syndicate optimizes for **the right Operator**. `THE GATE` is intentionally a *threshold experience*: `#the-pitch` states what Syndicate is in institutional, honest-skill language; `#the-doors` requires a wallet verification (and, at scale, proof-of-personhood) before the Floor opens. The friction is the brand — admission should *feel* earned. Lottery-ticket churners self-select out; competitors who respect a fair game lean in (`../00_foundation/positioning_and_brand.md`).

## Anti-patterns we explicitly refuse

The premium frame dies by a thousand Web2 defaults. Banned by design:

- **No "general chat" sprawl.** Channels are territory tied to standing; we do not create off-topic, GM, or shitpost channels that dilute the institution's voice.
- **No buyable roles or vanity tiers.** Every role syncs from earned on-chain state. Nitro-boost cosmetics, paid color roles, and "OG" giveaways are forbidden — they counterfeit status.
- **No referral coupons in chat.** Recruiting happens through Houses and Chambers with on-chain attribution, not "use my code for 10% off."
- **No parallel currencies of clout.** Reaction-role leveling bots, XP-from-messages, and "active chatter" ranks are banned — the only ladder is the in-app ladder.
- **No mod cabal.** Stewards are Operators with standing; moderation authority is downstream of rank, not of being early or loud.

## How the community reinforces the in-app ladder

Every community surface exists to make the in-app status ladder **more visible, more contested, and more aspirational** — never to create a separate progression:

- **Leaderboard channels** turn private rank into public theater → flexing → recruiting.
- **Chamber categories** turn solo play into team obligation → retention (`./ambassador_and_chamber_program.md`).
- **House channels** give founders a room to fill → selfish referral → K-factor (`../03_virality_network_effects/chambers_and_houses.md`).
- **`#council-floor` + coronations** make the summit feel real and worth the climb → aspiration content (`./the_council_and_grand_operator.md`).
- **Rituals & seasons** convert all of the above into a habit calendar with shareable artifacts (`./rituals_events_and_seasons.md`).

The test for any new channel, role, or bot: *does it make an in-app rank more legible, more defendable, or more desirable?* If not, it doesn't ship.
