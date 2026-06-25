# Token Strategy & Airdrop

A token is the **highest-amplitude growth lever and the highest-risk one** on Solana. Done right, it converts Season 0's banked conviction into a permanent ecosystem-gravity engine. Done wrong, it floods Syndicate with mercenary capital that farms, dumps, and leaves — and worse, it can make rank look buyable and detonate the premium, skill-status brand we exist to protect (`../00_foundation/positioning_and_brand.md`). This file sets the **whether, when, and how** — deliberately conservative, sequenced after retention is proven.

> **Posture:** token framing is **careful and deferred**. Regulation is geofenced and not yet resolved (`../08_roadmap/phased_gtm_roadmap.md` covers compliance sequencing). Nothing here is a public token promise; this is internal strategy. External Season 0 comms (`./points_and_pre_token_meta.md`) imply a *credible path*, never a committed launch.

## Whether & when (the gate)

We do **not** launch a token to manufacture PMF. A token lands on a real product or it lands on vaporware.

**The launch gate — all must hold:**
- **Retention is proven:** W4 retention and the rank-defense cohort are durable (targets in `../07_growth_ops_metrics/north_star_and_kpis.md`).
- **The North Star is real:** Weekly Active Operators reaching a contested reveal is growing organically, not on incentives.
- **Loops are self-sustaining:** K-factor and the Clip Loop work *without* points subsidy.
- **At least one full Season 0** has run, so the airdrop maps to demonstrated behavior, not promises.

Sequencing (mirrors the flywheel, `../00_foundation/growth_model_and_flywheel.md`): **PMF → Retention → Virality → Community → [TOKEN] → Ecosystem dominance.** The token is a **Phase 2→3 act**, never Phase 0–1. Launching before retention is the canonical Solana failure mode.

## Airdrop design — mapped to Season 0 points

The airdrop is the **settlement of Season 0 conviction**. Its legitimacy is that it rewards the *right behavior* already banked as points (`./points_and_pre_token_meta.md`), filtered hard for sybils.

**Allocation logic:**
```
operator_allocation = f(season_points)               # play, depth, loyalty, recruit, drama
                    × personhood_score                 # proof-of-personhood (0–1)
                    × cluster_integrity                # ↓ for sybil-clustered wallets
                    × retention_gate                   # see escrow/vesting below
```
- **Sublinear curve** on points → tokens (e.g. `alloc ∝ points^0.85`) so whales/heavy farmers don't dominate; the long tail of genuine Operators is rewarded. Status civilizations need a broad base, not five winners.
- **Behavior-weighted, not balance-weighted:** allocation tracks PLAY/DEPTH/RECRUIT/DRAMA — never deposit size. A whale who parked capital and never reached a reveal earns ~nothing.
- **House & Chamber pools:** a slice flows to House founders and Chamber treasuries by their rolled-up points, hard-wiring the community loop into the cap table.

## Heavy anti-sybil (the airdrop's survival depends on it)

Sybil farms exist *specifically* to attack points/airdrops. The full machinery is in `./incentive_and_anti_sybil_design.md`; the token-specific posture:

- **Proof-of-personhood is a hard gate**, not a multiplier alone — wallets below a personhood floor get **zero** allocation regardless of points.
- **Wallet-cluster analysis:** funding graphs, timing correlation, and behavioral fingerprints collapse farm clusters to a single (or zero) allocation.
- **Behavioral proof beats balance proof:** because points require *playing to reveals* and *recruits who actually play*, a sybil must run thousands of skill-expressive, capital-at-risk matches to farm — economically irrational. The product design is itself the first anti-sybil layer.
- **Clawback window:** allocations are challengeable post-snapshot; flagged clusters are slashed before tokens move.

## Token utility — within the lexicon, without breaking the brand

Utility must extend the status civilization (`../00_foundation/lexicon_and_status_system.md`) and **never** make rank buyable, never grant table edge, never compromise capital safety. Four lanes:

| Lane | What the token does | Brand guardrail |
|------|---------------------|------------------|
| **Status-adjacent perks** | cosmetic insignia, profile flair, ceremony access, lounge/event entry | **never** a Council seat or rank — those stay earned-only |
| **House economics** | stake to found/upgrade a House; House rev/points-share denominated in token; House treasuries | recruiting upside, not pay-to-win at the table |
| **Fee discounts** | reduced **entry fee / pot rake** for stakers/holders | a loyalty discount on the *house take*, never an in-match advantage over opponents |
| **Governance** | vote on season params, point weights, ecosystem grants, ritual calendar | governs the *meta*, never individual match outcomes or rank |

**The bright line:** the token can make Syndicate *cheaper, more social, and more decorated* for committed Operators — it can **never** buy skill outcomes, rank, Council membership, or an edge in a live match. The moment any of those become purchasable, the moat (non-portable, earned reputation) is gone. Status stays non-buyable, full stop.

**Fee-model interaction:** Revenue is the configurable **entry fee (on join)** + **pot rake (at settlement)**. Token fee-discounts reduce *Syndicate's* take for loyal holders — they tune the rake/fee, they do **not** alter pot distribution between Operators (closest eligible prediction wins via poker side-pot rules, untouched). Sinks (below) recycle fees/token to keep the economy sustainable, detailed in `./incentive_and_anti_sybil_design.md`.

## Supply & allocation philosophy (high level)

We commit to *principles*, not a public schedule (deferred/geofenced):

- **Community-majority.** The largest share goes to Operators (airdrop + ongoing season emissions), because distribution *is* the product and Operators *are* the channel.
- **Long, escrowed team/investor vests** — credibly aligned, no early-unlock dump pressure overhanging the leaderboard.
- **An ongoing emissions reserve** funding future Seasons (play-to-earn-status, never deposit-to-earn) so the points→token loop persists beyond the airdrop.
- **An ecosystem/grants pool** for partner integrations, KOL Houses, and Blink/quest distribution (the ecosystem loop, `../06_ecosystem_distribution/`).
- **Restraint as flex:** a tight, legible, non-inflationary-looking design reads premium on CT — consistent with the brand (`../00_foundation/positioning_and_brand.md`).

## Avoiding the mercenary post-airdrop collapse

The default Solana airdrop outcome: claim → dump → churn → activity craters. We engineer against it structurally:

- **Retention-gated vesting:** a portion of each allocation **vests only as the Operator keeps playing** post-TGE (e.g. unlocks tied to reaching reveals across the next Season). Claim-and-dump leaves tokens on the table.
- **Escrowed rewards:** ongoing season rewards escrow and release on continued contested play, so emissions reward *staying*, not arriving.
- **Sinks > faucets:** entry-fee/rake discounts, House founding stakes, cosmetic and event burns/locks create persistent demand that absorbs sell pressure (sink design in `./incentive_and_anti_sybil_design.md`).
- **Status outlives the token:** because rank, Council, and Grand Operator lore are **non-buyable and non-dumpable**, the prestige economy keeps Operators engaged even through token volatility. The token is gravity; **status is the anchor.** This is precisely why the token comes *after* the status system is proven.
- **No deposits-for-rewards, ever:** every token incentive routes through play/retention/recruiting (`./incentive_and_anti_sybil_design.md`), so capital can't farm-and-flee without genuinely engaging.

## Communications & compliance posture

- **Careful framing throughout.** No public token commitments, dates, or value claims in restricted contexts. Season 0 communicates a *path*, the product communicates *status*; the token communicates only when compliance clears it (`../08_roadmap/phased_gtm_roadmap.md`).
- **Geofencing** applies to any token/real-money surface, consistent with the broader posture.
- **Honest framing** continues: a token is ecosystem alignment and utility — never "buy this to win" or a get-rich-quick claim. Overclaiming is both a credibility and a legal landmine.

## The single test for any token mechanic

*Does it reward play / retention / recruiting / creation, keep status and match outcomes non-buyable, preserve capital safety, and survive a sybil farm?* If a proposed utility makes rank or table edge purchasable, it is rejected on sight — no exceptions. KPI impact and post-TGE retention tracked in `../07_growth_ops_metrics/north_star_and_kpis.md`.
