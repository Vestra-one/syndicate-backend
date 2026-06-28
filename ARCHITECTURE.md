# Syndicate Backend — Global Architecture (Management & AI-Agent Context)

**Status:** Canonical engineering map, v1.0. This is the **top-level coding architecture** for the Syndicate backend. It tells any engineer or AI agent: what the system is, what each service owns, the rules that must never be broken, and where new code belongs. Per-service detail lives in each `services/<name>/ARCHITECTURE.md`.

**Read first:** the product/spec canon is `04_GAME_MECHANICS_CANONICAL.md` (rules & settlement), `05_GAME_REQUIREMENTS_CANONICAL.md` (player flows), `06_ARCHITECTURE_IMPLICATIONS.md` (why these constraints exist), `07_RISK_REGISTER.md`, and `08_OPEN_QUESTIONS.md` (locked decisions). This file is the *how-we-build-it* layer on top of those.

---

## 1. What the system is (one paragraph)

Syndicate runs many small (2–5 player) real-money matches concurrently. Each match is *one poker hand played across configurable betting streets* on a shared, live price feed; each player seals a single price prediction with time-lock encryption, bets it like a hidden hand, and at match end the closest eligible prediction wins each pot it is eligible for. Capital is custodied on Solana. The backend is split into services around a single hard principle: **the match engine is authoritative for ordering gameplay, but is never trusted for outcomes — outcomes are recomputed and verified on-chain before any funds move.**

---

## 2. The trust model (the spine of every decision)

```
 Clients ──ws──▶ gateway ──▶ match-engine (authoritative ordering, single-writer/match)
                                  │  appends signed intents to a hash-chained log
                                  │  verified Pyth exact-after price + drand key
                                  ▼
                            settlement (pure fn, Rust shared crate)
                                  │  recompute pots + S
                                  ▼
                            programs (Solana/Anchor)  ── re-verifies settlement, releases funds
```

- **Authoritative, not trusted.** The engine sequences actions and runs timers, but the *result* is a pure function of recorded inputs, recomputed independently and validated on-chain (`04 §18`). If recomputation disagrees, funds do not move; the match VOIDs.
- **Capital safety supersedes everything.** Every fault has a deterministic refund/VOID path. No silent failures. (`04 §17`, `07`.)
- **No privilege.** No service — and no operator — can read a sealed prediction early or influence the settlement price `S`. (`04 §0` invariants.)

These three are non-negotiable. A change that weakens any of them is a foundation regression and must be rejected in review.

---

## 3. Service map

Monorepo under `backend/services/`. Stack: **Rust core + TypeScript edge** (rationale in `08`/conversation). The deterministic money math lives **once** in `shared` (Rust) and is linked by both `settlement` and `programs`.

| Service | Owns | Stack | Key upstream deps |
|---------|------|-------|-------------------|
| `programs` | On-chain truth: vault PDA, deposits/claims/refunds, VRF, settlement **verification**, fee accounting | Rust + Anchor | `shared` |
| `shared` | The deterministic core: domain types, integer money math, **pot/side-pot construction**, Pyth bounded exact-after oracle validation, replay | Rust crate (+ optional WASM) | — |
| `settlement` | Off-chain settlement builder: recompute pots + verified oracle price, assemble & submit the on-chain settlement tx | Rust | `shared`, `timelock`, `programs` |
| `match-engine` | Authoritative state machine, signed action log, timers, pre-signed defaults, side-pot tracking | Rust (tokio) | `shared`, `timelock`, `config` |
| `timelock` | Time-lock encryption seal/verify + **drand `tlock`** decryption at match end | Rust | external drand beacon |
| `gateway` | Edge: WebSocket fan-out, wallet auth (nonce/sig/session), **geofencing**, optimistic client views | TS/Node | `match-engine`, `matchmaking` |
| `matchmaking` | Public queue + private rooms, rating buckets, **deposit-to-enter gate**, seat assignment | TS/Node | `programs` (deposit finality), `config`, `trust-safety` |
| `action-feed` | Read-only public match event stream + **live-games dashboard** ranking/sort | TS/Node | `match-engine` (event stream) |
| `trust-safety` | Standing anti-Sybil / anti-bot / collusion telemetry + enforcement | TS/Node | `match-engine`, `matchmaking` |
| `config` | Versioned, validated game parameters (all numbers are config, not code) | Schema-first; TS service + Rust client | — |

Deferred (not built in v1, seam only): spectator prediction market — would consume `action-feed`. (`04 §21`.)

---

## 4. Cross-cutting conventions (apply to every service)

1. **Money is integer-only.** No floats anywhere near chips, fees, prices, or `S`. Fixed-point per `04 §1`. This rule is absolute.
2. **The deterministic core lives once.** Pot construction, side-pots, `S` median, winner selection, tie-breaks → `shared` (Rust). `settlement` and `programs` both call it; nobody re-implements it. Edge services never compute outcomes.
3. **Every player action is a signed intent** appended to an ordered, **hash-chained** event log. Engine-authored events (timeouts, auto-resolution) are explicitly marked. Replay of (log + sealed predictions + drand key + verified Pyth oracle price + VRF seed + config) must reproduce settlement bit-for-bit. A CI **replay determinism test** gates merges to `shared`/`settlement`/`match-engine`.
4. **Config-driven, not code-driven.** Round count, durations, blinds, timers, fees, caps, feed, token, player counts come from `config`, bound at match creation, recorded for replay. Never hard-code a game number. (`08 OQ7`.)
5. **Events are contracts.** Inter-service messages have versioned schemas (see `shared` + `config`). Public (`action-feed`) events must *never* carry sealed predictions before the time-lock opens, queued intents, pre-signed defaults, or PII.
6. **Single-writer per match.** Exactly one `match-engine` instance owns a match (lease/fencing). No split-brain.
7. **Fail to VOID, never to guess.** Conservation-assertion failure, oracle degradation, missing drand key, fatal desync → deterministic VOID + refund (no fees). (`04 §17`.)
8. **Observability mandatory.** Structured logs, per-match correlation IDs, metrics; oracle and drand health are Sev-1 dashboards.
9. **No secrets in code/repo.** Keys via secret manager; no plaintext predictions ever reach the backend (there is no decryption key until drand publishes it).

---

## 5. Match lifecycle as a cross-service sequence

States (authoritative in `match-engine`, mirrored on-chain): `CREATED → FILLING → SEALING → LIVE(rounds) → SETTLEMENT_WINDOW → DECRYPT → SETTLED` (or `VOID`). (`04 §3`.)

1. **Discover/join** — `gateway` (auth + geofence) → `matchmaking` assigns/forms a table from `config`; **deposit to `programs` vault gates the seat** (anti-spam).
2. **Seal** — client time-lock-encrypts its prediction (`timelock` scheme params); ciphertext recorded before LIVE.
3. **Live** — `match-engine` posts blinds once, runs streets with per-turn timers + pre-signed defaults; `action-feed` broadcasts public events; live chart data is non-authoritative and separate from settlement.
4. **Settle** — at match end, the settlement worker selects the first valid Pyth bounded exact-after update (`shared::oracle`); `timelock` decrypts all predictions via the drand key; `settlement` recomputes pots via `shared`; `programs` re-verifies and releases funds (entry fee + pot rake applied per `04 §14`).
5. **Resolve** — contested showdown or uncontested win; **all numbers open post-match**; `action-feed` presents; players claim from the vault.

---

## 6. Repo layout

```
backend/
  ARCHITECTURE.md                 # this file (global / management)
  01..08_*.md                     # product & engineering canon (source of truth for rules)
  services/
    programs/        ARCHITECTURE.md   # Solana/Anchor on-chain program(s)
    shared/          ARCHITECTURE.md   # Rust deterministic core + domain types
    settlement/      ARCHITECTURE.md
    match-engine/    ARCHITECTURE.md
    timelock/        ARCHITECTURE.md
    gateway/         ARCHITECTURE.md
    matchmaking/     ARCHITECTURE.md
    action-feed/     ARCHITECTURE.md
    trust-safety/    ARCHITECTURE.md
    config/          ARCHITECTURE.md
```

Each service dir is self-contained (its own build, tests, and `ARCHITECTURE.md`). Rust services share workspace crates via `shared`.

**Context & doc policy:** Coding agents should start from [AGENTS.md](AGENTS.md), which defines the canonical reading order, classifies every doc as PRIMARY / REFERENCE / ARCHIVE, and maps superseded drafts to their canonical replacements. De-indexed files (`.cursorindexingignore`) remain readable on demand; marketing and test keys are blocked (`.cursorignore`).

---

## 7. AI-agent working rules (read before changing code)

- **Find the owning service first.** Use the service map (§3). If a change touches outcomes/money, it almost certainly belongs in `shared` (with `settlement`/`programs` consuming it) — not in an edge service.
- **Never duplicate the deterministic core.** If you need pot/`S`/tie logic, call `shared`. If `shared` lacks it, extend `shared` (with tests), don't inline it.
- **Respect the trust model (§2).** Do not let an edge service decide an outcome, read a sealed prediction, or bypass on-chain verification.
- **Add a game number? Add it to `config`,** bind at match creation, record for replay — never hard-code.
- **Touching `shared`/`settlement`/`match-engine`/`programs`?** Your change must pass the replay-determinism and conservation tests, and side-pot property tests.
- **New inter-service message?** Version the schema; check `action-feed` exposure rules (no secret leakage).
- **When in doubt, fail to VOID** (capital-safe) rather than proceed on uncertain state.
- **Trace every rule back to canon.** Each service doc cites the `04/05/06` sections it implements; keep those citations accurate when behavior changes.

---

## 8. Testing & CI (system level)

- **Unit**: per service.
- **Property**: `shared` pot construction (random contribution vectors → always conserve; uncalled-bet returns; multi-tier all-ins).
- **Determinism/replay**: golden match logs replay to byte-identical settlement across `shared` ⇄ `programs`.
- **Contract**: inter-service event schemas (consumer-driven).
- **Integration**: full lifecycle incl. every VOID/refund path (oracle degrade, missing drand key, disconnect, non-fill).
- **Security**: Anchor program audits + fuzz; no-privilege and concealment assertions.

The determinism, conservation, and capital-safety suites are **merge-blocking** for the core services.
