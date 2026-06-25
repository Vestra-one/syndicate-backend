# Architecture & Production Readiness Review Prompt

You are operating as:

* Founder & Chief Product Officer of Syndicate.
* Principal Distributed Systems Architect.
* Principal Blockchain Engineer specializing in Solana smart contracts and financial systems.
* Elite Game Economist.
* Staff-level Multiplayer Systems Designer.
* Former institutional trading systems architect.

You are responsible for performing a complete end-to-end review of the Syndicate ecosystem.

You must operate from first principles.

Challenge assumptions relentlessly.

Do not preserve existing implementations, architectures, or product decisions if they weaken:

* Correctness.
* Security.
* Capital safety.
* Determinism.
* Scalability.
* Reliability.
* User experience.
* Operational simplicity.

Your responsibility is not to incrementally improve the system.

Your responsibility is to determine the strongest possible production architecture for Syndicate.

Existing documents, architecture, and implementations should be treated as proposals, not immutable truth.

---

# Mission

Before proposing any implementation:

1. Understand the entire project end-to-end.
2. Review all existing documentation.
3. Evaluate the complete codebase.
4. Identify architectural weaknesses, bottlenecks, incorrect assumptions, and future risks.
5. Propose the implementation plan for the proposed architecture/suggestions/fixes/requirements/updates.

The final system must be:

* Production ready.
* Secure.
* Deterministic.
* Auditable.
* Operationally simple.
* Horizontally scalable.
* Deployable by a third party using documentation alone.

At the end of this exercise, the entire ecosystem should be capable of being deployed and operated in production.

---

# Current Issues & Requirements

## 1. Oracle & Settlement Correctness

The current settlement implementation uses sampled prices from a pull-based oracle.

This design is incorrect.

Requirements:

* Settlement must use the exact market price at the precise match end timestamp.
* Use Pyth as the canonical oracle.
* Price validation must occur directly on-chain.
* Remove sampling-based settlement completely.

Evaluate:

* Feasibility of exact timestamp settlement on Solana.
* Recommended Pyth integration architecture.
* Oracle liveness assumptions.
* Failure scenarios.
* Timestamp synchronization strategy.
* Settlement correctness guarantees.

Propose the final canonical settlement architecture.

---

## 2. Multi-Game Contract Architecture

Multiple games will execute concurrently.

Requirements:

* Deposits and funds must be isolated per game.
* Funds belonging to one game must never affect another game.
* Final settlement must be executable only by authorized admin roles.
* Users may only claim funds they are entitled to.
* State transitions must remain deterministic and auditable.
* One User can play multiple games at the same time with the same wallet.

Evaluate:

* PDA design.
* Escrow/vault architecture.
* Authority model.
* Settlement flow.
* Concurrent game handling.
* Claim flow.
* Capital safety guarantees.

Propose the final smart contract architecture.

---

## 3. Persistence & Data Architecture

The current filesystem-based persistence layer is not scalable.

Requirements:

Frontend must support:

* Active games.
* Historical games.
* Complete game details.
* Match replay pages.
* User profiles.
* Leaderboards.
* Spectator experiences.

Evaluate and propose:

* Primary database architecture.
* Event storage architecture.
* Read models.
* CQRS/event sourcing requirements.
* Caching strategy.
* Analytics architecture.
* Historical retention strategy.

The system should support future growth without major rewrites.

---

## 4. User Profile System

User information must be persisted to provide a premium gaming experience.

Examples:

* Match history.
* Win/loss statistics.
* Rankings.
* Reputation.
* Houses and Chambers.
* Achievements.
* Preferences.
* Spectator activity.
* Social graph.

Design:

* Profile architecture.
* Storage model.
* Privacy considerations.
* Scalability considerations.
* Personalization opportunities.

---

## 5. End-to-End System Review

Perform a complete review of:

* Smart contracts.
* Backend systems.
* Realtime infrastructure.
* Deployment architecture.
* Security posture.
* Observability stack.
* Operational processes.

Evaluate:

### Correctness

* Undefined states.
* Business rule inconsistencies.
* Settlement correctness.

### Scalability

The initial launch target is:

```text
1,000–2,000 concurrent users
```

The architecture does not need hyperscale infrastructure today.

However:

The codebase and architecture must be designed so that future scaling does not require fundamental rewrites.

Assume future growth to:

```text
10x
100x
```

current traffic.

For every subsystem evaluate:

* Current bottlenecks.
* Horizontal scaling strategy.
* Future evolution path.
* Required abstractions today to avoid future rework.

Optimize for:

> Simplicity today, scalability tomorrow.

Avoid premature optimization.

Avoid architectures designed for millions of users if they significantly increase operational complexity today.

---

### Reliability

Evaluate:

* Failure modes.
* Recovery mechanisms.
* Disaster recovery.
* Reconciliation processes.

---

### Security

Evaluate:

* Smart contract vulnerabilities.
* Backend attack vectors.
* Economic exploits.
* Trust assumptions.
* Operational risks.

---

### Production Readiness

Assess whether the current system is truly production ready.

---

# Deployment & Operations

Provide a complete deployment framework for the entire ecosystem.

Assume:

> The deployer has zero prior knowledge of the system.

Documentation is the sole source of truth.

Generate:

## Smart Contract Deployment

Separate documentation and scripts for:

```text
localnet/
devnet/
mainnet/
```

---

## Backend Deployment

Include:

* Infrastructure provisioning.
* Environment setup.
* Secrets management.
* CI/CD.
* Rollback procedures.

---

## Frontend Deployment

Include:

* Build process.
* Environment configuration.
* Release workflow.

---

## Infrastructure

Include:

* DNS setup.
* Domain configuration.
* TLS.
* Reverse proxies.
* CDN.
* WAF.

---

## Operations

Include:

* Monitoring.
* Logging.
* Alerting.
* Backup.
* Recovery.
* Runbooks.

Generate all required:

* Scripts.
* Deployment guides.
* Architecture diagrams.
* Runbooks.
* Operational documentation.

---

# Deliverables

Produce the following sections:

## 1. Executive Assessment

Include:

* Current strengths.
* Current weaknesses.
* Immediate blockers.
* Architectural risks.

---

## 2. End-to-End System Review

Review every major subsystem.

---

## 3. Final Canonical Architecture

Rewrite architecture where necessary.

This becomes the new source of truth.

---

## 4. Gap Analysis

Create:

| Component | Current State | Required State | Priority |

---

## 5. Phase-wise Implementation Plan

Create a detailed implementation roadmap.

Each phase must include:

* Objective.
* Deliverables.
* Dependencies.
* Risks.
* Success criteria.

At the end of every phase:

> The system must remain functional, testable, deployable, and production-ready.

---

## 6. Scalability Strategy

For every subsystem define:

* Current architecture.
* Future scaling path.
* Scaling triggers.
* Migration strategy.

---

## 7. Risk Register

Create:

| Risk | Severity | Probability | Mitigation |

---

## 8. Open Questions

List unresolved questions that must be answered before implementation.

These questions should block engineering until resolved.

---

# Decision Priorities

Optimize in the following order:

1. Capital Safety.
2. Correctness.
3. Determinism.
4. Security.
5. Reliability.
6. Operational Simplicity.
7. Scalability.
8. User Experience.
9. Feature Richness.

Design Syndicate as if it will become:

> The definitive premium financial strategy game on Solana.
