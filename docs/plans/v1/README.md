# Syndicate v1 — Phased Completion Plan

One deliverable unit per phase, one file per phase. Any coding agent can pick up a single
`phase-NN-*.md` cold and execute it — each file is a full executable spec (context, files, reuse
anchors with `file:line`, steps, acceptance, verification, risks).

**Source of truth:** the code. Background: [../V1_COMPLETION_CHECKLIST.md](../V1_COMPLETION_CHECKLIST.md)
(verified remaining-work list) and the project CLAUDE.md. Stale: `docs/archive/*`.

**Locked v1 architecture** (do not violate in any phase):
- **No indexer.** Backend verifies client-reported create/deposit **txhashes via RPC** and owns its
  registry. The authoritative seat set for `begin_live` comes from `getProgramAccounts`, never the
  registry — capital safety never depends on the registry.
- Oracle = **signed price** (secp256k1/EIP-191), not Pyth. No on-chain action-log. No session keys.
  No on-chain VRF (button randomness is backend-native). Conservation + signed-price authenticity
  are the only on-chain fund-release gates.

**Deployment-ready for v1 = phases 01–11 complete.** Phase 12 is the post-audit mainnet gate.

---

## Phase index

| Phase | Deliverable | Depends on | Track | Checklist § |
|---|---|---|---|---|
| [01](phase-01-settlement-chain-builders.md) | settlement-chain lifecycle instruction builders + routes + tests | — | A | §1a |
| [02](phase-02-rpc-verification.md) | settlement-chain RPC verification + seat-PDA enumeration + account deser | — | A/B | §1a,§2 |
| [03](phase-03-idl-regen-devnet-deploy.md) | IDL regen + devnet deploy + create smoke | 01 | A | §1c |
| [04](phase-04-orchestrator-slim.md) | Orchestrator slim start-policy (drop set-button-seed/bootstrap; begin_live w/ randomness+seats; pass timing) | 01,02 | A | §1b |
| [05](phase-05-match-row-persistence.md) | Match-row persistence: store migration + INSERT/UPSERT writer | — | B | §6 |
| [06](phase-06-matchmaking-registry.md) | Matchmaking registry from RPC-verified txhashes | 02,05 | B | §3 |
| [07](phase-07-gateway-clock-sync.md) | Gateway clock-sync + engine absolute deadlines + room-push | 06 | B | §4 |
| [08](phase-08-client-protocol.md) | Client/protocol: signed-price view, create/deposit+seal, txhash reporting | 01,07 | B | §5 |
| [09](phase-09-litesvm-matrix.md) | litesvm funds-exit × state matrix (+ harness helpers, build .so) | — | C | §7 |
| [10](phase-10-cleanup.md) | Cleanup: dead Pyth scaffolding, timelock grace, stale-doc deprecation | — | C | §8 |
| [11](phase-11-e2e-devnet.md) | End-to-end devnet integration verification | 01–08 | A/B | §1c |
| [12](phase-12-operational-gates.md) | Operational / mainnet gates (audit, multisig, geofencing) | 01–11 | D | §9 |

## Tracks (parallelizable)

- **A — critical path** (makes lock→begin_live→settle executable): `01 → 03`; `(01,02) → 04 → 11`
- **B — registry/UX**: `05 → 06 → 07 → 08` (`02` feeds `06`; `01` feeds `08`)
- **C — independent** (start anytime): `09`, `10`
- **D — last**: `12`

```
01 ─┬─► 03                              09  (independent)
    ├─► 04 ──────────────┐              10  (independent)
02 ─┘                    │
                         ▼
05 ─► 06 ─► 07 ─► 08 ─► 11 ─► 12
        ▲          ▲
02 ─────┘   01 ────┘
```

## Status legend

Mark each phase's Status line as you go: ⬜ not started · 🟡 in progress · ✅ done & verified · 🔴 blocked.
