# Onboarding & the Aha Moment

Activation is the most leveraged number in the funnel: every Operator we fail to activate is paid-for attention that never enters a loop. This doc defines the single moment that converts a curious wallet into an Operator, and engineers the shortest possible path to it.

## The Aha is a *contested sealed-reveal* — not a signup

The "aha" is **not** connecting a wallet, funding USDC, or watching a tutorial. It is the first time an Operator **sits at a live table, SEALs a private conviction, sweats a real match against opponents, and watches the reveal open** — theirs and everyone else's. That single beat delivers the whole product in ~one match: hidden information, table read, drama, provable fairness, "how close was I?"

> If a new Operator has not reached a contested reveal, they have not experienced Syndicate. They have experienced a deposit form.

This is why the North Star is **Weekly Active Operators who reach a contested reveal** (`../00_foundation/growth_model_and_flywheel.md`). Onboarding's only job is to manufacture that moment, fast, for as many arrivals as possible.

## Time-to-Aha: the target

| Path | Target time-to-first-contested-reveal |
|------|----------------------------------------|
| Practice (no-stakes) reveal | **< 3 minutes** from first app load |
| First *real* seat reveal | **< 8 minutes** from first app load |
| Wallet connect → funded seat (returning) | **< 60 seconds** |

We measure from first app load, not from signup-complete — the clock the user feels is the only clock that matters.

## The activation funnel (CT/Blink → reveal)

```
CT clip / Blink (one-tap Action in a tweet)
   │   "A seat opened at the table." [Take a seat ▸]
   ▼
Landing / app load  ──────────────  (no email wall, no KYC gate pre-practice)
   ▼
Wallet connect (Phantom / Backpack, 1 tap)
   ▼
PRACTICE MODE — no-stakes seat  ◄── the aha can fire here, free
   │   first SEAL → first reveal in < 3 min
   ▼
First real seat  (fresh per-match USDC buy-in)
   │   deposit + on-chain finality, clear "Confirming…" state
   ▼
FIRST CONTESTED REVEAL (real stakes)  ★ ACTIVATED
   ▼
Prompt: join / found a House · join a Chamber
```

Two design rules govern the funnel:

1. **Let the aha fire before money.** Practice mode (no-stakes) exists so the dramatic reveal can land before we ask for a single USDC. We sell the *feeling* first; the deposit is the second yes, not the first.
2. **Every step is removable friction until the reveal.** No email, no KYC, no profile setup precedes practice. The only hard gate is geofencing for real-money play.

## Reducing wallet / deposit / finality friction

The Solana wallet-and-deposit step is where activation dies. Concrete mitigations:

- **Wallet:** native Phantom + Backpack deep-links and the in-tweet **Blink/Action** path — connect is one tap, no seed-phrase detour, no "download this extension" dead end on mobile.
- **Pre-funded practice:** practice seats require **zero** balance. A user with an empty wallet still reaches a reveal.
- **First real buy-in:** surface the smallest tier first; one-tap USDC buy-in; if balance is short, an inline on-ramp/swap Blink rather than ejecting them to a CEX.
- **The "Confirming…" state is sacred.** On-chain finality gates the seat, so the wait is real — we make it *legible* and *premium*, never a dead spinner:

> **Securing your seat** — your buy-in is being confirmed on-chain.
> `◔ Confirming · ~2s` → `✓ Seat secured. Conviction may now be sealed.`

Honest, branded, fast-feeling. The finality wait becomes a moment of gravity ("this is real, it's on-chain"), not a bug.

- **Never lose state on a rejected tx.** A failed/cancelled deposit returns to the table preview with the seat still held briefly — not to a cold home screen.

## The first-session script (the guided first match)

A scripted, ~3-minute practice hand that teaches by playing, not by reading. Copy is terse and in-voice.

1. **Open.** `Welcome, Operator. Take the empty seat.` (no-stakes table, 2 bots + open seats)
2. **SEAL.** `Seal your read: where does the market close? This is your hidden hand — no one can read it, not even us, until the match ends.` → Operator locks a prediction (time-lock/drand encrypted).
3. **Play the hand.** `Now bet it. Read the table. Hold your nerve.` — one or two betting rounds vs. the live market + table; surface fold equity and the pot.
4. **THE REVEAL.** All sealed predictions open. `Reveal. Here is every conviction at this table — including yours.` Show closeness ranking, the winning eligible read, side-pot payout.
5. **The hook line.** `That's a hand. Real seats pay in USDC, on-chain, provably fair. Ready for a live table?`

The script ends *on the reveal's afterglow* and immediately offers a real seat. We do not interrupt the aha with menus.

## The first prompt to join a House / Chamber

The moment **after the first contested reveal** is peak motivation — the Operator just felt status and drama. That is when we fire the progression spine's first social arrow (`progression_and_ranks.md`).

- **Default copy (post-first-reveal):**
  > `You're an Operator now. Operators don't sit alone. Join a House to play private tables with your crew — or found one and bring your own.` [Join a House ▸] [Found a House ▸]
- **If they arrived via a House Blink** (referred): auto-suggest *that* House — `Tarek's House invited you. Take your seat.` This closes the referral loop on the same session (`../03_virality_network_effects/viral_loops_and_referrals.md`).
- **Chamber prompt** is timed slightly later (after ~3 real seats), framed as team competition, not another signup: `Ready to play for a side? Chambers compete on the season board.` (`../03_virality_network_effects/chambers_and_houses.md`)

Sequencing matters: **House first** (invite/K-factor loop), **Chamber second** (team retention). Never both at once on session one.

## Activation metrics & targets

| Metric | Definition | Target |
|--------|------------|--------|
| **Practice-reveal rate** | % of wallet-connects that reach a practice reveal | **≥ 80%** |
| **Activation rate** | % of new wallets reaching a *real* contested reveal within 24h | **≥ 35%** (Phase 1), 45%+ at maturity |
| **Time-to-Aha (real)** | median first-load → first real reveal | **< 8 min** |
| **Deposit-success rate** | funded-seat attempts that confirm on first try | **≥ 90%** |
| **Confirming-abandon rate** | seats abandoned during on-chain "Confirming…" | **< 5%** |
| **Blink→activation** | Blink clicks that become activated Operators | **≥ 15%** |
| **First-House attach** | activated Operators who join/found a House same-session | **≥ 25%** |

**Leading indicator we watch daily:** practice-reveal rate. If users reach the practice reveal but don't convert to a real seat, the problem is deposit friction or stakes framing (fixable). If they don't reach the *practice* reveal, the first-session script or wallet step is broken (urgent).

## Anti-patterns (do not ship)

- A tutorial that explains the rules *before* the user feels a reveal. Show, don't claim (`../00_foundation/positioning_and_brand.md`).
- Casino/jackpot onboarding language. We onboard Operators into a sport, not marks into a slot machine.
- Gating practice behind a deposit, email, or KYC.
- Any onboarding that promises "out-predict the market." We frame skill honestly: **out-play the table.**

## Cross-references

- North Star & funnel context: `../00_foundation/growth_model_and_flywheel.md`
- Status payoff the aha unlocks: `../00_foundation/lexicon_and_status_system.md`
- Voice & anti-casino guardrails: `../00_foundation/positioning_and_brand.md`
- What retains the activated Operator next: `retention_engine.md`
- The climb the first seat begins: `progression_and_ranks.md`
- The House loop the first prompt ignites: `../03_virality_network_effects/viral_loops_and_referrals.md`
- Full metric tree: `../07_growth_ops_metrics/north_star_and_kpis.md`
