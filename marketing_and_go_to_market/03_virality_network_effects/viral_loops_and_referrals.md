# Viral Loops & Referrals — the House K-factor Engine

Referral on Syndicate is **not a coupon**. Coupons attract mercenaries who churn the moment the bonus dries up — exactly the wrong energy for a premium, anti-casino brand (`../00_foundation/positioning_and_brand.md`). Our referral engine is the **House**: a selfish, status-bearing, invite-only crew an Operator founds and must staff. You recruit not because we pay you a finder's fee, but because **your House needs Operators to fill tables, your standing needs people to be legible against, and you share in your House's upside.** That makes K-factor a *default behavior driven by self-interest and status* — the only kind that scales for free.

> The House turns "refer a friend" into "build your faction." Founders recruit relentlessly because the House is *theirs* — and a House without Operators is an empty room.

## Why the House is the right K-engine on Solana

| Lever | Coupon referral (Web2) | House referral (Syndicate) |
|-------|------------------------|----------------------------|
| Motive | one-time cash bounty | ongoing self-interest: fill *your* tables, earn *your* share, grow *your* status |
| Brand fit | cheapens premium positioning | invite-only texture *reinforces* exclusivity |
| Churn | mercenary, post-bonus | recruits join a crew → social retention |
| Scarcity | infinite spammy links | curated Houses = status object |
| Status | none | founder gains standing as House grows |

This is loop #2 of the seven (`../00_foundation/growth_model_and_flywheel.md`) and the engine behind K in `Operators(t+1) = Operators(t) × (Retention × K) + Paid`.

## Blinks: one-tap "join my House" invites in a tweet

Solana **Blinks/Actions** are the unfair distribution advantage. A House invite is an on-chain Action embedded directly in a tweet — the recruit connects wallet and takes a seat **without leaving CT**.

- **The artifact:** a beautiful, screenshot-native House card (founder, House crest, member count, recent signature reveals) with an embedded Action button.
- **CT copy (founder posts):**
  > `My House is open. Three seats at tonight's table. Operators only.` [ Take a seat in [House] ▸ ]
- **Mechanic:** click → wallet connect (Phantom/Backpack) → land directly in *that House's* table preview → first practice reveal → real seat (the activation path in `../02_activation_retention/onboarding_and_aha_moment.md`). The referral closes in the **same session** the click happens.
- **Attribution is on-chain:** the Action carries the founder's House ID, so credit and rev-share are provable — no off-chain tracking-link leakage.

Blinks collapse the funnel from "click link → new tab → app store → signup → maybe play" to **one tap → seated**. That is the single biggest K lever we have.

## Referral rewards — upside without cheapening the brand

Rewards flow to the **House**, not as a tacky per-head bounty, and they are *status- and economics-bearing*:

1. **House points / rev share to the founder.** A founder earns a share of their House's match activity (points now, a rev/points multiplier with the token meta — `../05_economy_incentives/incentive_and_anti_sybil_design.md`). The bigger and more active the House, the larger the founder's standing and stake. This is recurring, not one-shot — so founders keep recruiting and *retaining*.
2. **Co-status, not cashback.** A thriving House lifts the founder's **contribution rating** (feeds the climb in `../02_activation_retention/progression_and_ranks.md`) and earns House insignia. The reward is *being seen* as the founder of a strong faction — premium status, not a discount code.
3. **Member-side pull is access, not a bribe.** Recruits don't get "$10 off"; they get *into a House* — private tables, a crew, a side to play for. The reward is belonging (which retains), framed as admission to something exclusive.

No "give $10, get $10." No casino "deposit bonus." Every incentive reinforces the Royal × Institutional × Elite frame.

## Invite-only texture (scarcity as a feature)

Exclusivity is not friction to remove — it is the product.

- Houses are **invite/founder-gated**; you join by Blink-invite or by founding your own. The walls make a seat feel earned.
- **Curation pressure:** a founder's House is judged by the caliber of its Operators, so founders recruit *well*, not just *widely* — quality compounds the status. (Naturally throttles spam.)
- "Operators only" is the recurring verbal cue — the invite reads as admission to an order, not a sign-up funnel (`../00_foundation/lexicon_and_status_system.md`).

## K-factor math (with numbers and the target)

K-factor `K = i × c`, where `i` = invites sent per Operator and `c` = conversion per invite. Viral growth compounds when **K > 1**.

**Worked example (Phase 1 conservative):**
```
i = 4 House-invite Blinks sent per founding Operator (per cycle)
c = 0.20 conversion per Blink (one-tap, lands in-table — high for crypto)
K = 4 × 0.20 = 0.8   → sub-viral, paid/partner still needed to top up
```

**Worked example (target, mature loop):**
```
Founders (≈25% of activated Operators) send i = 8 invites/cycle
Non-founders send i = 1.5 (light sharing)
Blended i ≈ 0.25·8 + 0.75·1.5 ≈ 3.1
c = 0.30 (Blink one-tap + arriving into a *specific* House + practice aha)
K ≈ 3.1 × 0.30 ≈ 0.93  per cycle
```

With multiple invite cycles per Operator lifetime and the Clip loop running in parallel (`spectator_and_clip_engine.md`), **effective compounded K crosses 1**. Targets:

| Metric | Definition | Target |
|--------|------------|--------|
| **Invites/founder/cycle (i)** | House Blinks sent per founder | **≥ 6** |
| **Blink conversion (c)** | invites → activated Operators | **≥ 25%** |
| **Blended K** | per-cycle viral coefficient | **≥ 0.9**, trending **> 1** |
| **Founder rate** | activated Operators who found a House | **≥ 25%** |
| **Cycles/Operator** | invite cycles over first 90d | **≥ 3** |
| **Referred W4 retention** | W4 of House-referred Operators | **≥ non-referred** (must not be lower) |

**The decisive insight:** because invites are *selfish* (fill my table) and *recurring* (every season, every Chamber Night), `i` stays high without us paying for it — and Blinks keep `c` far above Web2 referral norms. Retention (the `× Retention` term) is held by the same Houses (members join a crew), so virality and retention reinforce instead of trading off.

## Anti-sybil guardrails on referrals

A points/rev-share referral loop is a sybil magnet. Guardrails (full design in `../05_economy_incentives/incentive_and_anti_sybil_design.md`):

- **Rewards accrue on *real play*, not on signup.** Founder share derives from genuine match activity (USDC seats, on-chain), not headcount — so spinning up empty wallets earns nothing.
- **Proof-of-personhood** gates reward eligibility; per-match fresh USDC deposit + on-chain finality raises the cost of fake seats far above any farmable reward.
- **Self-referral / wash detection:** circular play within a freshly-minted cluster is flagged; rev-share clawed/withheld.
- **Quality-weighted, capped:** founder rewards weight *active, retained* recruits and taper on volume alone — so a House of 500 dormant wallets pays less than a House of 30 real Operators. This also nudges founders to recruit *quality* (reinforcing the invite-only texture above).

The guardrails aren't just defense — they steer the loop toward the *right* growth (real, retained Operators), which is exactly the K that compounds.

## Cross-references

- Flywheel, K, and the seven loops: `../00_foundation/growth_model_and_flywheel.md`
- Houses/Chambers lexicon & status: `../00_foundation/lexicon_and_status_system.md`
- Anti-coupon, premium voice: `../00_foundation/positioning_and_brand.md`
- The activation path a Blink lands in: `../02_activation_retention/onboarding_and_aha_moment.md`
- House founding as a progression growth event: `../02_activation_retention/progression_and_ranks.md`
- Houses & Chambers network effects in depth: `chambers_and_houses.md`
- The Clip loop that runs alongside K: `spectator_and_clip_engine.md`
- Anti-sybil & reward design: `../05_economy_incentives/incentive_and_anti_sybil_design.md`
- KOL-as-Operator (Houses at scale): `../01_acquisition/kol_and_creator_program.md`
