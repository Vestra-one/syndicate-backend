> **⚠️ DEPRECATED / STALE — not authoritative for current behavior.** This predates the v1 implementation and may describe a different game (e.g. Switchboard/Pyth oracle, median-60s, session-keys). Trust the **code** and `docs/V1_COMPLETION_CHECKLIST.md` instead.

# Syndicate — Canonical Game Mechanics

**Status:** Canonical `GAME_MECHANICS.md`, v1.0. This document is the single source of truth for rules and settlement. It is written to be **deterministic and complete**: every state has a defined transition, every action a defined legality, every pot a defined owner. If an implementation question is not answered here, it is an `OPEN_QUESTION`, not an implementation choice.

**Reading note:** This is an engineering specification. Structured rules, tables, and explicit state machines are used deliberately because ambiguity is the enemy of capital safety and determinism.

---

## 0. Glossary & invariants

- **Match** — one full game: one shared price feed, one settlement price, **one hidden prediction per player, one showdown.** A match is *one poker hand played across its betting streets (default three)*, not multiple hands.
- **Round / Street** — one of the configured betting phases within the single match (default three: Round I, II, III). Round count and per-round durations are configurable (§2).
- **Stack** — a player's chips currently available to wager. Starting stack = the player's buy-in, in chips.
- **Contribution `c_i`** — the cumulative chips player *i* has put into the pot across all streets.
- **Prediction `p_i`** — player *i*'s time-lock-encrypted price estimate of the feed at match end. Sealed at submission; auto-decrypts at match end (§12).
- **Settlement price `S`** — the canonical final price (defined in §11).
- **Eligible** — a non-folded player who contributed to a given pot layer (§9).

**Global invariants (must always hold):**
1. **Conservation:** total chips out of vault at settlement = total chips in (sum of buy-ins), minus fees (entry fee + pot rake, §14). No chips are created or destroyed.
2. **Concealment:** every prediction is sealed by **time-lock encryption** and is mathematically undecryptable by anyone — players, spectators, *or the operator* — until the match-end time-lock opens. There is no key holder. At match end, all predictions decrypt automatically and deterministically (§12).
3. **No-privilege:** no actor, including the operator, can read a prediction early, alter an action after signing, or influence `S`.
4. **Determinism:** the full settlement is a pure function of (signed action log, time-lock-encrypted predictions, the published time-lock decryption key, recorded oracle samples, VRF seed, table config). Replaying these inputs reproduces the exact result bit-for-bit.
5. **Capital clarity:** before any action that commits chips, the client shows the player their current wager, max risk, remaining stack, and total exposure.

---

## 1. Numeric precision (no floating point in money or settlement)

- **Chips** are integers in the betting token's smallest unit (e.g., micro-USDC, 6 decimals). All wager math is integer arithmetic. The betting/chips token is **independent of the price feed** (§2).
- **Prices** (predictions and settlement) are fixed-point integers at a **per-feed** precision `d` (e.g., BTC/USD at `d = 2` → cents; an equity feed may use a different `d`). A prediction is stored as `round(price × 10^d)`.
- **Distance** for winner determination is the exact integer `|p_i − S|`. There is no rounding at comparison time; ties are exact-integer ties resolved per §13.

---

## 2. Table definition (set at creation, immutable for the match)

A table binds the following parameters, all disclosed to players before they deposit:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `price_feed_id` | **BTC/USD** | The feed players predict and settle against — **any** instrument the oracle provides (crypto, equity, commodity, FX). One feed per table. |
| `chips_token` | **USDC** | The token staked and paid out. **Independent of the feed** — e.g., predict BTC/USD while betting in USDC. |
| `oracle_adapter` | **Switchboard On-Demand** | Pull-based oracle backing the feed; Pyth or others pluggable without changing settlement (§11). |
| `buy_in`, `max_buy_in` | tiered | Fixed buy-in per tier, in `chips_token`; `max_buy_in` / table cap is configurable and may be set high (e.g., up to ~$5M) — kept below market-impact size per feed (§11). |
| `chips_per_unit` | ≈100 BB | Buy-in → starting-stack conversion so every tier starts at a sane depth. |
| `blind_schedule`, `ante` | flat, 0 | Small/Big blind (flat, posted once) and optional ante, in chips (§6). |
| `entry_fee` | configurable | Fee deducted on joining, at deposit into the vault (§14). |
| `rake_pct`, `rake_cap` | configurable | Fee deducted from the final pot at settlement (§14). |
| `min_players`, `max_players` | 2, 5 | Table size. |
| `action_timer`, `time_bank` | 25s, 60s replenishing | Per-turn timer + per-player replenishing time bank (§8). |
| `round_count`, `round_durations` | 3 → 4/3/3 min | Number of rounds and each round's duration. |
| `settlement_window` | 60s | Final-window median length (§11). |
| `timelock_target` | drand round @ match end | When predictions auto-decrypt — a drand `tlock` beacon round (§12). |

**Every value above is configurable.** Defaults exist for launch; the explicit design goal is to reach product-market fit through **config changes, not code changes** — round count, durations, blinds, antes, timers, windows, fees, caps, feed, token, and player counts are all tunable per table/tier. All parameters are **fixed for the duration of a given match** and disclosed to a player before they deposit; they cannot change mid-match.

---

## 3. Match lifecycle (authoritative state machine)

```
CREATED → FILLING → SEALING → LIVE(RoundI → RoundII → RoundIII) → SETTLEMENT_WINDOW → DECRYPT → SETTLED
                                                                                            ↘ VOID (any phase, on fault)
```

| State | Entry condition | Exit condition |
|-------|-----------------|----------------|
| **CREATED** | Table parameters fixed. | Seats opened → FILLING. |
| **FILLING** | Accepting deposits/seats. | `min_players` deposited *and* (table full **or** fill deadline reached) → SEALING. If `< min_players` at fill deadline → VOID (full refund). |
| **SEALING** | Seats frozen; button assigned via VRF (§5). | All seated players have submitted a valid time-lock-encrypted prediction sealed to `timelock_target`, or the seal deadline is reached. Non-sealers are removed and refunded; if `< min_players` remain → VOID. Then → LIVE. |
| **LIVE** | Blinds posted (§6); market clock starts. | End of Round III betting and elapse of the match clock → SETTLEMENT_WINDOW. |
| **SETTLEMENT_WINDOW** | Final `settlement_window` seconds; oracle samples collected (§11). | Window elapses; `S` computed → DECRYPT. |
| **DECRYPT** | Time-lock opens; all predictions auto-decrypt deterministically (§12). **No player action required.** | All sealed predictions decrypted and verified as bound-before-LIVE → SETTLED. |
| **SETTLED** | Pots computed (§9) and paid (§10). | Terminal. Funds claimable. |
| **VOID** | Any unrecoverable fault (insufficient players, oracle failure per §11, fatal desync). | Full pro-rata refund of remaining stacks + contributions; no rake. Terminal. |

Once LIVE is entered, deposits are locked until SETTLED or VOID.

---

## 4. Seating, identity, and capital lock

- A player's authenticated Solana wallet is their identity for the match (wallet auth defined in `GAME_REQUIREMENTS`).
- **Deposit is the first eligibility step and the anti-spam gate.** A seat is granted only upon **on-chain deposit finality** of `buy_in` (in `chips_token`) into the match vault PDA — in **both** public matchmaking and private rooms. No deposit, no seat; this prevents seat-squatting, spam, and Sybil lobby flooding. Seat-reservation races are resolved by deposit finality ordering; a player whose deposit does not finalize before the fill deadline is not seated and is refunded.
- Buy-in becomes the starting stack at the fixed `chips_per_unit`.

---

## 5. Button & blind positions (verifiable randomness)

- At SEALING entry, the dealer button is assigned by **VRF** seeded from an on-chain randomness source; the seed and proof are recorded in the audit log.
- Positions proceed clockwise from the button. Because each match is an independent, fresh-buy-in game (often with new opponents), the button is assigned **once per match**; it does **not** rotate between rounds.

---

## 6. Blinds & antes (posted once)

- Blinds are posted **once**, at the start of Round I, by the Small Blind and Big Blind positions. They are **not** re-posted in Rounds II or III.
- If an ante > 0 is configured, each player antes once at Round I start.
- **Heads-up (2 players):** the button posts the Small Blind. (Action order in §7.)
- **Sub-blind stack:** a player whose stack is smaller than the blind they owe posts all-in for less; a side pot forms normally (§9).
- The blind schedule is tied to the tier so the starting stack is ≈100 big blinds; the exact schedule per tier is published table metadata. **Launch default: a flat schedule (no per-round escalation), ante 0.** Escalation and antes are configurable and revisited only if pots prove too small in playtest.

---

## 7. Betting streets, action order, and the action set

### 7.1 Round timing model
Each round has a fixed wall-clock duration (default 4 / 3 / 3 minutes; **round count and per-round durations are configurable — §2**). Within a round:

1. **Betting window** opens at round start. Players act in turn (§8). It **closes** when betting is resolved: every non-folded player has either matched the highest contribution for the street, checked (no outstanding bet), or is all-in.
2. **Observation window** is the remainder of the round after betting closes: the market moves, the chart updates, no betting occurs. Conviction shifts here.
3. If the betting window has **not** closed when the round's wall-clock expires, pending players are auto-resolved (auto-check if not facing a bet, else auto-fold) in turn order until the street closes. (Safety net; the timer budget makes this rare.)

The pot accumulates across all streets (default three). Side pots are **computed once at settlement** from cumulative contributions (§9) — they are not frozen per street.

### 7.2 Action order
- **3–5 players:** Round I first actor is the player left of the Big Blind. Rounds II–III first actor is the first non-folded player left of the button.
- **Heads-up:** Round I first actor is the button/Small Blind; Rounds II–III first actor is the Big Blind (button acts last).
- Exactly one player acts at a time; action proceeds clockwise among non-folded, non-all-in players.

### 7.3 Action set
The complete legal action set is **{Fold, Check, Call, Bet/Raise, All-In}**. Blinds and antes are forced posts performed by the engine, not elective actions.

| Action | Legality | Effect |
|--------|----------|--------|
| **Fold** | Always. | Player exits the hand. Forfeits all contributed chips. **Prediction is mucked — never revealed mid-match.** Cannot re-enter. Becomes a spectator of the match. |
| **Check** | Only when no outstanding wager faces the player on this street. | Passes action; commits no chips. |
| **Call** | When an outstanding wager exists. | Matches the highest street contribution, capped at the player's stack (a call that exhausts the stack is an All-In). |
| **Bet / Raise** | Bet: when no wager faces the player. Raise: when one does. | Increases the wager. **Minimum legal raise** = the size of the previous bet or raise increment on that street (standard no-limit). A full legal raise reopens action to players who have already acted. |
| **All-In** | Always. | Commits the player's entire remaining stack. May create side pots (§9). The player takes no further actions but remains eligible for every pot they contributed to. |

### 7.4 Raise/re-open rules
- A raise must be ≥ the minimum legal raise unless the raiser is going All-In for less (an under-raise all-in does **not** reopen betting to players who have already acted; they may only call or fold).
- A player facing an all-in may raise only if they are not themselves all-in and the all-in constituted a full legal raise.
- There is no cap on number of legal raises (no-limit), bounded only by stacks and timers.

---

## 8. Action timer, timeouts, disconnects

- Each turn has an `action_timer` (**default 25s**) and a per-player **replenishing time bank** (**default 60s**). *How the replenishing bank works:* the bank is drawn down **only** when a player exceeds their 25s turn timer — a player acting at normal pace never touches it. The bank then **refills** by a configured amount at the start of each round, so the cushion is restored for genuinely hard decisions later in the match rather than being a one-time reserve that, once spent, leaves the player exposed for the rest of the game. The turn length, bank size, and refill amount are all **configurable for tuning during testing**.
- **Pre-signed default action (anti-timer-collapse).** A player may register a **pre-signed default action** held by the backend — e.g., *check/fold* (check when free, else fold) or *check/call-any* — that the engine submits on their behalf the moment their turn times out. Because it is signed by the player, it enters the action log as a genuine player intent (preserving attribution and deterministic replay), and it keeps the match moving without waiting on a slow or absent player. This is the player's chosen fallback.
- **On timeout with no pre-signed action set:** the engine applies the safe system default — auto-**check** if the player faces no wager; auto-**fold** only if the player faces a wager. A free check is never converted to a fold.
- **Disconnect** is treated exactly as inaction → the pre-signed action (or, absent one, the safe default) applies. A player who is **all-in needs no actions and is never folded** for disconnection.
- **Reconnection** restores full control of the seat at any time before SETTLED.
- **Reveal needs no player action:** predictions auto-decrypt via the time-lock at match end (§12), so a disconnect can never cost a player their reveal or their winnings.

---

## 9. Pot construction & side-pot algorithm (deterministic)

Side pots are computed **once**, at settlement, from each player's cumulative contribution `c_i` and fold status. Folded players' chips are "dead money" that remain in the lowest pot layers they reached.

**Algorithm:**
1. Let `C = { c_i }` be every player's total contribution (folded and not). Let `A` be the sorted set of distinct positive contribution amounts, ascending: `a_1 < a_2 < … < a_k`.
2. `prev = 0`. For each `a_j`:
   - `height = a_j − prev`.
   - `contributors = { i : c_i ≥ a_j }`.
   - **If `|contributors| == 1`:** this layer is an **uncalled bet** → return `height` to that sole contributor; do **not** form a pot.
   - **Else:** form pot `P_j` of amount `height × |contributors|`. Its **eligible winners** = `{ i ∈ contributors : i did not fold }`.
   - `prev = a_j`.
3. Apply rake to each formed pot (§14).
4. **Award each pot `P_j`** to the eligible winner with the smallest `|p_i − S|` (§11–§13). If a pot has exactly one eligible winner, that player wins it without a contested showdown (the number still auto-opens at match end; §12).

**Conservation check:** sum of all pot amounts + returned uncalled bets = sum of all `c_i`. (Verified at settlement; failure → VOID.)

### Worked example
Four players. Cumulative contributions: **D = 20 (folded)**, **B = 60 (all-in)**, **A = 100 (all-in)**, **C = 100 (called)**. Thresholds: 20, 60, 100.

| Layer | Height | Contributors | Pot | Eligible (non-folded) |
|-------|--------|--------------|-----|------------------------|
| 1 | 20 | {D,B,A,C} (4) | 80 | {B,A,C} |
| 2 | 40 | {B,A,C} (3) | 120 | {B,A,C} |
| 3 | 40 | {A,C} (2) | 80 | {A,C} |

Total pots = 280 = 20+60+100+100. ✓ Each pot goes to the closest prediction among its eligible set. D's 20 is dead money in Layer 1 only. If A had contributed 120 and no one matched the last 20, that 20 would be **returned to A** (uncalled), not placed in a pot.

---

## 10. Distribution & claim

At SETTLED, the on-chain program distributes, per the §9 result: each pot to its winner, uncalled bets to their contributors, rake to the rake account. Every player's claimable amount = (remaining stack never committed) + (pots won) + (uncalled returns). Players claim from the vault PDA. Distribution is idempotent: re-submission cannot double-pay.

---

## 11. Settlement price `S` (pull oracle, window-median, fault handling)

**`S` is the single most security-critical value in the game and is defined precisely:**

- **Source:** a **pull-based** price oracle for `price_feed_id`, accessed through a **modular oracle adapter**. Prices are *pulled* on demand (the latest signed update is fetched and posted/recorded on-chain at sampling time), and the adapter is provider-agnostic — any provider can be plugged in or upgraded **without changing settlement logic**. The feed may be crypto, equity, commodity, or FX — anything the chosen provider supports. The match records the adapter, feed ID, and every sample used.
- **Locked default provider:** **Switchboard On-Demand** (pull-based, cost-effective, on-chain-verifiable signed updates). Its low-latency **Surge** tier may additionally drive the live chart. Pyth and others remain pluggable via the adapter, so a future provider switch is a config change, not a re-architecture.
- **Definition:** `S` = the **median of oracle samples taken across the `settlement_window`** (default the final 60 seconds of the match), using each sample's published price. A median over a window — not a single instantaneous print — eliminates knife-edge ticks and single-sample manipulation, and is robust to one bad print.
- **Sampling:** samples are taken at a fixed cadence (e.g., 1/second) at deterministic timestamps; all samples and timestamps are recorded for replay.
- **Confidence guard:** if the oracle's confidence interval exceeds a configured threshold, or the feed is stale beyond a max age, those samples are discarded. If too few valid samples remain in the window to compute a robust median (below a configured minimum), the match enters **VOID** and all capital is refunded (no rake). The market never decides a pot on a degraded feed.
- **Match-start reference price** is recorded identically at LIVE entry for UI and audit.
- **Anti-manipulation posture:** **configurable** buy-in/table caps (`max_buy_in`, default headroom up to ~$5M, set per feed below market-impact size) keep stakes from moving the underlying; the window-median makes a profitable last-second push require sustained pressure across the whole window. Detailed manipulation telemetry (cross-match correlation, settlement-window pressure detection) is **deferred to post-PFM** and tracked as a risk (see `RISK_REGISTER`); the cap mechanism is the v1 control.

---

## 12. Decryption & resolution (time-lock, automatic)

Predictions are sealed with **time-lock encryption** at SEALING and open **automatically** at match end. There is no manual reveal, no salt to submit, no reveal window to miss, and **no non-reveal failure mode** — which eliminates the entire reveal-griefing/disconnect-at-showdown risk class.

- At SETTLEMENT_WINDOW close, `S` is finalized and the **time-lock decryption key for `timelock_target` becomes publicly available** from the **drand `tlock` beacon (League of Entropy)**. The engine decrypts every sealed prediction deterministically, and decryption is verified on-chain (§18, `ARCHITECTURE`).
- **Binding check:** each decrypted prediction is verified to be the exact ciphertext the player submitted **before LIVE** (the ciphertext was recorded at SEALING), so no prediction could have been added or altered after betting began.
- **Sequential presentation:** for any **contested** pot (≥2 eligible survivors), the already-decrypted survivor numbers are unveiled one at a time to build tension. This is presentation only; the result is fully deterministic the instant decryption completes.
- **All ciphertexts open at `timelock_target`.** This is inherent to time-lock encryption: at match end every submitted prediction — including those of folded players and uncontested winners — becomes publicly decryptable and therefore independently auditable. Mid-match concealment (the only property that affects fairness) is fully preserved: nothing is decryptable before `timelock_target`. The deliberate trade-off is that post-match secrecy of an individual number is **not** preserved; matches are independent, so this is acceptable and strengthens auditability. (If post-match secrecy for uncontested winners is later desired, it is an enhancement, not a requirement — see `OPEN_QUESTIONS`.)
- **Liveness dependency:** the only new dependency is availability of the drand decryption key at match end. If the key is unavailable beyond a **~60s grace period (configurable)**, the match enters **VOID** with full refund (no fees). Beacon handling is specified in `ARCHITECTURE §2`.

---

## 13. Winner determination & ties

- Within each pot, the eligible winner is the one with the **smallest `|p_i − S|`** (exact integer distance).
- **Tie (equal distance, including equal-and-opposite):** the pot is split equally among tied eligible winners.
- **Indivisible remainder (odd chips):** awarded deterministically to the tied player with the **earliest prediction-seal timestamp** (rewards decisiveness; fully recorded). If timestamps somehow tie, fall back to lowest seat index from the button.

---

## 14. Fees (two points, both configurable)

Syndicate collects fees at **two points**, both disclosed pre-match and both **configurable** (the values are a business setting; the mechanism is fixed):

1. **Entry fee — on joining.** A configurable `entry_fee` is deducted when a player deposits into the match vault. It is *not* part of any stack or pot. If the match **VOIDs, or the player leaves before LIVE, the entry fee is refunded in full** — no game, no fee.
2. **Pot rake — at settlement.** `rake = min(rake_pct × pot, rake_cap)`, integer-floored, deducted from each **formed, contested** pot before it is awarded. Uncalled returns and VOID refunds are **never** raked.

These fees fund operations, including any platform-sponsored on-chain transaction costs (so players are not surprised by gas). Default values benchmark to online-poker norms (low single-digit %, capped on small pots) and are tunable per tier. The conservation invariant (§0) holds net of fees.

---

## 15. All-in & continuing market

- An all-in player commits their full stack, takes no further actions, and **remains eligible** for every pot they contributed to (§9).
- Because the prediction target is the price **at match end**, the market continues to evolve until match end (the configured duration) regardless of how early players go all-in. If all non-folded players are all-in before the final round ends, no further betting occurs and the match runs out to SETTLEMENT_WINDOW. (Run-out tension is a UI concern; see `GAME_REQUIREMENTS`.)

---

## 16. Uncontested resolution (the common poker outcome)

If at any point all players but one have folded, the lone survivor wins **every pot they are eligible for, immediately** — no showdown is needed. (Like all predictions, their sealed number still auto-opens at match end via the time-lock; it is simply irrelevant to the result.) This is correct poker behavior and is a *frequent* outcome. The product treats it as a designed "they folded; you took it down" beat rather than an anticlimax (see `BUILDER_VISION` and `GAME_REQUIREMENTS`). Any pot layers above the survivor's contribution that had other contributors are resolved among those contributors at settlement per §9; pure uncalled excess is returned.

---

## 17. Degenerate & fault states (all defined)

| State | Rule |
|-------|------|
| `< min_players` at fill/seal deadline | VOID; full refund. |
| Player never seals a prediction | Removed + refunded before LIVE; match proceeds if ≥ `min_players`. |
| All remaining players auto-fold in the same window | Resolve by uncontested rule to the last to forfeit; if literally none remain, VOID pro-rata to contributors. |
| Betting unresolved at round wall-clock expiry | Auto-resolve pending players (check/fold) in turn order; street closes. |
| Oracle degraded beyond guard (§11) | VOID; full refund, no rake. |
| Time-lock decryption key unavailable at match end | Wait a bounded grace period; if still unavailable → VOID, full refund, no rake (§12). |
| Fatal engine desync (signed log cannot replay) | VOID; refund from last verifiable state; incident logged. |
| Duplicate settlement submission | Idempotent no-op (§10). |

**There are no undefined states.** Every reachable condition above maps to a deterministic transition.

---

## 18. Determinism & replay (binding requirement)

The settlement is a pure function:

```
SETTLE( signed_action_log, { sealed_prediction_i }, timelock_key, oracle_samples, vrf_seed, table_config )
        → { pot_awards, returns, rake }
```

- Every player action — including pre-signed default actions executed on timeout — is a **signed intent** appended to an ordered, hash-chained log.
- The time-lock ciphertexts (recorded at SEALING), the published time-lock key, the VRF seed/proof, the table config, and all oracle samples with timestamps are recorded.
- Anyone with these inputs can recompute the identical result. The on-chain program validates the submitted settlement against the committed state before releasing funds. If recomputation disagrees, funds are not released and the match is escalated/VOIDed.
- **On-chain verification is non-negotiable.** Deposits and settlement occur on-chain, and the chain performs full settlement re-computation/verification before any payout. This is treated as a core user-trust guarantee — it is never traded away for cost or latency.

---

## 19. Strategic dimension (where the game lives)

Syndicate asks players to optimize three things at once, but the **edge concentrates in the middle one**:

1. **Predictive view** — choosing a number. Over a 10-minute horizon this carries limited skill signal; rational play produces dispersion only when a player holds a genuine micro-view.
2. **Capital allocation** — *the primary skill:* bet sizing, fold discipline, pressure, pot control, and reading conviction under hidden, symmetric information. This is where long-run results are made.
3. **Psychological read** — interpreting the shared market and opponent behavior without ever seeing their numbers.

Victory over volume comes from the synthesis — and predominantly from (2). This is stated plainly so that design, telemetry, and marketing all reinforce the same truth (see `BUILDER_VISION`).

---

## 20. Public match data feed (player action transparency)

**Evaluation (point 7 — adopt: net-positive).** A public, real-time + historical feed of player **actions** — *for this `price_feed_id`, at this market price, player X wagered Y, pot is now Z, player W folded* — is **included in v1** because it strengthens the product at near-zero marginal cost (the data already exists in the signed action log) and it does so without weakening any integrity invariant:

- **Spectator pull & virality:** the chart + the betting is the spectacle. Railbirds, clips of big all-ins, and shareable hands drive discovery and adoption — the emotional hook of "skin in the game" even before any spectator *wagering* exists.
- **Trust as a premium feature:** a timestamped, independently-verifiable public action history reinforces the "provably fair / institutional" positioning. Transparency *is* the brand.
- **Player learning & retention:** observers learn the meta by watching, which deepens the player funnel.
- **Foundation for the deferred spectator market:** this feed is exactly the seam the Phase-2 spectator market would build on (§21).

**Hard constraints (what the feed must never do):**
1. **Never expose a sealed prediction** before `timelock_target`. Predictions are time-lock encrypted and remain unreadable to everyone, including spectators, until match end (§12) — this is non-negotiable and unaffected by the action feed.
2. **No new advantage to active players.** The feed exposes only information already public at the table (bets, pot, folds, market price). It must not leak private metadata, queued intents, pre-signed defaults, or anything enabling collusion or timing advantage.
3. **Pseudonymous.** Actions are attributed to a wallet/handle, never to PII.
4. **Read-only and isolated.** Served on a separate read path that can never contend with or stall active gameplay (capacity requirement carried in `ARCHITECTURE`).

The feed therefore publishes, per match: the feed/price at each action, bet/raise/call/all-in amounts, pot evolution, fold events, round transitions, final settlement price, pot awards, and the predictions that become decryptable at match end — and nothing else.

---

## 21. Deferred modules (architectural seam only)

The **spectator prediction market** is **out of scope for v1** by founder decision. The engine exposes a read-only, public event stream (market state, actions, pot sizes, fold events, revealed numbers at settlement) sufficient for a future spectator layer to be built without changing core settlement. No spectator market rules are specified or implied by this document. Regulatory treatment of all wagering is explicitly deferred and tracked in `OPEN_QUESTIONS`.

---

## Appendix A — End-to-end determinism checklist
- [ ] VRF seed + proof recorded at SEALING.
- [ ] All time-lock-encrypted predictions recorded (sealed to `timelock_target`) before LIVE.
- [ ] Every action a signed, ordered, hash-chained intent (incl. pre-signed defaults executed on timeout).
- [ ] All oracle samples + timestamps recorded via the modular pull adapter (full settlement window included).
- [ ] `S` = window median, with confidence/staleness guards applied.
- [ ] Side pots computed by §9; conservation verified.
- [ ] Predictions auto-decrypted via time-lock; each verified as bound-before-LIVE.
- [ ] On-chain settlement validated against recomputation before fund release.
- [ ] Idempotent distribution.
