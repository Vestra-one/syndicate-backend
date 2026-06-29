> **⚠️ DEPRECATED / STALE — not authoritative for current behavior.** This predates the v1 implementation and may describe a different game (e.g. Switchboard/Pyth oracle, median-60s, session-keys). Trust the **code** and `docs/V1_COMPLETION_CHECKLIST.md` instead.

# Syndicate — End-to-End Player Experience (Canonical Requirements)

**Status:** Canonical `SYNDICATE_GAME_REQUIREMENTS.md`, v1.0. Describes the complete player experience, every flow, and every failure path, from the player's point of view. Rules referenced here are defined authoritatively in `GAME_MECHANICS.md`; this document governs experience, UX guarantees, and flow completeness.

**Player promise:** *"I competed in an elite arena where conviction, capital, and nerve — not luck alone, and never a rigged system — determined the outcome."*

---

## 0. The experience in one paragraph

A player connects a Solana wallet, picks a stake, deposits to claim a seat, and privately seals a single number: where they think the price feed will settle in ten minutes. That number is locked by **time-lock encryption** — no one, not even Syndicate, can read it or change it, and it opens by itself at match end. Across three betting streets, the market moves in front of everyone, and the player bets their hidden conviction like a poker hand: pressuring, folding, calling, going all-in. The hand ends one of two ways — opponents fold and the player takes it down, or survivors' numbers auto-open and the closest to the settlement price wins each pot they earned. Funds settle on-chain, verifiably, and the player claims and plays again.

---

## 1. Canonical journey

```
Discover → Connect Wallet → Choose Stake / Room → Deposit (seat reserved, anti-spam)
   → Lobby → Seal Prediction (time-lock) → Round I → Round II → Round III
   → Settlement Window → Auto-Decrypt → Resolution (Showdown OR Uncontested) → Claim → Next Match
```

Every step has a defined success path and a defined failure/refund path (§13).

---

## 2. Discovering a match

Two modes:

**Public matchmaking.** The player selects a buy-in tier, a **price feed** (the instrument to predict), and the **betting token**, joins a queue, and is auto-assigned to a forming table. A **refundable deposit is required to enter the queue** — the anti-spam gate (§4). Matchmaking must enforce **anti-Sybil and bot defenses** (one verified identity per seat; rating buckets so casual players are not farmed by predatory bankrolls). Skill bucketing and proof-of-personhood are requirements, not nice-to-haves (rationale and method in `OPEN_QUESTIONS` / `ARCHITECTURE`).

**Private room.** A host creates a room (feed + token + tier) and shares a Room ID. Only invited players join, and **each must deposit to be seated** (same anti-spam gate). The host may cancel before the match goes LIVE (all deposits refunded). If the host disconnects before start, the room either auto-starts at its deadline (if ≥ 2 sealed) or VOIDs and refunds.

**Live-games dashboard (primary discovery surface).** The home surface is a dashboard of currently-live games. Games are **ranked by popularity** — a "rated" ordering (e.g., spectator count and betting activity), most-watched on top — and the player can **sort by game time, pot size, buy-in, feed, or other key metrics**. It is also the spectator entry point and is powered by the public action feed (§14).

**Filling tables.** Tables fill **manually** — via scheduled play times and organic/community demand. **No house bots ever pose as players or seed tables**; integrity is chosen over a faster cold start.

**Availability (geofencing).** Access is **geofenced**: players connecting from restricted jurisdictions are blocked at entry. Full regulatory classification is handled separately; geofencing is the v1 control.

---

## 3. Wallet connection & identity

```
Connect Wallet → Receive Nonce → Sign Nonce → Verify Signature → Authenticated Session
```

The connected wallet is the player's identity for the match and the destination for settlement. The session signs gameplay intents so every action is attributable and replayable. The player can always view wallet balance and match exposure.

---

## 4. Choosing a stake and reserving a seat

Joining and funding are a single flow; there is **no persistent off-chain chip balance** — every match is a fresh on-chain deposit.

```
Select Table (feed + token + tier) → Review Table Terms → Deposit Buy-In → Seat Reserved on Deposit Finality → Enter Lobby
```

**Deposit is the first step and the eligibility gate** — in both public and private play, no one is seated until their buy-in has finalized on-chain. This prevents spam, seat-squatting, and Sybil lobby flooding. Before depositing, the player sees and accepts the immutable table terms: the **price feed** (the instrument predicted — crypto, equity, commodity, or FX, anything the oracle supports), the **betting token** (e.g., USDC; need not match the feed), buy-in, starting stack (in chips), blind schedule, ante (if any), **rake**, player capacity, action timer, and match length. **Nothing financial is hidden or changeable after the match starts.** The deposited amount becomes the starting stack. A seat is confirmed only on deposit finality; if finality does not occur before the fill deadline, the player is not seated and is automatically refunded.

**Launch offering:** the **USDC** betting token, **three buy-in tiers**, and a **no-stakes practice mode** (identical rules, no real capital) for onboarding. A small, configurable **entry fee** is shown and applied at deposit, alongside the pot rake taken at settlement (both disclosed up front; §6).

---

## 5. The lobby

After deposit, the player waits in a pre-match lobby showing: table type, feed, betting token, buy-in, current vs. maximum players, match status, countdown to start, and personal starting stack.

- Minimum 2, maximum 5 players (configurable defaults).
- Before the match goes LIVE, a player may leave and reclaim their full deposit; a private-room host may cancel (full refunds).
- If the table does not reach 2 players by the fill deadline, it VOIDs and everyone is refunded.
- Once LIVE, no new players may join and deposits are locked until settlement.

The lobby should feel ceremonial — admission to an elite chamber — not a loading screen.

---

## 6. Capital model (what the player sees)

```
Deposit 100 USDC  →  Starting Stack 100 chips (at the table's chips_per_unit)
```

Throughout the hand: bets reduce available chips; folding forfeits chips already committed; all-in commits the entire remaining stack. At the end:

```
Claimable = Uncommitted Stack + Pots Won + Returned Uncalled Bets
            (entry fee already applied at join; pot rake already deducted from contested pots — both disclosed up front)
```

The player always sees, in real time: remaining stack, amount committed this street, total exposure, and current pot size. **No capital action is ever ambiguous.**

---

## 7. Seal your prediction (the time-locked conviction)

Before the first street, every player privately seals one number — the feed's price at the exact end of the match.

```
Enter Predicted Price  →  Client time-lock-encrypts it (opens only at match end)  →  Sealed ciphertext recorded  →  "Conviction Sealed"
```

Guarantees the player is shown and can trust:
- The number is **sealed** before any betting — provably it cannot be changed later.
- No one — no opponent, no spectator, not Syndicate, and no key-holder (there is none) — can read it while the match is live.
- It **opens by itself at match end** via the time-lock — there is no manual reveal step, nothing to click, and nothing a disconnect can make you miss. At match end all sealed numbers become publicly verifiable; before then, none are readable by anyone.

This is the most weighty private moment of the match and the UI should treat it with gravity. A player who fails to seal before the deadline is removed and refunded (the match continues if ≥ 2 players sealed).

---

## 8. The match: three streets, one shared market

Total length 10 minutes — Round I (4m), Round II (3m), Round III (3m) at launch (all timings are configurable so the format can be tuned toward product-market fit). The market updates continuously and is visible to all throughout.

**Each round has a rhythm:** a **betting window** (players act in turn) followed by an **observation window** (the market moves; conviction shifts; no betting). Blinds are posted **once**, at the start of Round I, and do not repeat. The pot grows across all streets and is resolved once, at the end.

**During the player's turn**, the available actions are exactly: Fold, Check, Call, Bet/Raise, All-In — with full exposure clarity before committing. A per-turn timer (default 25s) plus a replenishing time bank (default 60s, refilled each round) keep pace premium but fair — both configurable.

- **Pre-signed default action:** to never lose the table to a slow connection, a player can set a **pre-signed default** that the backend submits the instant their turn times out (it counts as their own signed move). Templates offered: **check/fold** (preselected) and **check/call-any**.
- **Timeout / disconnect:** with no default set, the system **auto-checks** when nothing is owed and **auto-folds only when facing a bet** — a free check is never turned into a fold. An all-in player needs no further actions and is never folded for disconnecting. The player can reconnect and resume their seat at any time.
- **Market-as-antagonist UI:** the player sees their live **distance to conviction** (how near the market is to their sealed number) as emotional feedback — without ever leaking anything about opponents' numbers.

**All-In** is a premium, exceptional moment: it commits the entire stack, may create side pots, and keeps the player eligible for every pot they funded. Because settlement is pinned to the 10-minute mark, the market keeps moving after an all-in — the run-out is presented as rising tension, not dead time.

---

## 9. Resolution — the two endings

**Ending A — Uncontested (the frequent poker outcome).** If everyone folds to one player, that player wins the pots they're eligible for **immediately** — no showdown needed. This is designed as a real beat: "they folded; you took it down." (Like all sealed numbers, the winner's opens automatically at match end via the time-lock; the win never depended on it.)

**Ending B — Contested showdown (the signature moment).** If two or more eligible players survive to the end:

```
Settlement Window (final 60s, market sampled)  →  Settlement Price S finalized
   →  Time-lock opens → survivors' numbers unveiled one at a time  →  Closest to S wins each pot they're eligible for
```

The unveiling is sequential and ceremonial — suspense, then prestige (a championship unveiling, never a slot-machine jackpot). The numbers auto-decrypt the moment the time-lock opens; the result is already deterministic and the pacing exists purely for emotion.

The product is honest that Ending A is common. The promise — *conviction under uncertainty, resolved with consequence* — is satisfied by both.

**Post-match, every sealed number opens** — the winner, the survivors, and players who folded or busted early, all alike (the time-lock opens them all at once). This is a deliberate emotional beat: folded players get to see how close they *would* have been ("I should have stayed" / "great laydown"), and spectators get the full reveal. It is presentation only — nothing about settlement depends on a folded player's number.

---

## 10. Settlement price (what the player is told)

The winning comparison uses a settlement price `S` that is the **median of a pull-based decentralized oracle (provider-swappable — Pyth, Switchboard, …) over the final 60 seconds** — not a single instant. Players are told plainly: a last-second tick cannot decide the pot, no one (including Syndicate) can move or pick the number, and every sample is recorded so anyone can verify the result. If the price feed degrades beyond safe limits, the match is **voided and fully refunded** rather than settled on bad data.

---

## 11. Winner determination (what the player sees)

Within each pot, the eligible survivor whose sealed number is closest to `S` wins it. A player can only win chips matched against their own contribution (standard side-pot rules), so a small bettor can never scoop a large all-in they didn't match.

```
| Player | Prediction | S       | Distance |
| Alice  | 105000     | 105120  | 120      |  ← wins the pots she is eligible for
| Bob    | 105300     | 105120  | 180      |
```

Ties split the pot equally; an indivisible odd chip goes to the earliest-sealed of the tied players (decisiveness is rewarded).

---

## 12. Settlement, claim, and history

```
Replay & Verify signed actions + time-lock-decrypted predictions + oracle samples  →  Compute pots (deterministic)
   →  Validate on-chain against sealed state  →  Distribute  →  Claimable
```

After settlement the player can claim winnings/withdraw and review a complete, auditable match record: initial deposit, chips committed, pots won, rake paid, final balance, settlement price, oracle samples, and the settlement transaction. Distribution is idempotent — no double-pays, no silent failures.

A match is complete only when settlement is finalized **and** balances are updated. Then:

```
Review Results → Claim Funds → Join Next Match
```

---

## 13. Failure & refund paths (the player is never left in limbo)

| Situation | What the player experiences |
|-----------|------------------------------|
| Table doesn't fill to 2 by deadline | Match voided; full deposit refunded automatically. |
| Player leaves before LIVE | Full deposit reclaimed. |
| Private host cancels before LIVE | Full refunds to all. |
| Player fails to seal in time | Removed before start; refunded; match continues if ≥2 sealed. |
| Player disconnects mid-hand | Their pre-signed default (or the safe auto-check/auto-fold) protects them; can reconnect and resume; all-in stake is safe and stays eligible. |
| Player disconnects before match end | Their prediction still auto-decrypts via the time-lock at match end — reveal needs no action, so a disconnect can never cost them a won pot. |
| Oracle feed degrades | Match voided; full refund; no rake. |
| Time-lock can't open at match end | After a short grace period the match is voided; full refund; no rake. |
| Any fatal system fault | Refund from last verifiable state; incident recorded. |

Every path returns capital deterministically. Capital safety supersedes feature velocity, always.

---

## 14. Spectating & the public action feed (v1 scope)

External users and folded players may **watch** live matches through a **public action feed**: the price feed and its live chart, every betting action with **amounts** (who bet/called/raised/went all-in for how much), pot evolution, fold events, round transitions, the settlement price, pot awards, and the predictions that auto-open at match end. This transparency is a deliberate v1 feature — it makes matches watchable and shareable, reinforces "provably fair," and lets newcomers learn the meta.

What spectators **never** see: any sealed prediction before the time-lock opens, queued intents or pre-signed defaults, or private metadata. Actions are shown pseudonymously (wallet/handle, never PII), and the feed is read-only and isolated so it can never slow active play.

**The real-money spectator prediction market is deferred (not in v1)** — the watch-and-learn experience ships; wagering *on* spectators does not.

---

## 15. Experience non-negotiables (acceptance bar)

A build is not shippable unless:
1. Every capital action shows exposure before commit; no financial surprises.
2. No prediction is readable by anyone — player, spectator, or operator — before the time-lock opens at match end.
3. Disconnects never auto-fold a free check and never endanger an all-in stake; a pre-signed default is always available.
4. Every match has a defined, automatic refund/void path; no player is ever stuck.
5. Settlement is independently verifiable by the player from the match record.
6. The uncontested win and the contested showdown are both designed as premium moments.
7. Positioning never claims the player will out-forecast the market — only that they will out-play the table over time.
8. The public action feed never leaks a sealed prediction or any information that gives an active player or colluder an edge.

---

## Core Player Promise

> *"Every Syndicate match is a fair, high-stakes contest of conviction, capital, and nerve. I win or lose on how I play — and I can prove the game never cheated me."*
