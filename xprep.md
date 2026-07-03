Role: Expert principle RUST/Solana backend developer
Context: The syndicate-backend repo contains the backend logic for the price prediction poker game. The repo already has exisitng game logic code. But it does not fullfill the complete requirement of the game that can be sucessfully integrated on the UI and that have all the below feature.  

Feature-wise requirements of the backend:
1. Create Game -
- Public Room - A user will come on the UI see no curent game he can join to play, then choose any number of streets he wants to put in the game, choose per street duration, pick buy-in for the game and select the feed on which the betting will be done. He will then sign an onchain txn to deposit the buy-in amount for his seat which will create the game and book the first seat on the table on onchain contract. Then, frontend will post the txhash to backend to inform the room creation. 
- Private room - A user will come one the UI and click create private room. FE will ask backend for a unique code for the room, user will choose all the game params as public room then UI will prepare a tx with hash of (roomcode+address) and game params, which will deposit the token and create the private room game and book the table on onchain contract. Then, frontend will post the txhash on the backend to inform the backend for the room creation.

Backend will create an internal game instance after confiming the transaction and onchain state. UI will get informed about the user and UI can render the game lobby screen where user will be waiting for other users.

2. Join Game -
- Public Room - A user will come on the UI, see a list of different game(with different game params) which are there where players are waiting for the other team members to join, he will select the game whose config matches his desire, the frontend will prepare a tx to deposit and join the room. Frontend will then post the txhash to the backend to inform that the user has made the deposit and want-in in the game. The user will become the candidate of the seat on the table and will be confirmed only after posting the txhash to backend.
- Private room - User will paste the room id on the UI. UI will similarly create the tx for deposit like public room but along with the hash of the user (address+roomcode). UI will post the txhash on the backend. The use will be a candidate for the seat and get confirmed only after postingit to backend.

Backend will verify the txhash against the game and if txhash is confirmed then confirm the user seat in the game. It will follow first come first serve. Once all the seats get filled, UI will stop showing the game on the active game list.

3. Game start - Backend will make an onchain transaction to lock the game. the game will start when - 1. All the seats gets filled. or 2. Waiting time for the game gets completed. There will be minimum and maximum number of players can be in the game. If the minimum number of player does not gets reached before the deadline, the game will be cancelled and the players can claim their respective funds. Backend will post the users which have confirmed seat for the game. rest of the players will didn't get the seat will be refunded. UI will have the required endpoints to show the users to claim the fund from the game UI as they didn't get the seat

4. Sealing pf price - Once the game starts, user will be given some predefined time(configurable in backend, admin can update it) in which they will have to choose a price, sign and encrypt it. The encryption will be timelock encryption and this sealed price will gets revealed after the end of the game. A user failing to seal the price, a the current price at seal closing timestamp will be used without encryption.

5. Dealer selection - after the sealing process, backend will use the selaing data as randomeness to choose the dealer position on the table and allocate that user as the dealer position. Betting will happen in clockwise just as poker and in each street, the dealer will move incrementally in the clockwise direction.

6. Betting in different streets - A game can have multiple streets of different durations. THe street and the duration of each street will be provided by the user in point 1 (create game step). In each round the betting will follow the exact poker rules. The users actions will be signed. User can also set some default action which will be used if the user was unable to send the action. 

7. Betting actions - Every user action will of a fixed time for selecting the action - raise, call, fold, check, all-in. User can choose the action option within the timer. If the user takes the action early, the next player will get the chance just after it and will have the fixed betting time. 

8. Settlement - After betting in different streets, in the end of the game time, backend will reveal the sealed prices from the still alive users who are the candidate for the pot, the predicted price which are closed to the price at game end timestamp will win the game. The backend will finalise the winners and the results, will make the onchain tranaction to settle. After the tx, users can calim there winnings/remianing funds on the UI.


Feature for UI/Game -
- Users will make the bet on different prices. UI will show the users bet along with on what price this bet was made.(This will create some image in other users mind to check the users bluff or guess prediction)
- Backend must be desingned in a way such that If a user gets logged out, or lose internet, when he comes back, UI can just bring the user on the running game and he can see the complete history of the users.


UI screen (this is to help understand building the APIs to provide all the information to the UI for sucessfull integration)
1. Play game - 
a. Public - On this section, all the current filling games will be shown where users can join the game if there is a game of there interest or can create a public game by following step 1(crate game)
b. Private - On this section user can paste the room code, and if the room code is valid and room is still valid for user to join, then he will prompted to join the game, to which user will join by following step 2 join game option for private room. User can also create the private room. This won't be visible to any public users.

2. Live games - Once the filling deadling ends, either the game will void if users haven't join or game will get started. The started active games will be shown here which are still running. Any user can click on the game and see the bets and actions from all the payers.

3. Historical games - This will show all the sucessfull games that have happened till now.

<Syndicate-backend review>
Read the existing backend code and evaluate the condition if the repo is good enough to fix/refactor to implement all the above features and requirements of the game. Other wise read code to understand the different sections of the code and will it helpful in implementing the backend in other directory.

<Task>
The deliverable are -
1. Complete implementation of the backend with the above explained features.
2. Backend must be able to handle 1000 users concurrently.
3. Repo must have deployment script and config files along with md file ro deploy such as in syndicate-backend
4. The backend must be product ready with clean and low latency code without unnecessary bloatings.
5. Must have frontend integration docs which should be enough for the frontend to implement all the screens.
6. The UI must feel smooth in terms of data flow from backend to frontend.

# Syndicate Backend — Agent Build Charter

## Role

You are a principal Rust / TypeScript / Solana backend engineer.

## Goal

Deliver a **production-ready, low-latency** backend for Syndicate — a real-money price-prediction poker game on Solana — so the frontend can implement every screen below without workarounds.

You are working against an **existing codebase** that is incomplete and bloated in places. Your job is to **understand it, judge it, and ship what is missing** — not to assume the old code is correct.

## Where to build

1. **Reference repo (read-only):** `syndicate-backend/` — study this first; do not treat its markdown plans as truth; **trust the code and tests**.
2. **Output repo (your work):** create a **sibling directory** e.g. `../syndicate-backend-v2/` — build the final backend here from scratch unless Phase 1 proves a narrow in-place fix is clearly better (document why if you choose otherwise).

## How to work

**Test-first, one feature at a time:**
- For each feature you implement: write failing tests → implement → tests pass → move on.
- No feature is "done" without tests that prove it.
- Prefer simple, readable code over clever abstractions. No unnecessary bloat.

**Two phases — do not skip Phase 1:**

### Phase 1 — Discovery (required before writing production code)

Read the existing `syndicate-backend` repo and produce a short **`GAP_ANALYSIS.md`** in the v2 repo covering:

- What already exists and is worth **reusing as reference** (e.g. game rules, on-chain layout, settlement math)
- What is **missing** relative to the product requirements below
- What is **broken, stubbed, or bloated** and should not be copied
- Your recommended **build plan** (ordered feature list you will implement test-first)
- Whether the on-chain program can stay as-is, needs changes, or must be rewritten

Use these entry points when exploring (not exhaustive):

- `ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md`
- `04_GAME_MECHANICS_CANONICAL.md`, `05_GAME_REQUIREMENTS_CANONICAL.md`
- `docs/architecture/SYSTEM_API_MAP.md` — existing HTTP/WS surfaces
- `docs/frontend/INTEGRATION_GUIDE.md`, `docs/frontend/protocol.ts` — what the frontend expects
- `docs/deployment/` — deployment shape to mirror
- `services/` — all backend services (programs, engine, gateway, matchmaking, worker, etc.)

**Stop and share `GAP_ANALYSIS.md` before Phase 2** unless the user explicitly says to proceed in one shot.

### Phase 2 — Build

Implement everything missing from Phase 1, following the product requirements below. After each feature: tests green, brief note in `docs/features/` or changelog.

---

## Product requirements

### 1. Create game

**Public room**
- User picks: number of streets, per-street duration, buy-in, price feed.
- User signs an on-chain tx to deposit buy-in and create the game + first seat.
- Frontend posts txhash to backend.
- Backend confirms tx + on-chain state, creates internal game instance, exposes lobby state to UI.

**Private room**
- User clicks create private room; frontend asks backend for a **unique room code**.
- User picks same params as public room.
- Frontend builds tx with hash of `(roomCode + address)` + game params, deposits, creates game on-chain.
- Frontend posts txhash; backend confirms and registers private room (not visible on public lobby).

### 2. Join game

**Public room**
- UI lists open games with different params; user picks one, deposits on-chain, posts txhash.
- Seat confirmed only after backend verifies txhash. FCFS.

**Private room**
- User pastes room code; deposit tx includes hash of `(address + roomCode)`; posts txhash; FCFS confirmation same as public.

- Full tables disappear from active public list.
- Unseated / losing FCFS candidates can claim refunds via UI.

### 3. Game start

- Backend submits on-chain lock when: (a) all seats filled, or (b) fill waiting time ends with enough players.
- Min/max player counts enforced.
- If min not reached by deadline → cancel game; players claim refunds.
- Backend exposes confirmed seated players to UI.

### 4. Sealing price

- After start: configurable window for users to pick, sign, and timelock-encrypt a price prediction.
- Sealed prices revealed only after game end.
- Non-sealers: use feed price at seal-close timestamp (no encryption).

### 5. Dealer selection

- After sealing: derive dealer from sealing data (+ any agreed randomness).
- Betting proceeds clockwise like poker; dealer button moves clockwise each street.

### 6. Multi-street betting

- Street count and durations set at create time.
- Standard poker betting rules per street.
- All actions wallet-signed.
- Users may set a **default action** if they disconnect or time out.

### 7. Betting actions

- Fixed timer per action: raise, call, fold, check, all-in.
- Early action → next player gets a fresh full timer immediately.

### 8. Settlement

- After all streets: reveal sealed prices for pot-eligible survivors.
- Closest prediction to price at game-end timestamp wins.
- Backend finalizes results, submits on-chain settlement tx.
- Users claim winnings / remaining funds on UI.

### UI / gameplay support

- Public bet feed: show each player's bet **and the price context** of that street (for bluff-reading — not sealed predictions).
- **Reconnection:** logged-out or offline user returns to running game with **full action history** restored.

### UI screens → backend must support

| Screen | Needs |
|--------|-------|
| **Play → Public** | List filling games, create public game, join |
| **Play → Private** | Create private (room code), join by code; hidden from public list |
| **Live games** | Active running games; spectator view of bets + actions for all players |
| **Historical games** | Completed games list + detail/replay |

---

## Deliverables

1. **Complete backend** implementing all features above, frontend-integratable.
2. **1000 concurrent users** — design and document how this is achieved; include a basic load/soak test.
3. **Deployment** — docker-compose (or equivalent), env config, and markdown deploy guide (mirror structure of `syndicate-backend/docs/deployment/`).
4. **Production quality** — clean, efficient, low-latency; no dead stubs on hot paths; no AI slop / copy-paste bloat.
5. **Frontend integration docs** — enough for frontend to build all screens (API/WS catalog, types, example flows).
6. **Smooth realtime UX** — clock-synced deadlines, lobby updates, reconnect/resync; data flow should feel instant on the UI.

Also deliver from Phase 1: **`GAP_ANALYSIS.md`** (what existed, what you built, what you intentionally did not port).

---

## Constraints (non-negotiable)

- **Capital safety:** when state is uncertain, fail to refund/VOID — never pay out on bad data.
- **Integer money only** — no floats for chips, prices, pots.
- **Config-driven game numbers** — streets, timers, buy-ins from config/admin, not magic constants in code.
- **Frontend signs money txs** — backend verifies and orchestrates; it does not hold user keys.

Everything else (service count, stack splits, on-chain changes) — **you decide in Phase 1** and document why.

---

## Done when

- [ ] `GAP_ANALYSIS.md` exists and matches the built system
- [ ] Every product requirement above has passing tests
- [ ] End-to-end lifecycle works on devnet (create → join → play → settle → claim)
- [ ] Frontend integration doc covers all four UI screen groups
- [ ] Deploy guide runs on a clean machine
- [ ] Load test artifact exists for concurrency claim
