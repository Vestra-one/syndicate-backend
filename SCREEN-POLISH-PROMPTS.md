# Satoshi's Table — Screen-by-Screen Polish Prompts
Review date: 2026-07-04 · Source: `screenshots/flow-2026-07-04/`

Each screen has: **Problems found** (what makes it feel unfinished) and a **Prompt** (paste directly to a coding agent). Fix Section 0 first — most per-screen issues trace back to it.

---

## 0. GLOBAL CONSISTENCY SYSTEM (fix before any screen)

These defects appear on nearly every screen and are why the product reads as a school project:

1. **Currency chaos (critical).** Lobby says buy-in `10 USDC`. Live table shows stacks `2.35 ETH`, bets `0.75 ETH`, pot `18.75 ETH`. Settlement pays `11200000 ETH` on a 10 USDC buy-in. One table = one currency, everywhere. If buy-in is USDC, every stack, bet, pot, and payout is USDC.
2. **Wallet state broken.** Every screen — including LIVE play with money committed — shows `Connect Wallet` top-right. Impossible state. After connect: truncated address + USDC balance + avatar; while seated: add stack indicator.
3. **Placeholder chart dates.** `JAN 03, 2009 / JUL 04, 2026` is visible on every table screen. It's genesis-block flavor text but reads as a bug. Either style it clearly as engraved decoration or show the actual session window.
4. **Player plaque = two different components.** Waiting room shows `Seated / Waiting + stack`; live shows `action + stack + ✓`; both float at arbitrary angles, overlapping the table's engraved rim text. Build ONE `PlayerSeat` component with state variants (see prompt 9), anchored to 6 fixed seat positions.
5. **Status vocabulary drift.** "Waiting for players" vs "TABLE FILLING" vs "Ready to start" vs "TABLE READY" vs "The match begins shortly" vs "MATCH STARTING" — on the same screen. Define one state machine: `FILLING → READY (T-x) → SEALING → LIVE (round n/4) → SETTLING → SETTLED/VOIDED`, and render every status label from it.
6. **Number formatting.** `11200000 ETH`, `$62,492.71` input, `±0.12`, `86.5 USDC` — no shared formatter. One util: thousands separators, fixed decimals per currency (USDC 2, price 2), sign-aware deltas.
7. **Persona badges** (`AGGRESSIVE / SAFE / PASSIVE / UNKNOWN / TIGHT PLAYER / BALANCED PLAYER`) — undefined set, inconsistent casing, no tooltip. Define 5 personas max, one icon each, tooltip explaining how it's computed.
8. **Empty charts look broken.** Screens 04/05/09/10 show a blank panel with one stray vertical line. An empty chart must show a "waiting for first tick" state: dimmed grid + pulsing last-price dot + label.

**Coin-stack mechanics spec (referenced by prompts 12–13):**

- **Every seated player gets a personal coin stack** rendered at their seat, height proportional to stack size. The pot is a separate central stack. Today only the pot exists — players have no physical chips, which is why the table feels dead.
- **Bet / Raise / Call:** animate N coins sliding from the player's stack to a **committed zone** just in front of their seat (inside the rail). Committed coins stay there for the whole betting round with a small amount label. Player stack visually shrinks.
- **Check:** no coins move. Play a short double-tap "knock" ripple on the felt at their seat + `CHECK` flash on the plaque. Checking is information; it needs a visible beat.
- **Fold:** player's committed coins slide INTO the central pot immediately; their personal stack and plaque desaturate to ~40%, avatar goes grayscale, seat drops back from the rail. Folded money is dead money — show it leave.
- **End of betting round:** all committed zones sweep into the central pot in one choreographed animation; pot counter ticks up numerically during the sweep.
- **All-in:** entire remaining stack slides forward, plaque gets a gold `ALL-IN` ribbon.
- **Win:** pot stack slides to the winner's seat, merges into their stack, counter ticks.
- Pot label: `POT 18.75 USDC` always with currency, positioned above the stack, never occluded by coins (currently "18.75" is half-hidden inside the coin pile).

---

## 01 — Dashboard, empty state (`01-dashboard-real.png`)

**Problems:** spinner AND "No games yet" shown together (contradiction); card is tiny in a huge dark void; no explanation of what the game IS for a first-time visitor; `SOLANA · DEVNET` nearly invisible; Refresh button relic (should be live via websocket).

**Prompt:**
> Rebuild the dashboard empty state. Remove the spinner once data resolves — never show a loader and an empty-state message simultaneously. Expand the empty state into a first-run hero: one line of what the game is ("Predict the price. Outlast the table. Winner takes the pot."), a 3-step visual (Buy in → Seal your call → Closest takes pot), then the `Deal a table` CTA. Add a subtle animated preview of the table behind the card (slow camera drift) so the empty room sells the atmosphere instead of wasting it. Move `SOLANA · DEVNET` into a visible amber pill top-left with a tooltip ("Test network — funds are not real"); on devnet add a "Get test USDC" faucet link. Replace manual Refresh with live updates + a last-updated timestamp.

## 02 — Dashboard, populated (`02-dashboard-populated.png`)

**Problems:** rows are flat label/value text with no scannability; seat-fill underline is invisible; `42s left` has same visual weight as `4m left` (no urgency); filter chips `Hot/Pot/Buy-in/Feed` are cryptic; OPEN and LIVE rows look identical; no asset icons; no row hover state visible.

**Prompt:**
> Redesign lobby rows as cards with clear hierarchy. Left: asset icon pair + pair name + buy-in as the primary bold figure. Middle: seat fill as 5 discrete seat dots (filled/empty) instead of the underline bar, plus avatars of seated players (stacked, overlapping). Right: countdown as a ring timer that turns amber <60s and red <15s with a gentle pulse; then the `Join →` button, full-height, gold. LIVE rows must look different from OPEN rows: green LIVE dot, pot size as the hero number, tiny sparkline of the pot growth, watcher count with an eye icon, `Watch` as secondary (outline) styling. Rename filters to explicit labels with icons: `🔥 Hot · 💰 Biggest pot · 🎟 Lowest buy-in · 🕐 Newest` and make the active filter state obvious. Add hover: card lifts 2px, border brightens. Sort OPEN by closing-soonest by default.

## 03 — Dashboard, invite banner (`03-dashboard-invite.png`)

**Problems:** banner says "Someone shared a hand with you" — zero specifics (which table? buy-in? seats? who?); it pushes the `Deal a table` card half off-screen; `Dismiss` is floating text.

**Prompt:**
> Make the invite banner concrete: show the actual invited table's pair, buy-in, seats filled (e.g. "The Duchess invited you · BTC/USD · 10 USDC buy-in · 2/5 seated · closes in 1:12") with the inviter's avatar. Primary CTA `Take your seat` goes straight into the join flow for THAT table with the row highlighted below. Give Dismiss a real ghost-button treatment. Cap banner height so the layout never clips the bottom card; if the invited table filled or expired, swap the banner to a "Table filled — deal your own?" fallback instead of showing a dead CTA.

## 04 — Lobby join panel (`04-lobby-join.png`)

**Problems:** panel says `2/5 SEATED` but only one opponent plaque ("THE DUCHESS") floats mid-air, not attached to a seat; chart y-axis repeats `62,457 / 62,457`; empty-chart line looks broken; ghosted `YOUR POSITION` / `FILLING TABLE` panels leak from the next screen at low opacity (looks like a rendering bug); terms like `Blinds 0.005/0.01`, `Rake 2.5% · cap 1`, `20s + 30s bank` are unexplained.

**Prompt:**
> In the join view, render ALL seated players in their actual seats around the table (2/5 = two plaques at seat positions, three `OPEN SEAT` markers), never floating. Hide the ghosted your-position/filling-table panels entirely until the user is actually seated — partial-opacity leakage reads as a bug. Add an info tooltip (ⓘ) to every economic term: blinds, rake, entry fee, action timer bank. Show "You'll sit at seat N" with a highlighted empty seat so joining feels spatial. Fix chart y-axis to unique tick values and use the empty-chart 'waiting for tick' state from the global spec. Add the seat-total math inline: `10 buy-in + 0.5 entry = 10.5 USDC` right above the CTA (currently the total appears without the addition being obvious).

## 05 — Lobby create panel (`05-lobby-create.png`)

**Problems:** headline "You'll be first in…" is the panel's only personality — the form below is raw; `FILL WINDOW 78 sec` is a bizarre default (why 78?); chart is a blank box with one vertical line (broken-looking); no pair selector visible (locked to BTC/USD?); economic terms again unexplained; no preview of what the created table row will look like.

**Prompt:**
> Polish table creation: default fill window to a preset (5m), highlight the preset chips as the primary input and demote the raw seconds field to an "advanced" affordance. Add a pair selector (BTC/USD, ETH/USD, …) as the FIRST field — creators must choose the market. Buy-in field gets preset chips too (5 / 10 / 25 / 50 / 100) plus min-max hint. Live-update a summary card as settings change: "5 seats · 10 USDC · pot up to 50 USDC · rake 2.5%" so the creator sees the stakes they're setting. Derived fields (entry fee, blinds, rounds, timer) go into a collapsed 'Table rules' accordion with tooltips. Use the standard empty-chart state. Validate: disable CTA + inline error if buy-in outside 0.1–1,000.

## 06 — Tx ceremony: approve (`06-tx-ceremony-signing-create.png`)

**Problems:** solid screen overall; `1/5 SEATED` badge inside the amount box is noise here; no cancel path; no wallet identifier (which wallet am I approving in?); step labels ALL-CAPS letter-spaced but body text sentence case (mixed type system).

**Prompt:**
> On the approve step: add the connected wallet's name/icon and truncated address under the headline ("Confirm in Phantom · 7xKq…9fUd") so users know where to look. Add a quiet `Cancel` text button that safely aborts pre-signature. Remove the seat-count badge from the amount box — the amount is the only thing that matters at this moment. Add a 60s no-response nudge: "Nothing happening? Open your wallet manually or retry." Keep the progress rail but make completed steps green-check, current step pulsing gold, future steps dim — currently PREPARE's check and APPROVE's spinner have near-identical visual weight.

## 07 — Tx ceremony: finalizing (`07-tx-ceremony-confirming-join.png`)

**Problems:** good copy ("Keep this open"); unexplained pagination dots below the footnote; no tx hash link; no time expectation beyond "a few seconds".

**Prompt:**
> On the finalize step: show the transaction signature as a truncated link to Solscan (devnet) so power users can verify. Replace the mystery pagination dots with an explicit elapsed-time indicator ("~4s · usually under 10s"). If finality exceeds 30s, transition copy to a reassurance state with a support link rather than spinning silently forever. On success, play a brief seat-taken animation (coin stack materializing at your seat) before routing to the waiting room — the current hard cut loses the payoff moment.

## 08 — Tx ceremony: error (`08-tx-ceremony-error.png`)

**Problems:** raw simulation error surfaced verbatim; no balance context; no path to fix (devnet faucet!); Back vs Try again ambiguity (back to where?).

**Prompt:**
> Humanize tx errors with an error map: `insufficient USDC balance` → "You need 10.5 USDC — your wallet has 3.2." Show required vs actual balance, and on devnet add a primary `Get test USDC` faucet button. Keep the raw error in a collapsible 'Technical details' row with a copy button. Rename `Back` → `Back to table` and make `Try again` re-simulate before re-prompting the wallet so users don't sign a doomed tx twice. Log distinct error states (rejected in wallet / insufficient funds / seat taken meanwhile / network) with distinct copy — "seat taken while you signed" needs its own message and an instant refund note.

## 09 — Waiting room, filling 2/5 (`09-waiting-filling.png`)

**Problems (this is the "school project" screen):** `YOUR SEAT / 1 / USDC` card reads as "1 USDC" — the seat number and currency collide; plaques float at random angles over the rim's engraved text; `OPEN SEAT` pills at three different sizes/angles; central `2/5 PLAYERS JOINED` + carousel dots + "Waiting for 1 more trader" (wrong count: 2/5 means 3 more) + right-rail `STATUS Waiting for players` + `STARTS AUTOMATICALLY IN 1:15` + "starts as soon as the table is seated" — six competing status statements, one factually wrong; empty chart broken-looking; `HOW IT WORKS` list styling is generic.

**Prompt:**
> Rebuild the waiting room around ONE status source. Center of table gets a single `TABLE FILLING · 2/5` lockup with the auto-start countdown integrated ("Starts in 1:15 or when full") — delete the redundant right-rail status row, the carousel dots, and fix the trader count math ("Waiting for 3 more"). Fix `YOUR SEAT` card: "Seat 1" as label, buy-in 10 USDC + entry 0.5 as the money line — the giant ambiguous "1 USDC" must go. Anchor all seats: 5 fixed positions around the rail (see PlayerSeat spec), equal-size plaques, tangent to the table curve, never overlapping the engraved rim text; empty seats get a uniform recessed `OPEN SEAT` marker with a soft pulse on the seat that would fill next. Waiting-room plaque variant shows: avatar, name, seat #, `Seated ✓` or `You`, stack (10 USDC), persona badge — no action/bet data (that's the live variant). When a player joins, animate: chair pulls in + coin stack materializes + feed line "The Duchess took seat 2". Make `Invite friends` the dominant right-rail action while filling (it already is — keep it, add copy-link confirmation toast).

## 10 — Waiting room, ready 3/5 (`10-waiting-ready.png`)

**Problems:** status says `Ready to start` while 3/5 and 0:42 countdown — contradicts "starts when full"; "The match begins shortly" adds a third phrasing; otherwise same anchoring issues as 09.

**Prompt:**
> Define and render the two distinct waiting sub-states: (a) FILLING — below min players, countdown paused or absent, copy "Waiting for N more"; (b) COUNTDOWN — min players met, "Match starts in 0:42 · more can still join", seat dots showing who arrived. Remove `Ready to start` from ROOM INFO in favor of the same single source. In the last 10 seconds, escalate: countdown enlarges, ambient light warms, seats lock ("Seats locked — dealing in 0:08"), and disable Leave table with a tooltip during the final 3 seconds to prevent last-second refund edge cases.

## 11 — Waiting room, full 5/5 (`11-waiting-full.png`)

**Problems:** 5/5 but `MATCH STARTING 0:12` still says "All set — dealing you in" in tiny text; plaques (Marquis, Stranger) overlap rim engraving badly; persona badges inconsistent (`UNKNOWN` with `?` icon vs others); INVITE FRIENDS panel still fully visible when table is full — dead UI.

**Prompt:**
> When the table hits 5/5: swap the Invite panel to a 'Table full' roster summary (all five avatars + personas + total pot preview "Pot: 50 USDC + fees"). Replace the center 5/5 lockup with a dealing sequence teaser: "All seated. Dealing in 0:12" and dim the open-seat affordances everywhere. Run the pre-match ritual: each player's coin stack slides from plaque to the rail edge (ante visual), the market screen wipes from placeholder to the live feed with a boot-up animation, and the rim lighting does one slow gold sweep. This 10-second window is the product's best theater moment — currently it's identical to the 2/5 screen with different numbers.

## 12 — Live match, your turn (`12-live-your-turn.png`)

**Problems (core gameplay screen — highest priority):** units are ETH on a USDC table throughout; pot label `18.75` half-buried inside coin pile; players have NO personal chip stacks or committed-bet chips — all action is text-only on plaques ("Called 0.75 ETH ✓"); raise controls confusing: a lone `1.25` chip next to `Raise to 1.25` button (same value twice, no slider, no 2.5x/pot/half-pot presets); timer `0:08` is a small text in the panel corner — no urgency at 8 seconds; timeout defaults (`Check/Fold`, `Check/Call`) exiled to bottom-left ghost panel, disconnected from the action bar they modify; dealer button `D` floats near Duchess unexplained; folded players (Marquis, Chancellor) shown at ~60% right-side, still visually heavier than the acting-relevant info; `Round 3 of 4` bottom-right — round structure (what happens each round?) never communicated; table feed has no timestamps and reads oldest-first ambiguity.

**Prompt:**
> Rebuild the live table per the coin-stack spec (Section 0). Concretely: (1) Personal stacks — every player gets a physical coin stack at their seat sized to their stack value, labeled `2.35 USDC`. (2) Committed zone — calls/raises slide coins in front of the seat with an amount chip; the pot only absorbs them when the betting round closes (animated sweep + pot counter tick). (3) Check = knock ripple + `CHECK` flash, no coins. (4) Fold = committed coins slide to pot, plaque + stack desaturate to 40%, avatar grayscale — folded players visibly diminish (currently their plaques just sit there). (5) Fix pot label: `POT 18.75 USDC` floating above the pile, never occluded. (6) Action bar: Fold (red outline) / Check-or-Call (green, shows amount) / Raise with a drag slider + presets `min · ½ pot · pot · all-in`, amount preview updating the coin animation in ghost form before commit. Delete the duplicated lone `1.25` chip. (7) Timer: circular ring around the action bar, gold >10s, amber 5–10s, red pulse <5s with a soft tick sound; on expiry, auto-apply the selected timeout default. (8) Move timeout defaults INTO the action bar as a small segmented control `If timer ends: Check/Fold ▾`. (9) Dealer button: proper `D` disc on the felt by the seat with tooltip "Dealer — betting starts left of this seat". (10) Round indicator: promote to top-center under the market screen as 4 pips with labels (`Rounds: ●●●○ — Round 3 · betting reopens each round`), tooltip explaining the round → seal → settle structure. (11) Table feed: newest on top, relative timestamps ("4s"), action-colored text (raise gold, call green, fold gray), auto-fade after 20s with hover-to-pin.

## 13 — Live match, opponent's turn (`13-live-opponent-turn.png`)

**Problems:** acting player (Cardinal) shows `Timing out …` but no visible timer anywhere; bottom-center bar "THE CARDINAL IS DECIDING…" duplicates the plaque state; your own stack/committed info is a ghosted bottom-left panel (near-invisible) exactly when you want to plan your next move; nothing communicates what YOU can do next or the current amount to call.

**Prompt:**
> During opponent turns: (1) render the countdown ring around the ACTING player's plaque (the same ring component as your action bar) so everyone sees the clock; when they hit the 30s bank, badge it `BANK`. (2) Delete the bottom-center "is deciding" bar — the spotlight + ring on the seat carries it; instead use that slot for a persistent `YOU` summary: `Stack 2.35 · Committed 0 · To call 0.75 USDC`, fully opaque, always visible during live play. (3) Add a pre-action queue: let the user pre-select `Fold` / `Call any` / `Check` while waiting (standard poker UX) — greyed buttons that arm and auto-fire when action reaches them. (4) Spotlight logic: acting seat at 100% brightness + slight scale, others 80%, folded 40% — a single obvious focal point per state.

## 14 — Sealing phase, open (`14-sealing-open.png`)

**Problems:** the central mechanic (seal a price prediction) appears with almost no ceremony; input pre-filled with current price, no steppers, no % offset shortcuts, no bounds/validation, no indication of what a "good" call looks like; ETH/USD label top-right of panel but chart says BTC/USD (pair mismatch!); no countdown for how long the seal window lasts; right-rail shows pot/bet in ETH again.

**Prompt:**
> Make sealing the signature moment. (1) Fix the pair: the seal panel must reference the table's actual market (BTC/USD) — the current ETH/USD label is a bug. (2) Input: big monospace price field with ± steppers, and quick-offset chips `-1% · -0.5% · current · +0.5% · +1%` that set the value relative to live price; show live delta readout under the field ("+312.40 above market"). (3) Show the seal-window countdown prominently INSIDE the panel ("Seal window closes in 0:24") — right now the deadline that voids your prediction is invisible. (4) Validation: sane bounds (e.g. ±50% of spot) with inline error, block absurd values. (5) On submit, play the seal ritual: envelope/wax-seal animation over the input, then the sealed chip slides to your position panel. The encryption promise copy is good — keep it, add a lock icon and a 'how it works' link. (6) Draw a ghost dashed line on the price chart at your draft value as you type, so the call is spatial before you commit.

## 15 — Sealing phase, sealed (`15-sealing-sealed.png`)

**Problems:** test data ($1,847 call vs $62,499 market) exposed a real bug: the chart y-axis rescaled to include the call line, flattening the live price into a horizontal line at the top — chart becomes useless; "MARKET VS YOUR CALL $60,652.00 above" is confusing phrasing (what is above what?); no indication other players' seal status (who has sealed? who's pending?).

**Prompt:**
> Post-seal state: (1) Never rescale the price chart to include the call line; if the call is >Y% off-viewport, pin an arrow at the chart edge (`▼ your call 1,847 · –97%`) instead of destroying the axis. (2) Rephrase the delta: "Market is $60,652 ABOVE your call" with a colored directional arrow. (3) Add a seal-status strip: five avatar dots that flip from hollow to locked (🔒) as each player seals — anonymous but shows progress ("3/5 sealed · window closes 0:12"). (4) Your sealed call renders as a wax-sealed chip on the felt at your seat — visible, immutable, satisfying. (5) Keep 'Prediction sealed' banner but collapse it to a slim bar after 5s; it currently occupies premium bottom-center space for the rest of the phase.

## 16 — Sealing phase, missed window (`16-sealing-closed-missed.png`)

**Problems:** "The table plays on under its default rules" — nobody knows what default rules means (auto-fold? worst rank? refund?); consequence completely unexplained; visually identical to the sealed state otherwise.

**Prompt:**
> Missed-seal state must state the exact consequence: e.g. "You didn't seal — your prediction defaults to the market price at seal close ($62,519). You're still in the hand but can't win prediction rank." (adjust to actual rules). Add an amber warning treatment to the YOUR POSITION panel (`NOT SEALED — defaulted`) that persists through settlement so the final ranking is explicable. Upstream fix: during the last 10s of the seal window, flash the seal panel border amber and play a warning tick — a missed seal should be nearly impossible, not silent.

## 17 — Price chart overlay (`17-price-chart-overlay.png`)

**Problems:** raw TradingView drop-in: `Bitcoin / TetherUS · Binance` contradicts the product's `BTC/USD` framing; default dark theme (green/red, blue accents) breaks the gold/mahogany identity; UTC timestamp bottom-right; no link between this chart and your sealed call / the match window.

**Prompt:**
> Theme the TradingView widget: custom CSS vars for background (transparent over the room), gold up-candles / muted red down-candles, serif title lockup matching the app, hide the TV symbol-search + watermark if the license allows. Force the symbol label to render as `BTC/USD` (map internally to the feed). Overlay match context on the chart: shaded vertical band for the match window (start → settle), dashed gold line at your sealed call (if sealed), and a countdown chip to settlement. Show times in the user's local timezone. Keep the reassurance copy ("analyse freely, it won't seal your call") — it's good — but move it to a dismissible tooltip after first view.

## 18 — Resolution: settled (`18-resolution-settled.png`)

**Problems (worst screen in the flow):** `You won the pot — 11200000 ETH` — unformatted number, wrong currency, absurd magnitude; `Claim 11200000` button repeats it; settlement price $1,847.12 while ticker shows $52,802 (+2764%!) — test data, but no sanity guard; leaderboard mixes semantics: rows show each player's PREDICTION ($1,862 etc.) but the winner row shows POT WON ($1,847.00) — same column, different meanings; folded players ranked alongside active ones with no payout column; ± deltas unlabeled; no confetti/no ceremony for winning; `Review table` unexplained.

**Prompt:**
> Rebuild settlement. (1) Number formatting everywhere: `1,847.12 USDC`, `Claim 11.2 USDC` — never raw integers, never the wrong currency. (2) Leaderboard columns, explicitly headed: `Rank · Player · Sealed call · Δ from settle · Payout`. Folded players go in a separated dim section labeled `Folded — forfeited pot share`, showing what they left behind. (3) Hero moment: settle price ticks up odometer-style, then the winner row ignites gold, then the pot coin-stack slides across the felt to the winner's seat, THEN the claim card appears. Give victory 3 seconds of theater before the transactional UI. (4) The `±0.12` deltas get direction + label: `0.12 below settle`. (5) `Claim` opens the standard tx ceremony (screens 06–08) with the same visual language; after claim, show tx confirmation + updated wallet balance. (6) Rename `Review table` → `Replay hand` if it's a replay, or cut it. (7) Add rake transparency line: `Pot 50 · rake 1.25 · paid 48.75 USDC`.

## 19 — Resolution: voided (`19-resolution-voided.png`)

**Problems:** raw enum `(NotEnoughPlayers)` leaking into copy; `Refund deposit + entry fee` as a button implies refunds are manual — if the contract auto-refunds this is wrong, if manual it needs explanation; green headline good instinct, rest untreated.

**Prompt:**
> Voided state: map void reasons to human copy ("Not enough players joined before the window closed"), never surface enum names. Refund UX must match the contract reality: if automatic, replace the button with a status row (`Refund of 10.5 USDC sent — view transaction`) and poll to confirmation; if it requires a claim tx, keep the button but label it `Claim refund · 10.5 USDC` and route through the standard tx ceremony. Show the refund breakdown (buy-in 10 + entry 0.5). Keep 'Your funds are safe' headline — it's the right message — and add 'Deal a new table' as the primary next action since this user clearly wanted to play.

---

## Suggested execution order

1. **Section 0** — currency unification, wallet state, PlayerSeat component, status state machine, number formatter. (Everything else depends on these.)
2. **12 + 13** — live table & coin mechanics (the game itself).
3. **14 + 15 + 18** — seal → settle arc (the signature mechanic and its payoff).
4. **09 + 10 + 11** — waiting room ritual.
5. **02 + 04 + 05** — lobby depth.
6. **01, 03, 06–08, 16, 17, 19** — remaining polish.
