# Syndicate — Contradictions, Ambiguities & Unresolved Mechanics

**Document status:** Canonical foundation, v1.0
**Method:** Every item is cited to its source (BV = `Builder_vision.md`, GM = `Game_mechanics.md`, REQ = `Game_requirement_user_pov.md`), classified by severity, and given a resolution pointer to the canonical docs. Items marked **[FOUNDATIONAL]** are too expensive to fix after engineering begins.

Severity scale: **Critical** (breaks integrity, capital safety, or settlement), **High** (warps gameplay or retention), **Medium** (must be defined, lower blast radius), **Low** (cleanup).

---

## A. Direct contradictions between documents

**C1 — Prediction concealment vs. fold-reveal. [Critical]**
GM §2: "All submitted predictions remain concealed until the match concludes." REQ §12 (Fold): "Prediction is immediately revealed." REQ §16: "Only surviving players reveal." These cannot all be true. Revealing a folder's prediction mid-match leaks live information to remaining bettors and creates a collusion signal.
*Resolution:* Predictions are **time-lock encrypted** — mid-match nothing is decryptable by anyone (so a fold leaks nothing, and there is no mid-match reveal), and all numbers open automatically at match end. (GAME_MECHANICS §12.)

**C2 — Winner-take-all vs. side-pot eligibility. [Critical][FOUNDATIONAL]**
GM §8 / REQ §17: "the **total accumulated pot** is awarded to the participant whose prediction is closest." GM §4 / REQ §14 simultaneously describe side pots, where a player can only win pots they contributed to. "Closest takes the *whole* pot" contradicts side-pot eligibility and produces the absurd case the founder flagged: a 2-chip bettor beating an all-in for 100.
*Resolution:* Standard poker pot + side-pot eligibility. Among players **eligible** for a given pot, the closest prediction wins *that pot*. No player can win chips they never matched. (GAME_MECHANICS §Pot Construction & Settlement.)

**C3 — Blinds rotate every round vs. one prediction / one showdown. [High][FOUNDATIONAL]**
REQ §9 posts and rotates Small/Big Blind "at the start of every round" and shows the button moving Round 1 → 2 → 3. In poker, blinds rotate per **hand** (one deal to one showdown). A Syndicate match has **one** prediction and **one** settlement — i.e., it is *one hand* with three betting streets, not three hands. Re-posting and rotating blinds each round is a category error that would double/triple-charge blinds and scramble action order.
*Resolution:* Blinds are posted **once** at match start. Rounds II and III are check-enabled betting streets (like turn/river). The button is assigned once per match via VRF. (GAME_MECHANICS §Blinds & Betting Streets.)

**C4 — "Only survivors reveal" vs. "folder's prediction revealed." [Medium]**
Same root as C1; listed separately because REQ §16 and REQ §12 contradict each other internally even before considering GM §2. Resolved by C1's muck-on-fold rule.

**C5 — Blinds listed as elective "actions." [Low]**
GM §3 lists "Small Blind" and "Big Blind" among the actions a player "may perform during their turn." Blinds are *forced posts*, not elective actions. Minor, but indicative of an imprecise action model.
*Resolution:* Action set is exactly {Fold, Check, Call, Bet/Raise, All-In}; blinds are forced posts handled by the engine. (GAME_MECHANICS §Action Set.)

---

## B. Critical missing definitions (settlement & money)

**M1 — The settlement price is undefined. [Critical][FOUNDATIONAL]**
GM §7 / REQ §17 settle against "the realized market price at the exact end of the match" with **no oracle named, no precision, no sampling window, and no manipulation model.** "The price at an instant" is not a well-defined, deterministic, or manipulation-resistant quantity. The whole pot hinges on this single number.
*Resolution:* Settlement price = median of a decentralized oracle (Pyth-class) sampled across a defined **final-window TWAP** (default last 60s), with all samples recorded on-chain/in the audit log; explicit feed-health guards and a void path. (GAME_MECHANICS §Settlement Price Oracle.)

**M2 — The asset is undefined. [High]**
GM/REQ reference "a designated asset" and use BTC in examples but never specify which assets are tradable, how an asset is bound to a table, or whether it is configurable.
*Resolution:* Each table is bound to exactly one asset/feed at creation; v1 ships a small curated set (e.g., BTC/USD, SOL/USD, ETH/USD). (GAME_MECHANICS §Table Definition.)

**M3 — Stack-to-blind ratio is broken at low tiers. [High]**
REQ §6 sets stack = deposit (100 USDC → 100 chips) and REQ §9 example blinds = 1/2. At the 10 USDC tier, that is a **5 big-blind** stack — unplayable; the first forced bet swamps the stack. Blind sizing is not tied to buy-in.
*Resolution:* Stacks are denominated in chips at a fixed ratio per tier so every tier starts at a sane stack depth (e.g., 100 BB), with a published blind schedule per tier. (GAME_MECHANICS §Capital Model & Blind Schedule.)

**M4 — No rake / fee / revenue mechanism anywhere. [High]**
No source document defines how the platform earns. A real-money game with no take-rate is not a business, and retrofitting rake after launch erodes trust.
*Resolution:* Transparent, capped pot rake as a tunable table parameter, disclosed pre-match; default value flagged as a business decision. (GAME_MECHANICS §Rake; OPEN_QUESTIONS.)

**M5 — On-chain transaction costs unassigned. [Medium]**
Deposit, settlement, and claim are on-chain. Who pays Solana fees, and how are they handled at the 10 USDC tier where they may be material relative to stake? Undefined.
*Resolution:* Fee-payer policy specified (platform-sponsored relays / fee budget per match), with minimum-tier economics validated. (ARCHITECTURE; OPEN_QUESTIONS.)

**M6 — Commitment vs. encryption conflation. [Medium][FOUNDATIONAL]**
GM §2 says predictions are "cryptographically committed **and encrypted**." REQ §7 says "encrypted client-side." A *commitment* (e.g., `H(prediction‖salt)`) and an *encryption* (which implies a decryption key exists somewhere) are different primitives with different trust models. If "encrypted," who holds the key? If escrowed, the backend can see plaintext, contradicting "backend cannot access plaintext."
*Resolution:* Use **time-lock encryption** (an IND-CPA scheme with **no key holder**) — no escrow, no plaintext on the backend, no manual reveal; predictions auto-decrypt at `timelock_target` (match end). This supersedes a salted-hash commit-reveal and is strictly stronger operationally. (GAME_MECHANICS §12; ARCHITECTURE §2.)

---

## C. Edge cases & undefined states (lifecycle gaps)

**E1 — Action timeout behavior is wrong and underspecified. [High]**
REQ §11: "Failure to act before timeout **may** result in Auto Fold." Blanket auto-fold is punitive: a player who could **check for free** should never be folded for inaction. Timer length and time-bank are undefined.
*Resolution:* On timeout, **auto-check if no bet faces the player; auto-fold only if facing a bet.** Defined per-turn timer + shared time bank. (GAME_MECHANICS §Action Timer.)

**E2 — Disconnect and reconnection are entirely undefined. [High]**
No source document addresses a player dropping mid-match, during the reveal, or during settlement.
*Resolution:* Disconnect is treated as timeout (auto-check/fold); all-in players need no actions and are never auto-folded; reconnection restores seat control at any time; client auto-reveals at settlement. (GAME_MECHANICS §Disconnect & Reconnect.)

**E3 — Non-reveal / reveal griefing at settlement. [Eliminated]**
Originally: if a surviving player never opened their commitment (disconnect or grief), settlement liveness was threatened.
*Resolution (eliminated, not merely mitigated):* **time-lock encryption removes this entire failure class** — predictions open automatically at match end with no player action, so non-reveal, reveal-griefing, and disconnect-at-showdown simply cannot occur. The only residual dependency is time-lock **beacon liveness**, handled by a bounded grace period → VOID + full refund. (GAME_MECHANICS §12; RISK A8.)

**E4 — Lone-survivor (everyone folds) has no defined outcome. [High]**
Standard, *frequent* poker outcome: all but one player folds. With one survivor there is no one to compare predictions against. Does the survivor win without revealing? The source documents never say.
*Resolution:* If only one player is eligible for a pot, that player wins it **uncontested without revealing** (prediction never opened). This is correct poker behavior — and it is the root of the flagship tension F1 below. (GAME_MECHANICS §Uncontested Pots.)

**E5 — Simultaneous / multi-tier all-ins lack a construction algorithm. [High][FOUNDATIONAL]**
GM titles "Simultaneous All-Ins" as a concern and waves at "standard side-pot mechanics," but no deterministic construction is specified — and it is genuinely non-trivial across **three** betting streets with one showdown.
*Resolution:* Fully specified contribution-tier side-pot algorithm with a worked example. (GAME_MECHANICS §Pot Construction Algorithm.)

**E6 — Tie resolution is deferred to undefined "table rules." [Medium]**
GM §8: ties resolved by "predefined tie-resolution procedures … according to table rules" — which are never defined. Indivisible "odd chip" handling is undefined. Equal-and-opposite distances (one above, one below by the same amount) are undefined.
*Resolution:* Tie within a pot → split equally; indivisible remainder → deterministic tiebreak by **earliest commitment timestamp** (rewards decisiveness), fully specified. (GAME_MECHANICS §Tie Resolution.)

**E7 — Betting-round closure vs. wall-clock round timer is ambiguous. [High]**
GM §6 / REQ §13: "If all remaining players check, the round enters a waiting state until the timer expires." But what if betting is **not** complete (a raise war is in progress) when the round timer expires? Undefined. The relationship between "betting round complete" and "round duration elapsed" is unspecified.
*Resolution:* Each round = **observation window → betting window**; betting must close within the round; if the round timer expires mid-action, pending players are auto-resolved (check/fold) and the street closes deterministically. (GAME_MECHANICS §Round Timing Model.)

**E8 — Minimum-legal-raise undefined. [Medium]**
REQ (Raise): "Raise Amount ≥ Minimum Legal Raise," but the minimum legal raise is never defined.
*Resolution:* Standard no-limit rule: a raise must be at least the size of the previous bet/raise increment; defined precisely. (GAME_MECHANICS §Raise Rules.)

**E9 — Table-fill and cancellation timeouts undefined. [Medium]**
REQ §4/§5: a match can fail to start (refund), but the fill deadline, the minimum-to-start timeout, seat-reservation race conditions, and private-room host-disconnect behavior are all undefined.
*Resolution:* Defined fill window, min-2 start rule, seat-reservation finality via on-chain deposit, host-cancel and host-disconnect rules. (GAME_REQUIREMENTS §Matchmaking & Lobby.)

**E10 — Blind posting with sub-blind stacks undefined. [Low]**
If a player's stack is smaller than the blind they owe (possible only via misconfiguration given M3's fix, but still), the post-as-all-in rule must be stated.
*Resolution:* Player posts all-in for less than the blind; side pot forms normally. (GAME_MECHANICS §Blinds.)

**E11 — Mass auto-fold / all-fold pathological state. [Low]**
If every remaining player is auto-folded via disconnect within the same window, the pot must still resolve.
*Resolution:* Last player to have acted (or last to forfeit) is handled by the uncontested-pot rule; if literally all forfeit simultaneously, pot is voided to contributors pro rata. (GAME_MECHANICS §Degenerate States.)

**E12 — Precision, rounding, and units of the prediction. [Medium]**
The prediction is a price with decimals; absolute-difference comparisons need a defined precision and rounding rule, or near-ties become non-deterministic.
*Resolution:* Predictions and settlement price are fixed-point at a defined decimal precision per asset; comparisons are exact integer math. (GAME_MECHANICS §Numeric Precision.)

---

## D. Strategic & economic weaknesses

**S1 — Prediction clustering compresses skill. [High]**
Rational players cluster predictions near the forward price, so showdown distances become tiny and the winner is frequently decided by microstructure noise. Detailed in `01_EXECUTIVE_ASSESSMENT §3`.
*Resolution:* Accepted as poker-like variance; positioning corrected (skill is in betting, not forecasting); TWAP settlement prevents a single tick from deciding large pots; natural game-theoretic dispersion emerges because taking a contrarian view is +EV when you have one. (BUILDER_VISION §Skill pillar.)

**S2 — Nit equilibrium / dead pots. [Medium]**
Because a single showdown is noisy, a defensible strategy is to fold everything and never commit beyond the blind, collapsing pots to blind-size and making matches boring.
*Resolution:* Observation-gated streets plus a modest blind/ante schedule keep pots growing; the open-questions doc flags monitoring "median pot / blinds" as a core health metric to tune. (OPEN_QUESTIONS.)

**S3 — Round III anticlimax. [Medium]**
Near match end the price is nearly known, so a player far from their number knows they are likely beaten and folds, potentially collapsing the final street into folds — the opposite of a climactic reveal.
*Resolution:* This is real and is bounded by muck-on-fold (you still don't know *others'* numbers, so confidence ≠ certainty) and by the reveal-tension design; flagged for playtest. (OPEN_QUESTIONS.)

**S4 — Collusion vectors at 2–5 handed tables. [High]**
Small tables + anonymous wallets + a shared public board enable chip-dumping, squeeze plays against a lone non-colluder, and out-of-band prediction-sharing to coordinate folds. Fold-reveal (now removed) would have made this trivial.
*Resolution:* Muck-on-fold, VRF seating, anti-Sybil at matchmaking, collusion telemetry; residual risk priced and monitored. (RISK_REGISTER; ARCHITECTURE.)

**S5 — No skill-based matchmaking / bot defense. [Medium]**
REQ §1 public matchmaking is "automatic seat assignment, public player pool" with no rating, no bot detection, no Sybil resistance — predatory bankrolls and bots will farm casual players.
*Resolution:* Matchmaking gains rating buckets, proof-of-personhood/Sybil resistance, and bot telemetry. (GAME_REQUIREMENTS §Matchmaking; OPEN_QUESTIONS.)

**S6 — All-in-early dead time. [Medium]**
GM §6: if everyone is all-in early, the match "proceeds automatically … until final settlement." Because settlement is pinned to the 10-minute mark (the prediction target), players may wait many minutes with no agency.
*Resolution:* Inherent to the prediction horizon; mitigated by run-out tension UI; the Blitz-format question (shorter matches) is flagged. (OPEN_QUESTIONS.)

---

## E. The flagship tension (must be designed around, not "fixed")

**F1 — The poker layer destroys the reveal the product is built around. [Critical, design-defining]**
The Builder Vision declares the **final reveal "sacred"** — "the entire match exists to maximize the emotional impact of the final reveal" (BV §Psychological Tension, §Final Reveal). But the poker layer rewards making opponents **fold** — and a folded player never reveals (E4, and correctly so). In well-played poker, **most hands end with everyone but one player folding, i.e., with no showdown at all.** Therefore, under good play, *the sacred reveal happens only in a minority of matches.* The two layers are in direct tension: the betting layer's optimal outcome (everyone folds, you win uncontested) is the emotional layer's failure case (no reveal).

This is not a bug to be patched; it is the central design problem of Syndicate, and it must be a conscious, top-level design decision. The canonical design resolves it deliberately rather than accidentally:

1. **Make showdowns more frequent by design.** Cap how much fold equity exists: with a manipulation-resistant TWAP target and hidden opponent numbers, players cannot bully others out as cheaply as in card poker (you can never "represent" a made hand you can prove, because nobody's number is known). Hidden, symmetric information keeps more players in to the reveal than card poker would.
2. **Make the *non-reveal* outcome also emotional.** An uncontested win still resolves a live, public market chart that everyone watched — design the "they folded, you took it down" moment as its own premium beat, and *optionally reveal the winner's number* (winner's choice) as a flex.
3. **Tune the blind/ante and stack depth so that getting to showdown is the common, profitable line at the buy-in tiers we promote**, accepting lower fold equity than card poker as a deliberate identity choice.
4. **Position honestly:** the reveal is the *signature* moment, not the *only* moment; the product promise is "conviction under uncertainty," which is satisfied by both contested and uncontested resolutions.

This tension is called out here, in the vision (`03`), and in open questions (`08`) because mishandling it produces either a boring fold-fest with no payoff or a forced reveal that breaks poker integrity. It is the single most important thing to validate in playtest.

---

## F. Cleanup / lower-severity items

- **L1 —** "Raise (where applicable under table rules)" (GM §4) references undefined table rules. *Resolved:* a player facing an all-in may raise only if not themselves all-in and the all-in constituted a full legal raise (standard rule). (GAME_MECHANICS §Raise Rules.)
- **L2 —** Spectator market (REQ §22) was internally under-specified (odds source, lock timing, insider-info guarantees, double-settlement). **Out of v1 scope per founder decision; not corrected here**, only sealed behind an architectural seam. (ARCHITECTURE §Deferred Modules.)
- **L3 —** "Replay Game / Verify Intents" (REQ §18) presumes a signed-intent event log and recorded oracle samples that the source never specifies. *Resolved:* event-sourced, signed action log + recorded oracle samples make replay deterministic. (ARCHITECTURE §Determinism & Replay.)
- **L4 —** Heads-up (2-player) blind/action order unspecified. *Resolved:* standard heads-up rules (button posts SB, acts first on the first street, last thereafter). (GAME_MECHANICS §Heads-Up.)

---

## Summary table

| ID | Issue | Severity | Foundational | Resolved in |
|----|-------|----------|--------------|-------------|
| C1 | Fold reveals prediction vs. concealed-until-end | Critical | – | GM Fold/Settlement |
| C2 | Winner-take-all vs. side-pot eligibility | Critical | ✓ | GM Pot/Settlement |
| C3 | Blinds rotate per round vs. one showdown | High | ✓ | GM Blinds |
| M1 | Settlement price undefined | Critical | ✓ | GM Oracle |
| M3 | Stack:blind broken at low tiers | High | – | GM Capital |
| M4 | No rake / revenue | High | – | GM Rake |
| M6 | Commitment vs. encryption → time-lock encryption | Medium | ✓ | GM §12 |
| E1 | Auto-fold on free check | High | – | GM Timer |
| E2 | Disconnect/reconnect undefined | High | – | GM Disconnect |
| E4 | Lone-survivor outcome undefined | High | – | GM Uncontested |
| E5 | Multi-tier all-in algorithm | High | ✓ | GM Pot Algo |
| E7 | Betting closure vs. round timer | High | – | GM Round Timing |
| S1 | Prediction clustering / skill compression | High | – | BV Skill pillar |
| S4 | Collusion vectors | High | – | Risk/Arch |
| F1 | **Poker layer destroys the reveal** | Critical | ✓ | GM + BV + OQ |

F1, C2, M1, and C3 are the load-bearing fixes. Everything below them is craft.
