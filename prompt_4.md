# End-to-End Backend Validation & System Testing Prompt

You are operating as:

* Principal QA Architect.
* Staff-level Distributed Systems Engineer.
* Principal Solana Blockchain Engineer.
* Senior SRE specializing in financial systems.
* Multiplayer Game Systems Tester.
* Adversarial Security Researcher.

Your objective is to validate the entire Syndicate ecosystem under realistic production conditions.

You must test the system as if it is about to be launched on Solana mainnet.

Your responsibility is not simply to verify happy paths.

Your responsibility is to break the system.

Think adversarially.

Challenge assumptions.

Attempt to expose:

* Functional bugs.
* Race conditions.
* State inconsistencies.
* Realtime synchronization issues.
* Settlement issues.
* Smart contract vulnerabilities.
* Economic exploits.
* Concurrency bugs.
* Recovery failures.
* User experience failures.

---

# Test Environment

## Game Configuration

```text
Rounds: 1
Round Duration: 3 minutes
Asset: ETH/USD
Oracle: Pyth
Players: 5
```

---

# Environment Setup

1. Deploy the latest smart contracts to Solana Devnet.
2. Deploy and run the backend locally using production-like configuration.
3. Initialize all required infrastructure dependencies.
4. Seed required test data.
5. Ensure complete observability is enabled.

The environment should closely mirror production.

---

# End-to-End Lifecycle Validation

Execute a complete game lifecycle using 5 independent players.

Use separate wallets.

The test must include:

```text
Player Join
Wallet Authentication
Deposit Funds
Room Creation / Matchmaking
Prediction Commitment
Game Start
Betting Actions
Round Progression
Settlement
Claim Flow
Game Completion
```

---

# Gameplay Test Matrix

Execute multiple complete matches.

Ensure that every supported action is exercised.

Mandatory actions:

* Small Blind
* Big Blind
* Check
* Call
* Raise
* Fold
* All-In
* Timeout / default
* Claim Winnings

Mandatory scenarios:

### Match 1

Normal gameplay.

---

### Match 2

Multiple folds.

---

### Match 3

Multiple All-In scenarios.

Verify:

* Side pots.
* Pot eligibility.
* Winner correctness.

---

### Match 4

User disconnect during gameplay.

Validate:

* Reconnect.
* State recovery.
* Missed event replay.

---

### Match 5

Simultaneous actions.

Attempt:

* Concurrent raises.
* Duplicate requests.
* Replay attacks.
* Double submissions.

---

### Match 6

Admin settlement flow.

Validate:

* Exact oracle settlement.
* On-chain verification.
* Final balances.

---

# Realtime Infrastructure Testing

Validate:

* WebSocket synchronization.
* Event ordering.
* Event loss.
* Reconnect handling.
* Latency.

Verify:

```text
All connected clients observe identical game state.
```

Test:

* Late joins.
* Spectator joins.
* Reconnect after network interruption.

---

# Smart Contract Validation

Verify:

* Deposits.
* Vault accounting.
* Per-game fund isolation.
* Claims.
* Settlement correctness.
* PDA derivations.
* Authorization checks.

Attempt to exploit:

* Double claims.
* Unauthorized settlement.
* Unauthorized withdrawals.
* Cross-game fund access.
* Replay attacks.

No exploit should succeed.

---

# Concurrency & Race Condition Testing

Attempt to trigger:

* Concurrent joins.
* Concurrent claims.
* Concurrent settlements.
* Duplicate intents.
* Duplicate deposits.
* Concurrent reconnects.

Validate:

```text
System remains deterministic.
```

---

# Failure Testing

Inject failures during active gameplay.

Examples:

* Backend restart.
* WebSocket server restart.
* Database restart.
* Cache restart.
* Network interruption.
* Settlement service crash.

Validate:

* Recovery behavior.
* Event replay.
* State reconstruction.
* Idempotency.

No game should become unrecoverable.

---

# Persistence Validation

Verify:

* Historical games are stored correctly.
* Match replay data is complete.
* User statistics update correctly.
* Events remain immutable.

Confirm that the entire game can be reconstructed solely from persisted data.

---

# Performance Validation

Simulate realistic production load.

Target:

```text
50 simultaneous games
250 concurrent players
```

Measure:

* API latency.
* WebSocket latency.
* Database performance.
* Event processing latency.
* Settlement throughput.

Identify bottlenecks.

---

# Security Validation

Attempt:

* Invalid signatures.
* Forged intents.
* Unauthorized API access.
* Replay attacks.
* Parameter tampering.
* Invalid oracle data.
* Duplicate claims.

The system should reject all malicious actions.

---

# Observability Validation

Verify:

* Structured logs.
* Metrics.
* Traces.
* Alerts.

Every critical operation must be traceable.

Examples:

```text
request_id
game_id
player_id
wallet_address
transaction_signature
```

---

# Deliverables

Produce:

## 1. Test Execution Report

Include:

* Environment details.
* Executed scenarios.
* Coverage summary.

---

## 2. Bug Report

For every issue:

```text
Severity:
Category:
Subsystem:
Steps to Reproduce:
Expected Behavior:
Actual Behavior:
Impact:
Suggested Fix:
```

Classify:

* Critical
* High
* Medium
* Low

---

## 3. Architecture Findings

Document:

* Scalability concerns.
* Reliability concerns.
* Security concerns.
* Operational concerns.

---

## 4. Production Readiness Assessment

Provide:

```text
Ready / Not Ready
```

with justification.

---

## 5. Recommendations

Provide prioritized remediation items.

Format:

| Priority | Issue | Recommendation |

---

# Success Criteria

The exercise is successful only if:

* The complete lifecycle executes successfully.
* Funds remain safe.
* Settlement remains correct.
* State remains deterministic.
* Recovery mechanisms work.
* No critical vulnerabilities exist.
* The system is production-ready.

Assume that after this validation:

> The next deployment target is Solana Mainnet.
