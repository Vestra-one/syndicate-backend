# Syndicate — Core Game Mechanics

## Overview

**Syndicate** is a multiplayer, prediction-driven wagering game that combines elements of financial forecasting with strategic betting dynamics inspired by traditional poker.

Each match accommodates **2 to 5 participants**, who compete by forecasting the future market price of a designated asset while simultaneously engaging in sequential betting rounds. Success in Syndicate requires both predictive accuracy and superior capital allocation strategy under uncertainty.

---

## 1. Match Structure

A standard Syndicate match spans **10 minutes** and is divided into **three discrete rounds**:

| Round     | Duration  |
| --------- | --------- |
| Round I   | 4 minutes |
| Round II  | 3 minutes |
| Round III | 3 minutes |

The cumulative duration of all rounds constitutes the complete lifecycle of a game.

---

## 2. Prediction Commitment Phase

Prior to the commencement of Round I, each participant submits a prediction representing the expected market price of the underlying asset at the conclusion of the 10-minute match.

To preserve strategic integrity and eliminate informational asymmetry:

* Predictions are **cryptographically committed and encrypted** before gameplay begins.
* No participant may view another player's prediction during active gameplay.
* All submitted predictions remain concealed until the match concludes.

This mechanism ensures that betting decisions throughout the game are based solely on observed market behavior and player conviction rather than disclosed forecasts.

---

## 3. Betting Rounds

Each round incorporates a competitive wagering phase governed by a betting framework analogous to no-limit poker.

Participants may perform the following actions during their turn:

* **Small Blind**
* **Big Blind**
* **Check**
* **Call**
* **Raise**
* **Fold**
* **All-In**

Betting continues sequentially until all active participants have either:

1. Matched the highest outstanding wager,
2. Checked when no additional wager exists,
3. Folded from the hand, or
4. Committed their entire available stake through an **All-In** action.

The aggregate of all committed wagers forms the **match pot**.

---

## 4. All-In Mechanics

At any point during a betting round, a participant may elect to move **All-In**, thereby committing their entire remaining stack to the pot.

The introduction of the All-In action creates a high-conviction strategic layer within the game:

* Players may utilize an All-In move when they possess strong confidence in their concealed prediction.
* Conversely, an All-In may also serve as a psychological instrument intended to pressure opponents into folding.

Upon an All-In action:

* Remaining participants must decide whether to **Call**, **Raise** (where applicable under table rules), or **Fold**.
* Players who cannot fully match the All-In amount participate only for the portion of the pot to which they have contributed, with any excess handled through standard **side-pot** mechanics.
* A participant who has moved All-In remains an active contender for all pots for which they are eligible, even though they no longer participate in subsequent betting actions.

An All-In player continues to remain exposed to market movements until final settlement and retains full eligibility to win the corresponding pot(s) if their final prediction proves superior.

---

## 5. Conviction Dynamics

Unlike traditional poker, player conviction in Syndicate is continuously influenced by real-time market movements.

As the market evolves during the match:

* Market movements trending toward a participant's concealed prediction are expected to strengthen conviction, incentivizing larger wagers and more aggressive betting behavior.
* Market movements diverging from a participant's anticipated outcome may reduce confidence, encouraging defensive play, conservative capital deployment, or strategic withdrawal through folding.

Consequently, participants must continuously reassess their position and optimize their betting strategy under evolving market conditions.

---

## 6. Round Transition Rules

A betting round concludes when all active participants have completed their betting actions in accordance with standard poker settlement rules.

If all remaining players elect to **check** prior to the expiration of the current round, no further betting occurs during that round. Participants remain in the game and advance collectively to the subsequent round once the scheduled round timer expires.

If all remaining active participants have moved **All-In**, no further betting actions are permitted. The match proceeds automatically through the remaining rounds while the market continues to evolve until final settlement.

The market remains observable throughout the entirety of each round.

---

## 7. Revelation and Settlement

At the conclusion of the third round and upon expiration of the 10-minute match duration:

1. All surviving participants—defined as players who have not folded—reveal their previously encrypted price predictions.
2. Predictions are decrypted and verified against their original commitments.
3. Each revealed prediction is evaluated against the realized market price at the exact end of the match.

The participant whose prediction exhibits the **smallest absolute deviation** from the realized settlement price is declared the winner.

---

## 8. Pot Distribution

The total accumulated pot is awarded to the participant whose revealed prediction is closest to the final market settlement price.

Where one or more All-In actions have created side pots:

* Each pot is independently evaluated among the participants eligible for that specific pot.
* The eligible participant with the closest prediction to the final settlement price wins the corresponding pot.

In the event of a tie, predefined tie-resolution procedures (e.g., split-pot settlement or precision-based tiebreakers) shall be applied according to table rules.

---

## Strategic Dimension

Syndicate creates a unique competitive environment in which players must simultaneously optimize across three dimensions:

1. **Predictive Accuracy** — forecasting the terminal market price.
2. **Capital Allocation** — determining optimal wager sizing throughout the match.
3. **Psychological Strategy** — interpreting market evolution and opponent behavior under incomplete information.

Victory therefore emerges not solely from accurate forecasting, but from the effective synthesis of prediction, risk management, and strategic wagering.
