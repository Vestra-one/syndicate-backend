# Satoshi's Table

A multiplayer price-prediction game on Solana. Players sit at a table, seal a price call
that nobody can read until the hand ends, bet through timed rounds while the live market
moves, and the closest call takes the pot. Custody and settlement are on-chain.

## Layout

| Path | What |
|---|---|
| `apps/web` | The game client (Vite + React + Three.js) |
| `services/programs` | Solana program (Anchor): custody, seating, seals, settlement, voids |
| `services/game-server` | REST + WebSocket API, lobby, match actors, betting engine |
| `services/chain-worker` | Signs lock / begin-live / settle / void, runs settlement |
| `services/signed-price-server` | Signed price feed (Go) |
| `services/{engine-core,match-engine,shared,chain,store,timelock}` | Libraries |
| `services/e2e` | Lifecycle + fund-theft suite against a running stack |
| `scripts/localnet` | The whole system on one machine, offline |
| `docs/frontend/INTEGRATION.md` | Client protocol (single source, with the IDL beside it) |
| `docs/deployment/DEPLOYMENT.md` | Deploy and operate |

## Run everything locally

```bash
scripts/localnet/up.sh                     # validator + program + Postgres + services
scripts/localnet/e2e.sh                    # backend lifecycle + theft suite
(cd apps/web && npm install && npm run e2e:localnet)   # two browsers play a full hand
scripts/localnet/down.sh
```

`scripts/test-all.sh` runs the unit, contract and lint suites.
