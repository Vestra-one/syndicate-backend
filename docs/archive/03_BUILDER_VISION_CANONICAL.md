# Syndicate — Product Manifesto (Canonical)

**Status:** Canonical `BUILDER_VISION.md`, v1.0. Supersedes the first-draft vision.
**Decision order (applied throughout):** Game Integrity → User Clarity → Capital Safety → Determinism → Strategic Depth → Premium Experience → Scalability → Monetization → Feature Richness.

---

## Vision

Syndicate is a new competitive sport: **conviction under uncertainty, played for real capital.**

Each player privately commits a single number — where they believe a live market will settle — and then bets that conviction against a table of rivals while the market moves in front of everyone at once. Conviction is hidden. Capital is public. Only at the end is foresight revealed.

Syndicate is not a casino, not a prediction market, and not poker. It borrows poker's most perfect mechanism — **betting under hidden information** — and replaces private cards with a **shared, living market** that every player reads differently because every player holds a different secret number.

Every decision in the product must reinforce one feeling:

> *"I am seated at an exclusive high-stakes table among elite market operators, and my judgment is on the line."*

The atmosphere we are building: private banking, institutional trading floors, members-only clubs, high-stakes card rooms, luxury hospitality. A player should feel they have been admitted to an event reserved for serious capital allocators.

---

## What kind of game this actually is (the honest core)

This section exists because the first draft mis-stated where the game's skill lives, and that mis-statement is the most dangerous thing we could ship.

**Truth #1 — Over a short horizon, no one can predict the exact closing price.** The settlement price of a deep, liquid asset over ~10 minutes is effectively a random walk. The player who is closest in any single match is, more often than not, lucky. We will not pretend otherwise, and we will never market Syndicate as a tool for *out-forecasting the market*.

**Truth #2 — The skill is in the betting, exactly as in poker.** Your prediction is your **hidden hand**. You do not control whether it is strong; you control how you play it: when the market's drift toward your number justifies pressure, when to fold a number the market has abandoned, when an opponent's aggression is conviction and when it is a bluff, how to size so that you win big when right and lose small when wrong. As in poker, **skill dominates over volume, not in any single hand.** A beginner can beat a master in one match. A master beats the table over a thousand.

**Truth #3 — Embracing variance is the product, not a compromise.** High single-match variance is precisely what makes the reveal electric and what keeps a broad audience paying. We design *with* variance, and we are honest about it.

This honesty is a competitive moat. The crypto-gaming graveyard is full of products that promised skill and delivered a slot machine. Syndicate promises a *fair contest of nerve and capital discipline* — and delivers exactly that.

---

## The reveal, and the tension we design around

The first draft called the final reveal "sacred." It is our signature moment — but we state a hard truth the first draft ignored:

**Good poker play makes opponents fold, and folded players never reveal.** If we did nothing, most matches would end with everyone folding to one player and *no reveal at all*. The betting layer's best outcome (win uncontested) is the emotional layer's failure case (no showdown).

We resolve this deliberately, and it shapes the whole product:

1. **Hidden, symmetric information keeps players in.** Because no one can prove their number, you can never bully a player out as cheaply as you can in card poker by representing a hand you can show. More players survive to the reveal than in card poker — by design.
2. **The uncontested win is its own premium beat.** "They folded; you took it down" resolves a live chart everyone watched. We treat it as a designed moment, with an optional winner's-choice flourish to reveal the number as a flex.
3. **We tune stakes so reaching the reveal is the common, profitable line** at the tiers we promote — accepting lower fold equity than card poker as a conscious identity choice.

The reveal is the *signature* moment, not the *only* moment. Both contested and uncontested endings satisfy the promise: **conviction under uncertainty, resolved with consequence.**

---

## Product Pillars

Every feature, screen, animation, API, and contract must strengthen at least one pillar.

### 1. Prestige
The product must feel expensive: luxury, sophistication, exclusivity, precision, elegance. Never "fun casino." Avoid cartoon aesthetics, excessive gamification, meme culture, loud animation, childish interaction. The user should feel: *"This was built for serious players."*

### 2. Institutional Quality
The bar is Bloomberg Terminal, private-banking software, professional trading platforms. Every element communicates trust. No visual noise, no accidental complexity, no unfinished interactions, no placeholders, no "good enough." Everything appears deliberate.

### 3. Psychological Tension
Tension is the core entertainment mechanic: uncertainty, conviction, doubt, pressure, anticipation, revelation. Every design decision asks: *does this increase or decrease tension?* The match exists to load the moment of resolution — contested or not — with maximum consequence.

### 4. Strategic Depth — *correctly located*
Syndicate rewards **capital discipline, risk management, fold discipline, and reading opponents under hidden information** — not the ability to forecast a random walk. The user should believe, across a session: *"I won (or lost) because of how I played my conviction — not because the system cheated me, and not because it was a coin toss I had no control over."* We earn that belief by making the betting decisions rich and the settlement provably fair.

---

## Design Philosophy

### Visual Language
**Royal × Institutional × Premium × Timeless.** Keywords: executive, elite, minimal, luxury, sophisticated, confident, high-trust. References: private wealth dashboards, luxury watch faces, high-end trading terminals, executive lounges, Aston Martin, Four Seasons.

### UI Principles

**Information hierarchy.** At a glance the player must know: current market state; current round and time remaining; current pot size; their personal exposure and remaining stack; the action required of them. Nothing competes with these.

**Breathing room.** Whitespace is a luxury feature. When uncertain, remove elements rather than add them. Spacing communicates confidence.

**Motion.** Premium, deliberate, smooth, physical. 150–300ms micro-interactions, eased curves, fades and transforms over flashy effects. References: Apple, Linear, Arc. Animation never feels playful.

**Typography.** The primary design element. Numbers are sacred — prices, timers, balances, pot sizes, and a player's distance-to-conviction must be visually dominant and instantly legible. Typography communicates authority.

### Interaction Philosophy
Frictionless, precise, predictable, intentional. **Capital actions demand absolute clarity.** Before any commitment the user must see: current wager, maximum risk, remaining stack, total exposure. **Never surprise a user financially.** No ambiguous states.

---

## Match Experience Principles

**Match start — anticipation.** Entering a table is ceremonial: an elite chamber, not a lobby.

**Commitment — gravity.** Committing your number is the most important private decision in the match. It must feel weighty, final, and protected — sealed by **time-lock encryption** so it cannot be seen or changed by anyone (there is no key holder), and opens by itself only at the end.

**Betting — pressure, never panic.** Urgency that invites confident decisions, with full exposure clarity at all times.

**Market movement — conviction vs. doubt.** The chart is the antagonist. Proximity to your number is surfaced as live emotional feedback without leaking anything about opponents.

**All-In — maximum tension.** An exceptional, premium event emphasizing commitment, risk, and psychological impact. It should feel consequential.

**Resolution — suspense, then prestige.** Whether contested (sequential reveal of survivors' numbers) or uncontested (the table folds to a winner), resolution is never an instant pop of confetti. It is a championship ceremony, not a jackpot.

---

## Engineering Principles

**Code quality:** production-grade, modular, strongly typed, extensible, auditable, testable. Avoid technical debt, tight coupling, oversized components, magic values, duplicated logic.

**Solana / on-chain priorities (in order):** security, determinism, auditability, transparency, capital safety. Contracts optimize for minimal trust assumptions, explicit state transitions, verifiable settlement, predictable execution. **User funds are sacred; capital safety always supersedes feature velocity.**

**Determinism is non-negotiable.** Every match must be reconstructible from a signed action log plus recorded oracle samples, producing a bit-identical settlement that anyone can verify. If an outcome cannot be independently recomputed, it cannot ship.

**Backend:** designed as institutional finance infrastructure — idempotent operations, full observability, structured logging, retries, strong error handling, deterministic state recovery, comprehensive monitoring. Failures degrade gracefully. **No silent failures.**

---

## Performance Standards
Performance is part of luxury: near-instant transitions, no layout shift, zero unnecessary loading states, optimistic interactions where safe, consistent frame rates, and real-time betting latency low enough that turn timers feel fair. Users must never perceive the system as slow — and must never lose money to latency.

---

## Product Decision Framework
Before implementing any feature, ask:
1. Does this make Syndicate feel more premium?
2. Does this deepen the *betting* decision (real strategic depth), not just the forecast?
3. Does this improve clarity, especially around capital?
4. Does this increase psychological tension?
5. Would an elite user expect this quality?
6. Does this preserve provable fairness and determinism?

If any answer is "no," reconsider.

---

## Non-Negotiables
Never compromise on: **trust, clarity, security, precision, capital safety, determinism, performance, elegance, premium quality, and honest positioning.**

Two product invariants sit above all features and may never be weakened:

- **Provable fairness.** No participant — including the operator — ever holds privileged information or can alter an outcome. Predictions are time-lock-sealed (no key holder); settlement is deterministic, pull-oracle-based, and independently verifiable; and a public, pseudonymous action feed makes every bet auditable in real time. Transparency is a premium feature, not an afterthought.
- **Honest skill claims.** We sell a fair contest of nerve and capital discipline. We never imply that Syndicate is a tool for forecasting markets.

Every pixel, interaction, animation, and line of code reinforces one belief:

> **Syndicate is the definitive premium financial strategy game on Solana — a fair, high-stakes contest of conviction, capital, and nerve.**
