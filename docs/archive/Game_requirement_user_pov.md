# Syndicate — End-to-End Game Requirements

## Introduction

Syndicate is a premium multiplayer financial strategy game where players privately predict the future price of an asset while strategically wagering capital against one another.

The game combines:

* Financial prediction.
* Hidden information.
* Capital management.
* Psychological warfare.
* Poker-inspired wagering.
* Conviction under uncertainty.

The objective is simple:

> Predict the final market price more accurately than your opponents while surviving the betting rounds.

---

# Core Game Principles

Syndicate is governed by two independent systems:

## 1. Prediction Layer

Players privately predict the final market price.

Prediction accuracy ultimately determines the winner.

## 2. Poker Layer

Players strategically wager capital using traditional No-Limit Poker mechanics.

Poker determines:

* Capital exposure.
* Survival.
* Pot composition.
* Psychological pressure.

Only players who survive until the end of the match are eligible to compete for final settlement.

---

# Player Journey

```text
Discover Match

↓

Connect Wallet

↓

Select Table

↓

Deposit Funds To Join

↓

Enter Lobby

↓

Commit Prediction

↓

Round 1 Betting

↓

Round 2 Betting

↓

Round 3 Betting

↓

Final Reveal

↓

Settlement

↓

Claim Funds
```

---

# 1. Discovering A Game

Players may participate through one of two modes.

## Private Room

Characteristics:

* Invite only.
* Users receive a Room ID from friends.
* No external participants.
* Intended for communities and private groups.

Player flow:

```text
Receive Room ID

↓

Enter Room ID

↓

Join Private Table
```

---

## Public Matchmaking

Characteristics:

* Open participation.
* Automatic seat assignment.
* Public player pool.

Player flow:

```text
Select Buy-In Tier

↓

Join Matchmaking Queue

↓

Automatic Table Assignment
```

---

# 2. Wallet Connection

Before participating, players must connect and authenticate a Solana wallet.

Supported actions:

* Connect Wallet.
* Authenticate Ownership.
* Sign Gameplay Intents.
* View Wallet Information.

Authentication flow:

```text
Connect Wallet

↓

Receive Nonce

↓

Sign Nonce

↓

Verify Signature

↓

Authenticated Session
```

The connected wallet becomes the player's identity throughout the match.

---

# 3. Joining A Game

Joining a game and funding participation occur as a single unified flow.

Players do not maintain a persistent off-chain chip balance.

Instead, every match requires a fresh deposit.

Player flow:

```text
Select Table

↓

Choose Buy-In

↓

Deposit Funds

↓

Seat Reserved

↓

Enter Lobby
```

Examples:

```text
10 USDC Buy-In

25 USDC Buy-In

100 USDC Buy-In
```

The deposited amount becomes the player's starting stack.

---

# 4. Funding Participation

To participate, players must deposit funds on-chain.

Requirements:

* Deposits occur during table entry.
* Funds move into the Syndicate vault.
* Seats are confirmed only after deposit finality.
* Deposited capital becomes the player's starting chips.

Players cannot join without depositing funds.

If a game fails to start:

```text
Players may reclaim their entire deposit.
```

---

# 5. Table Lobby

After successful deposit, players enter the pre-game lobby.

Visible information:

* Table Type.
* Buy-In Amount.
* Number of Players.
* Maximum Capacity.
* Current Participants.
* Match Status.
* Countdown To Start.
* Personal Starting Stack.

Constraints:

```text
Minimum Players: 2
Maximum Players: 5
```

Before game start:

* Players may leave.
* Players may reclaim deposited funds.
* Hosts may cancel private rooms.

After game start:

* No new players may join.
* Deposits remain locked until settlement.

---

# 6. Capital Model

Each player's starting stack equals their deposited amount.

Example:

```text
Deposit: 100 USDC

Starting Stack: 100 Chips
```

Throughout gameplay:

* Bets reduce available chips.
* Folding forfeits committed chips.
* All-In commits all remaining chips.

Final claimable amount:

```text
Remaining Chips

+

Winnings

=

Claimable Amount
```

---

# 7. Prediction Commitment Phase

Before gameplay begins, every player privately predicts:

> The market price at the exact end of the 10-minute match.

Example:

```text
BTC Final Price

107,542.73 USD
```

Requirements:

* Predictions remain hidden.
* Predictions are encrypted client-side.
* Predictions cannot be modified after submission.
* Backend cannot access plaintext predictions.

After submission:

```text
Prediction Locked
```

---

# 8. Match Structure

Total Match Duration:

```text
10 Minutes
```

Structure:

| Round     | Duration  |
| --------- | --------- |
| Round I   | 4 Minutes |
| Round II  | 3 Minutes |
| Round III | 3 Minutes |

Market prices update continuously throughout all rounds.

---

# 9. Blind Structure

Syndicate follows standard No-Limit Poker blind mechanics.

At the start of each round:

* One player posts the Small Blind.
* One player posts the Big Blind.

Purpose:

* Seed the pot.
* Create action.
* Prevent passive play.

Example:

```text
Small Blind = 1 Chip

Big Blind = 2 Chips
```

Blind positions rotate clockwise among active players at the start of every round.

Example:

```text
Round 1

Player A → Small Blind
Player B → Big Blind

Round 2

Player B → Small Blind
Player C → Big Blind

Round 3

Player C → Small Blind
Player D → Big Blind
```

---

# 10. Betting Framework

Syndicate follows traditional No-Limit Poker wagering rules.

All betting actions, turn order, raises, and betting progression must conform to standard poker mechanics.

Available actions:

* Fold
* Check
* Call
* Raise
* All-In

---

# 11. Betting Order

After blinds are posted:

The first player to act is:

```text
Player immediately to the left of the Big Blind.
```

Betting proceeds clockwise.

Only one player may act at a time.

Each player receives an action timer.

Failure to act before timeout may result in:

```text
Auto Fold
```

---

# 12. Betting Actions

## Fold

Player exits the game.

Consequences:

* Forfeits all committed chips.
* Cannot re-enter the match.
* Becomes spectator.
* Prediction is immediately revealed.

---

## Check

Player passes action without contributing additional chips.

Allowed only when:

```text
No outstanding wager exists.
```

---

## Call

Player matches the highest outstanding wager.

Player remains active.

---

## Raise

Player increases the current wager.

Requirements:

```text
Raise Amount >= Minimum Legal Raise
```

A raise reopens action for remaining players.

---

## All-In

Player commits their entire remaining stack.

Consequences:

* Entire stack enters play.
* Side pots may be created.
* No additional chips may be wagered.

Player remains eligible to win all pots for which they contributed.

---

# 13. Round Completion Rules

A betting round concludes only when every active player has:

```text
Matched highest wager

OR

Folded

OR

Moved All-In
```

Examples:

```text
Player A → 50

Player B → Call 50

Player C → Fold

Player D → Call 50
```

Round completed.

If all remaining players Check:

The round enters a waiting state until the timer expires.

---

# 14. Side Pot Rules

Whenever an All-In player cannot fully match larger stacks:

Side pots are automatically created.

Settlement evaluates each pot independently.

Only eligible players may win their corresponding pots.

---

# 15. Round Transition

At round completion:

```text
Round Ends

↓

Market Continues Updating

↓

New Blinds Posted

↓

Next Betting Round Begins
```

Folded players remain spectators.

---

# 16. Final Reveal Phase

At the end of Round III:

The game enters Reveal Phase.

All surviving players reveal:

```text
Predicted Price
```

Reveal process:

```text
Decrypt Prediction

↓

Verify Commitment

↓

Reveal Sequentially

↓

Compute Accuracy
```

This is the highest emotional moment of the game.

---

# 17. Winner Determination

Only surviving players are eligible.

Winning rule:

```text
Smallest Absolute Difference

between

Predicted Price

and

Final Market Price
```

Example:

| Player | Prediction | Final Price | Difference |
| ------ | ---------- | ----------- | ---------- |
| Alice  | 105000     | 105120      | 120        |
| Bob    | 105300     | 105120      | 180        |

Winner:

```text
Alice
```

---

# 18. Settlement

After winner determination:

```text
Replay Game

↓

Verify Intents

↓

Verify Commitments

↓

Compute Winners

↓

Generate Settlement

↓

Submit On-Chain

↓

Finalize
```

Requirements:

* Deterministic.
* Auditable.
* Idempotent.
* Capital-safe.

---

# 19. Claiming Funds

After settlement:

Players may:

* Claim Winnings.
* Withdraw Funds.
* Review Match History.

Visible information:

* Initial Deposit.
* Chips Committed.
* Winnings.
* Final Balance.
* Settlement Transaction.

---

# 20. Spectator Experience

External users and folded players may spectate games.

Visible information:

* Market Movement.
* Bets.
* Pot Size.
* Round Progression.
* Revealed Predictions.
* Player Actions.

Hidden information:

* Active Predictions.
* Encrypted Commitments.
* Private Metadata.

---

# 21. Match Completion

A match is considered complete only when:

```text
Settlement Finalized

AND

Balances Updated
```

Final player experience:

```text
Review Results

↓

Claim Funds

↓

Join Next Match
```

# Core Player Promise

Every player should leave a Syndicate match believing:

> "I competed in an elite arena where conviction, capital, and strategy determined the outcome."


# 22. Spectator Prediction Market

Syndicate enables non-participating users to financially participate in live matches through a dedicated spectator prediction market.

This feature allows spectators to speculate on the outcome of active games without directly playing at the table.

The objective is to create a secondary engagement layer for users who prefer observing rather than actively competing.

---

## Spectator Participation

Any authenticated spectator may participate in prediction markets associated with publicly viewable matches.

A spectator is not required to:

* Join the table.
* Commit a hidden price prediction.
* Participate in betting rounds.

Instead, spectators may place predictions on the expected outcome of the match.

---

## Available Markets

For every public match, the platform may expose one or more spectator markets.

Examples:

### Winner Market

Spectators predict:

```text id="my9xkp"
Which player will win the match?
```

Example selections:

```text id="y5wmb2"
Player A

Player B

Player C

Player D

Player E
```

---

### Elimination Market

Spectators predict:

```text id="7j3sma"
Which player will be eliminated next?
```

---

### Survival Market

Spectators predict:

```text id="ot0s9h"
Will Player X survive until Final Reveal?
```

Possible outcomes:

```text id="qj7h4a"
YES

NO
```

---

### Head-to-Head Market

Spectators predict:

```text id="q9k1o2"
Which player will finish closer to the final market price?
```

Example:

```text id="ps2hvn"
Player A

vs

Player B
```

---

## Market Lifecycle

Spectator markets open when a match begins.

Lifecycle:

```text id="f89pk7"
Market Opens

↓

Spectator Places Wager

↓

Market Locks

↓

Match Progresses

↓

Outcome Determined

↓

Settlement
```

Markets may lock:

* At the end of Round I.
* At predefined timestamps.
* Immediately upon significant game events.

Locked markets cannot accept additional wagers.

---

## Spectator Wager Flow

User flow:

```text id="v4l7zk"
Open Live Match

↓

View Available Markets

↓

Select Outcome

↓

Specify Wager Amount

↓

Confirm Wager

↓

Market Locked

↓

Await Settlement
```BG

Example:

```text id="aw0v9m"
Market:

Who Will Win?

Selection:

Player C

Stake:

25 USDC
```

---

## Odds Presentation

The platform may display dynamic odds derived from:

* Market liquidity.
* Spectator demand.
* Historical player performance.
* In-game events.
* Betting activity.

Example:

| Outcome  | Odds |
| -------- | ---- |
| Player A | 2.1x |
| Player B | 3.4x |
| Player C | 1.8x |
| Player D | 5.6x |

Odds may change while the market remains open.

Once a spectator places a wager:

```text id="n2vk0z"
Odds are locked for that wager.
```

---

## Information Fairness

To ensure fairness:

Spectators receive only publicly available information.

Available information:

* Market price movement.
* Player actions.
* Pot size.
* Fold events.
* Revealed predictions.
* Historical player statistics.

Spectators must never receive:

* Hidden predictions.
* Encrypted commitments.
* Future player actions.
* Private player metadata.

The platform must guarantee:

```text id="j4r9pd"
No participant possesses privileged information.
```

---

## Settlement

After the primary match concludes:

1. Match outcome becomes final.
2. Spectator market outcomes are resolved.
3. Winning wagers are calculated.
4. Payouts are finalized.

Settlement must be:

* Deterministic.
* Auditable.
* Transparent.

---

## Spectator Rewards

Winning spectators receive:

```text id="s7qm6n"
Original Stake

+

Market Payout
```

Losing spectators forfeit their committed stake.

All payouts are claimable after settlement finality.

---

## Market Integrity Requirements

The spectator market infrastructure must guarantee:

* No insider advantage.
* No post-lock wagering.
* No double settlement.
* No outcome manipulation.
* Complete auditability.

All spectator wagers must be permanently recorded.

---

## Scalability Requirements

The spectator prediction market must support:

* Thousands of simultaneous spectators.
* High-frequency wager submissions.
* Real-time odds updates.
* Large-scale market settlement.

Spectator market traffic must never degrade active gameplay.

---

# Spectator Market Promise

Every spectator should feel:

> "Even though I am not seated at the table, I still have skin in the game."
