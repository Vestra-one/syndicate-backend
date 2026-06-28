# Syndicate Backend — Agent Entry Point

**What this is:** A real-money poker-style prediction game on Solana. The backend is a Rust core + TypeScript edge monorepo under `services/`. Start with [ARCHITECTURE.md](ARCHITECTURE.md) for the global engineering map.

---

## Canonical reading order

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — trust model, service map, cross-cutting conventions, lifecycle.
2. **`services/<name>/ARCHITECTURE.md`** — owning service for your change (see service map in ARCHITECTURE.md §3).
3. **Product canon** — rules, flows, constraints:
   - [04_GAME_MECHANICS_CANONICAL.md](04_GAME_MECHANICS_CANONICAL.md) — game rules & settlement
   - [05_GAME_REQUIREMENTS_CANONICAL.md](05_GAME_REQUIREMENTS_CANONICAL.md) — player flows
   - [06_ARCHITECTURE_IMPLICATIONS.md](06_ARCHITECTURE_IMPLICATIONS.md) — why these constraints exist
   - [07_RISK_REGISTER.md](07_RISK_REGISTER.md) — known risks
   - [08_OPEN_QUESTIONS.md](08_OPEN_QUESTIONS.md) — locked decisions & open items
4. **[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** — build phases and current status.
5. **Operational docs** (as needed): `docs/RUNBOOKS.md`, `docs/ROLLOUT.md`, `docs/SECURITY_REVIEW.md`, `docs/frontend/`, `docs/deployment/`.

---

## Non-negotiable working rules

- **Find the owning service first.** Outcomes/money belong in `shared` (consumed by `settlement`/`programs`) — not edge services.
- **Never duplicate the deterministic core.** Pot/`S`/tie logic lives in `shared` only; extend `shared` with tests, don't inline.
- **Respect the trust model.** The match engine orders gameplay but is not trusted for outcomes; on-chain verification gates fund release.
- **Config-driven, not code-driven.** Game numbers come from `config`, bound at match creation, recorded for replay.
- **When in doubt, fail to VOID** (capital-safe) rather than proceed on uncertain state.
- **Trace every rule back to canon.** Service docs cite `04/05/06` sections; keep citations accurate when behavior changes.

---

## Doc map

### PRIMARY (indexed — read first)

**Root**
- [ARCHITECTURE.md](ARCHITECTURE.md) — global engineering map
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — build plan & status
- [04_GAME_MECHANICS_CANONICAL.md](04_GAME_MECHANICS_CANONICAL.md)
- [05_GAME_REQUIREMENTS_CANONICAL.md](05_GAME_REQUIREMENTS_CANONICAL.md)
- [06_ARCHITECTURE_IMPLICATIONS.md](06_ARCHITECTURE_IMPLICATIONS.md)
- [07_RISK_REGISTER.md](07_RISK_REGISTER.md)
- [08_OPEN_QUESTIONS.md](08_OPEN_QUESTIONS.md)

**Per-service architecture**
- [services/programs/ARCHITECTURE.md](services/programs/ARCHITECTURE.md)
- [services/shared/ARCHITECTURE.md](services/shared/ARCHITECTURE.md)
- [services/settlement/ARCHITECTURE.md](services/settlement/ARCHITECTURE.md)
- [services/match-engine/ARCHITECTURE.md](services/match-engine/ARCHITECTURE.md)
- [services/timelock/ARCHITECTURE.md](services/timelock/ARCHITECTURE.md)
- [services/gateway/ARCHITECTURE.md](services/gateway/ARCHITECTURE.md)
- [services/matchmaking/ARCHITECTURE.md](services/matchmaking/ARCHITECTURE.md)
- [services/action-feed/ARCHITECTURE.md](services/action-feed/ARCHITECTURE.md)
- [services/trust-safety/ARCHITECTURE.md](services/trust-safety/ARCHITECTURE.md)
- [services/config/ARCHITECTURE.md](services/config/ARCHITECTURE.md)
- [services/store/ARCHITECTURE.md](services/store/ARCHITECTURE.md)

**Operational & integration**
- [docs/RUNBOOKS.md](docs/RUNBOOKS.md)
- [docs/ROLLOUT.md](docs/ROLLOUT.md)
- [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)
- [docs/frontend/INTEGRATION_GUIDE.md](docs/frontend/INTEGRATION_GUIDE.md)
- [docs/frontend/protocol.ts](docs/frontend/protocol.ts)
- [docs/deployment/PRODUCTION_DEPLOYMENT_FRAMEWORK.md](docs/deployment/PRODUCTION_DEPLOYMENT_FRAMEWORK.md)
- [docs/deployment/SECRETS_AND_KEYS.md](docs/deployment/SECRETS_AND_KEYS.md)
- [docs/deployment/AUDIT_AND_BUG_BOUNTY.md](docs/deployment/AUDIT_AND_BUG_BOUNTY.md)
- [docs/deployment/env.example](docs/deployment/env.example)

**Source, deploy, scripts**
- All source under `services/` (Rust + TypeScript)
- `deploy/` — Docker, Prometheus, Grafana
- `scripts/` — migration, deploy, harness scripts
- `golden/README.md` — golden replay test fixtures (JSON data de-indexed)

### REFERENCE (de-indexed — readable on demand, not auto-surfaced)

Listed in `.cursorindexingignore`. Open directly when you need historical context:

- `prompt.md`, `prompt_1.md` … `prompt_4.md` — one-off agent/build prompts
- `01_EXECUTIVE_ASSESSMENT.md` — initial product assessment
- `02_CONTRADICTIONS_AND_WEAKNESSES.md` — resolved contradictions log
- `03_BUILDER_VISION_CANONICAL.md` — vision (superseded by operational canon; see mapping below)
- `Builder_vision.md`, `Game_mechanics.md`, `Game_requirement_user_pov.md` — original drafts
- `docs/PRODUCTION_READINESS_REVIEW_PROMPT_3.md`
- `docs/PRODUCTION_GO_NO_GO_AUDIT.md`
- `docs/PRODUCTION_HARDENING_REMEDIATION.md`
- `docs/PROMPT_4_TEST_EXECUTION_REPORT.md`
- `Cargo.lock`, `services/programs/Cargo.lock`, `golden/*.json` — generated/large data

### ARCHIVE (blocked — out of agent scope)

Listed in `.cursorignore`. Not accessible to coding agents:

- `marketing_and_go_to_market/` — GTM, growth, community strategy (30 files)
- `devnet_testing_keys.md` — test key material

---

## Superseded → canonical mapping

| Superseded (REFERENCE) | Canonical (PRIMARY) |
|------------------------|---------------------|
| `Builder_vision.md` | `03_BUILDER_VISION_CANONICAL.md` |
| `Game_mechanics.md` | `04_GAME_MECHANICS_CANONICAL.md` |
| `Game_requirement_user_pov.md` | `05_GAME_REQUIREMENTS_CANONICAL.md` |

For engineering decisions, prefer `04`–`08` and `ARCHITECTURE.md` over `01`–`03`.

---

## Context policy

- **De-indexed files are not deleted.** They remain in the repo and can be opened or `@`-referenced when needed.
- **Blocked files are intentionally excluded** from agent context (marketing, secrets).
- To change what is indexed: edit `.cursorindexingignore` (de-index) or `.cursorignore` (block).
- `target/` and `node_modules/` are gitignored and excluded from indexing by default.
