# Satoshi's Table — bet at the table

A realtime price-betting game. The centerpiece is a candlelit 3D table; everything
in the game happens there. Players bet **UP / DOWN** on where a market price moves
over short timed rounds.

## Stack

- **Vite + React + TypeScript** — lean SPA, instant HMR (chosen over Next.js: the app
  is a client-side WebGL + realtime surface with no SEO/SSR needs; the game server is
  a separate service).
- **Three.js** — the table renders as a self-contained imperative engine, kept outside
  React's render cycle.
- **Zustand** — game state (price, round, wallet, bets).

## Scripts

```bash
npm run dev        # dev server at http://localhost:5173
npm run build      # typecheck + production build
npm run lint       # eslint
npm run format     # prettier
npm test           # unit tests (intent byte layouts)
npm run e2e:localnet   # two browsers play a full hand against the local stack (below)
```

## Architecture

```
src/
  three/table/tableScene.ts   # the 3D table engine (imperative, disposable)
  components/
    table/TableCanvas.tsx     # React mount/unmount lifecycle for the engine
    hud/                      # 2D overlay: ticker, wallet, round, betting, bets
  store/gameStore.ts          # Zustand store — wires the feed to UI state
  lib/
    types.ts                  # domain model (Round, Bet, Wallet, PriceTick…)
    realtime/
      feed.ts                 # GameFeed interface (transport-agnostic)
      mockFeed.ts             # in-browser stand-in: random walk + round loop
    format.ts, useNow.ts      # presentation helpers
  styles/                     # design tokens + global/HUD CSS
```

### Three layers, cleanly separated

1. **Engine** (`tableScene.ts`) renders the world and exposes `{ scene, camera,
   tableRadius, feltY, dispose }`. Gameplay 3D objects (chips, markers, price arcs,
   seats) will attach to `scene` using `tableRadius` / `feltY` as anchors.
2. **HUD** (`components/hud`) is the 2D overlay, driven entirely by the store.
3. **Feed** (`lib/realtime`) is the only thing that knows about the network. Today
   it's mocked; swapping in a real WebSocket means implementing `GameFeed` and
   pointing the store at it — **no UI changes required**.

## What's next (building the table up, step by step)

- Place per-side betting zones and animated chips on the felt.
- Seats / avatars around the rim driven by the `Player` model.
- A live price arc / candlestick projected onto the felt.
- Real game server behind `VITE_GAME_WS_URL` (implementing `GameFeed`).
- Auth + persistent wallet.
```
```

Copy `.env.example` to `.env.local` and point it at a backend (devnet values are the
defaults in that file).

## Run the whole game locally, end to end

No devnet, no wallet extension, no funds needed — the repo ships a one-command
local stack (validator with the program, chips mint, Postgres, price feed, game-server,
settlement worker):

```bash
# 1. at the repo root
scripts/localnet/up.sh          # prints the VITE_* block for .env.local

# 2. in apps/web — two headless browsers play one full hand through the real app
npm run e2e:localnet
```

`e2e:localnet` starts the dev server against the local stack, opens a host and a guest
(each with an injected test wallet signing with the funded e2e keys) and drives:

create table → join from the lobby → both seal a prediction → bet through every street →
on-chain settlement → reveal → both claim.

It asserts the things that matter for money — sealed predictions decrypt to what was
sealed, `payouts + rake == buy-ins`, wallet balances after claiming — plus the session
behaviour (one sign-in prompt, and a socket dropped mid-hand reconnects with no prompt).
Screenshots of each phase are written to `e2e-shots/`. Set `E2E_3D=1` to render the 3D
table in the screenshots (software GL; slow on small machines), `VERBOSE=1` for page logs.

To play it by hand instead, put the printed block plus `VITE_TIMELOCK_MODE=mock` in
`.env.local`, run `npm run dev`, and fund your own wallet on the local chain with
`EXTRA_WALLETS="<pubkey> <pubkey>" scripts/localnet/up.sh`.
