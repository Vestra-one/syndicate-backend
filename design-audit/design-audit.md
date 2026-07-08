# Satoshi's Table — Design Audit

**Reviewer:** Senior Product Designer / Senior Frontend Engineer
**Date:** 2026-07-07
**Build:** `main` @ `0812078` · Vite dev · captured headless (SwiftShader WebGL)
**Benchmark bar:** Stripe · Coinbase · Linear · Raycast · Vercel · Notion · Apple
**Screens:** `/design-audit/screenshots/<Feature>/<screen>-{desktop,tablet,mobile}.png` (20 states × 3 viewports = 60 shots)

---

## 0. Executive summary

Satoshi's Table is a **realtime price-betting game** rendered over an always-on candlelit 3D poker table (Three.js) with a 2D React HUD floating on top. The aesthetic is genuinely premium — a baroque, Fraunces-serif, gold-on-near-black world that most crypto products cannot touch. Several screens (Transaction ceremony, Resolution, Dashboard invite) are already at or near the benchmark bar.

The product is **not** a rough draft; a prior polish pass (`SCREEN-POLISH-PROMPTS.md`, 2026-07-04) already fixed the worst offenders: currency is now consistently USDC, the dashboard was rebuilt with scannable rows, number formatting is unified, and the join flow shows the seat-cost math. This audit therefore holds it to a **higher** bar and targets what still separates it from "shippable" and "best-in-class."

Three problems dominate, in priority order:

1. **Mobile is broken for the entire in-match experience.** The HUD (`waiting`, `live`, `sealing`, `resolution`) is a corner-pinned desktop layout — `.hud-bottom` is a 3-column flex and `<Seats>` are anchored to projected 3D points. At 390 px these panels stack on top of each other, and the action buttons (Fold/Call/Raise) run off the right edge. A crypto game with an unusable phone experience leaves most of its market on the table. *(Lobby / Create / Tx cards survive mobile because they're centered single columns.)*
2. **The live table carries too much cognitive load at the exact moment money is at risk.** "Your turn" is announced **three** times simultaneously (top banner, action-panel header, bottom-right round card); `YOUR POSITION` repeats the stack/committed figures already in the action panel; six competing panels plus the 3D scene fight for a single glance.
3. **Two visual-integrity breaks read as bugs.** Right-side seat pods **clip off the viewport edge** on desktop (`THE CHANCEL…`, stacks cut mid-number), and the full-screen **price chart is a raw TradingView embed** whose red/green candles and default dark theme shatter the baroque world the rest of the app builds.

Everything else is refinement. Details, per-screen scores, and a prioritized execution plan follow.

> **Note on wallet state:** captures run headless with no injected wallet, so every header shows `Connect Wallet` — this is a **capture artifact, not a defect** (`WalletMenu` reads the live wallet-adapter `connected` flag; being seated implies a connection in production). It is not counted against any screen below, but the connected chip + seated-stack indicator should be verified on a funded wallet.

---

## 1. Global design system

**Strengths**
- `tokens.css` is a real, disciplined token set: surfaces, a full gold ramp, directional up/down accents, status colors, type stack (Fraunces / system-ui / mono), 8-pt-ish geometry (`--pad:16`, `--radius:12/8`), one shared easing curve. This is why the app feels coherent.
- Consistent use of `mono` + `tabular-nums` for all money — the single biggest driver of a "financial-grade" feel.
- Copy is unusually good: void reasons are humanized, seal is explained ("encrypted on your device… no one, not even the server"), economic terms carry ⓘ tooltips.

**System-level problems**
| # | Problem | Where | Severity |
|---|---------|-------|----------|
| G1 | No responsive strategy for the HUD; panels are fixed/absolute and 3-across | all in-match screens < ~900 px | **Critical** |
| G2 | `--gold-rgb` is referenced ~40× in `hud.css` (`rgba(var(--gold-rgb,…))`) but **never defined** in `tokens.css` — everything silently falls back to `212,175,55`, a *different* gold than `--gold #caa23f`. Two golds ship. | global | High |
| G3 | Low-contrast body text: `--text-faint #6f5d3e` and `--text-dim` on near-black fail WCAG AA (≈2.5:1) for the small-caps labels used everywhere. | global | High (A11y) |
| G4 | No `prefers-reduced-motion` guard found for the bloom/parallax/coin animations; vestibular-sensitivity risk. | global | Medium (A11y) |
| G5 | Fraunces loaded from Google Fonts (render-blocking preconnect, `display=swap`) — FOUT + third-party dependency + privacy. Self-host + `size-adjust`. | `index.html` | Medium |
| G6 | Emoji used as functional iconography (🔥💰🎟🕐🔒⏳♛) — inconsistent cross-platform rendering, no a11y labels, off-brand vs. the engraved gold language. | dashboard filters, seal, reveal | Medium |
| G7 | Focus-visible states not evident; keyboard/screen-reader path through the betting panel and modals unverified. | global | High (A11y) |

---

## 2. Per-screen review

Scores are out of 10, benchmarked against the products listed above (not against "typical crypto"). **M** = the mobile score where it diverges sharply from desktop.

### 2.1 Landing / Coming-Soon — `Landing/`
**Scores:** Visual **9** · UX **7** · Hierarchy **8** · A11y **5** · Conversion **6** · Consistency **8**

The showpiece. The 3D table + coin pour + wordmark is a genuine "wow." Mobile reflows correctly to a stacked hero.

**Problems**
- **Conversion:** the only actions are three social icons (Telegram/Discord/X). A pre-launch landing with this much visual equity should **capture email/waitlist** — the highest-value action is missing.
- "ALMOST READY" eyebrow is vague; no launch date, no "notify me."
- The engraved rim date `JAN · 03 · 2009` (genesis-block flavor) reads as a stale placeholder to anyone who doesn't get the reference.
- A11y: dim-gold body copy on black; social icon buttons need labels.
- Two wordmarks exist — "Satoshi Table" (landing) vs "SATOSHI'S TABLE" (app). Pick one.

### 2.2 Dashboard — empty / first-run — `Dashboard/dashboard-empty`
**Scores:** Visual **8** · UX **8** · Hierarchy **8** · A11y **6** · Conversion **7** · Consistency **8**

Strong first-run: wordmark → "Predict the price. Outlast the table." → 3-step explainer (Buy in → Seal your call → Closest takes pot) → single gold CTA. This is the correct pattern.

**Problems**
- The hero card is **semi-transparent over the busy 3D table**, dropping the 3-step body text contrast to marginal. Add a solid/heavier scrim behind text.
- The 3-step body copy uses `--text-dim` (fails AA at that size).
- The live-status footer ("No open tables yet · 6s ago") is easy to miss — first-timers may not realize tables appear here.

### 2.3 Dashboard — populated — `Dashboard/dashboard-populated`
**Scores:** Visual **8** · UX **8** · Hierarchy **8** · A11y **6** · Conversion **8** · Consistency **8**

Excellent redesign: OPEN rows (asset pair, big buy-in, discrete seat dots, stacked avatars, ring countdown, gold `Join →`) are clearly differentiated from LIVE rows (green LIVE dot, pot as hero, sparkline, watcher count, outline `Watch`). Filters + "closing soonest" default are right.

**Problems**
- Filter chips (`🔥 Hot`, `💰 Biggest pot`, `🎟 Lowest buy-in`, `🕐 Newest`) rely on emoji; active-state is not obviously selected (see G6).
- Sparklines on LIVE rows are very faint — near-invisible on the dark felt.
- Seat-dot / avatar cluster competes with the countdown ring for the eye at mid-row; consider one dominant mid element.
- Hover/lift states can't be verified in static capture — ensure they exist and are keyboard-reachable.

### 2.4 Dashboard — invite — `Dashboard/dashboard-invite`
**Scores:** Visual **8** · UX **9** · Hierarchy **8** · A11y **6** · Conversion **9** · Consistency **8**

Near-perfect. Concrete banner ("THE BANKER INVITED YOU · BTC/USD · 25 USDC buy-in · 4/6 seated · closes in 4:00") with `Connect & take seat` / `Dismiss`, and the invited row is highlighted with a `◆ YOUR INVITE` ribbon. This is exactly right.

**Problems**
- Inviter avatar is a generic glyph — a real identicon/ENS-style avatar would add trust.
- Banner + list can push the page tall; verify no clipping when 3+ open tables exist.

### 2.5 Lobby — Join — `Lobby/lobby-join`
**Scores:** Visual **8** · UX **7** · Hierarchy **7** · A11y **6** · Conversion **8** · Consistency **7**

The join card is excellent: table id, `2/5 SEATED`, "You'll sit at seat 3", every economic term with ⓘ, and the decisive `10 buy-in + 0.5 entry = 10.5 USDC` total above the CTA.

**Problems**
- The **seated-player pods float behind / are half-occluded by the card** ("THE BANKER" clipped, a second pod hidden under the panel). The spatial "who's already here" idea is good but the collision makes it look broken.
- `Connect Wallet` in the header overlaps nothing on desktop but is **clipped off the right edge on mobile** (header doesn't shrink).
- The empty/near-empty chart above shows a mostly-flat gold line; the "waiting for first tick" state is better than before but still reads as thin.

### 2.6 Lobby — Create — `Lobby/lobby-create`
**Scores:** Visual **8** · UX **8** · Hierarchy **8** · A11y **6** · Conversion **8** · Consistency **8**

Well-structured: buy-in presets + custom, fill-window presets + custom, a plain-language "You're setting up: 5 seats · 10 USDC · pot up to 50 USDC · rake 2.5%" summary, collapsible Table Rules, and the same seat-cost total.

**Problems**
- "You'll be first in…" headline is long and wraps to two lines, competing with the `0/5 SEATED` counter to its right.
- Preset chips (5/10/25/50/100) and (20s/1m/5m/15m/1h) are visually identical to the input fields; selected-state is subtle.
- `TABLE RULES ▾` disclosure gives no hint of what's inside.

### 2.7 Transaction ceremony — `Transaction/`
**Scores:** Visual **9** · UX **9** · Hierarchy **9** · A11y **7** · Conversion **8** · Consistency **9**

**The best screen in the app.** Focused modal, animated seal, "Approve in your wallet," the amount as hero (`10.5 USDC · buy-in + entry fee`), and a PREPARE → APPROVE → FINALIZE stepper with live state. The error state ("Transaction simulation failed: insufficient USDC balance") is clear and recoverable. This is the template the rest of the app should aspire to.

**Problems**
- Error copy passes the **raw chain error** through ("Transaction simulation failed:…") — humanize it ("Not enough USDC — you need 10.5, add funds and retry") with the raw string behind a "details" toggle.
- Cancel is a low-contrast text link; give it a proper ghost-button target.
- Confirm the modal traps focus and is dismissible with Esc.

### 2.8 Waiting room — `WaitingRoom/`
**Scores (desktop):** Visual **7** · UX **6** · Hierarchy **6** · A11y **5** · Conversion **6** · Consistency **6**  ·  **Mobile: 2**

Ambitious full-surface console: left rail (Your seat / How it works / Recent activity), right rail (Invite friends / Room info), a seat ring on the felt, centre "TABLE FILLING 2/5" caption, bottom dock.

**Problems**
- **Redundant status:** the centre reads "TABLE FILLING · 2/5 · WAITING FOR 3 MORE TRADERS" **and** a pill directly below repeats "Waiting for 3 more traders." Say it once.
- The centre caption overlaps the felt engraving and the seat pods (THE DUCHESS pod sits on top of an OPEN SEAT and the "2/5").
- Empty price chart shows a single stub line at the far left — the "awaiting first tick" state is weak (should be a dimmed grid + pulsing last-price dot + label).
- Seat pods overlap each other and the centre number.
- **Mobile (critical):** the two rails are absolutely positioned to screen corners, so at 390 px `INVITE FRIENDS` and `ROOM INFO` stack on top of the centre caption; the bottom dock (Leave / Sound / trust seal) overflows off the right edge. Unusable.

### 2.9 Live match — `LiveMatch/`
**Scores (desktop):** Visual **7** · UX **5** · Hierarchy **5** · A11y **5** · Conversion **6** · Consistency **6**  ·  **Mobile: 1**

The core money-moment, and the screen with the most to fix. The 3D coin choreography, per-seat pods with persona tags, live feed, price cabinet and action panel are all individually well-made — but they compete.

**Problems**
- **"Your turn" is stated three times at once:** the top banner ("YOUR TURN — CHOOSE AN ACTION BELOW ↓ · 14S LEFT"), the action-panel header ("YOUR TURN" + ring timer), and the bottom-right round card ("LIVE · Round 3 of 4 · YOUR MOVE"). Three countdowns, one turn. Pick one primary turn signal.
- **`YOUR POSITION` (bottom-left) duplicates** the `stack` / `committed` values already shown in the action panel's exposure row — two sources of truth for the same numbers, side by side.
- **Right-side seat pods clip off the viewport** (`THE CHANCEL…`, `THE MARQUIS` stack cut to "1.60 USD"). Reads as a layout bug on the flagship screen.
- **Pot label is occluded by the 3D coins** ("18.·75") — the number should always float clear above the pile.
- Six+ simultaneous surfaces (feed, position, action, round card, 6 pods, cabinet) — high cognitive load exactly when focus should be on the decision.
- **Mobile (critical):** total collapse — banner overlaps header + chart, feed panel truncated, `YOUR POSITION` overlaps the pot and action panel, and Fold/Call/All-in/Raise run off the right edge. The primary action is physically unreachable.

### 2.10 Sealing — `Sealing/`
**Scores (desktop):** Visual **8** · UX **7** · Hierarchy **7** · A11y **6** · Conversion **7** · Consistency **7**  ·  **Mobile: 2**

The seal panel is good: `$` prefixed price input, ±% quick-offset chips, live "+3.29 above market" delta, "encrypted on your device… how it works ↗", and a lock CTA. The sealed / closed-missed states are handled with care.

**Problems**
- Same right-pod clipping and pot occlusion as Live (shared HUD chrome).
- The `SEAL YOUR PREDICTION` panel and the persistent `YOUR POSITION` panel both sit at the bottom — the seal moment should own the bottom-center without the position panel beside it.
- The offset chips (`-1% / -0.5% / now / +0.5% / +1%`) are visually identical to buttons elsewhere; the selected offset isn't reflected back.
- **Mobile:** inherits the HUD breakage.

### 2.11 Price-chart overlay — `PriceChart/`
**Scores:** Visual **5** · UX **7** · Hierarchy **7** · A11y **6** · Conversion **7** · Consistency **3**

Functionally the right idea — "Live market — analyse freely, it won't seal your call" is a great reassurance, and a full candlestick chart is genuinely useful.

**Problems**
- **It's a raw TradingView embed.** Default dark theme, TradingView red/green candles, TradingView fonts, TV watermark, `13:18:56 UTC`. It looks like a different application pasted over the game and **destroys the baroque consistency** the rest of the app maintains. Either theme the widget to the gold/near-black palette (TradingView supports overrides) or render the chart natively to match the price cabinet.
- Console error in capture: "Cannot listen to the event from the provided iframe, contentWindow is not available" — verify the widget initializes cleanly.
- The close `×` is the only exit; add Esc + backdrop-click.

### 2.12 Resolution — Settled — `Resolution/resolution-settled`
**Scores:** Visual **8** · UX **8** · Hierarchy **8** · A11y **6** · Conversion **8** · Consistency **8**

A real "ceremony": settlement price as hero, a ranked reveal table (rank, player, sealed call, Δ from settle color-coded above/below, payout), folded-players section, pot/rake/paid transparency line, "You won the pot — 11.20 USDC," and a single gold `Claim` CTA. Excellent.

**Problems**
- **The ceremony doesn't take over the screen.** The `TABLE FEED`, `YOUR POSITION`, and the bottom-right `SETTLED` mini-card remain visible (and the right pods still clip) behind the card — a climactic moment should dim/blur everything else to a single focal card.
- Reveal-table columns are dense; on smaller widths the four right columns will crowd (verify mobile — the settled state renders but needs a stacked layout).
- Winner is marked with a ♛ emoji (see G6).

### 2.13 Resolution — Voided — `Resolution/resolution-voided`
**Scores:** Visual **8** · UX **9** · Hierarchy **8** · A11y **7** · Conversion **8** · Consistency **8**

Exemplary trust design: "MATCH VOIDED → **Your funds are safe**," a plain-language reason, the refund math (`buy-in 10.00 + entry 0.50 = 10.50 USDC`), and `Claim refund · 10.50 USDC`. Never framed as a loss. This is how you keep users after a failure.

**Problems**
- Background chrome is dimmed but still present (less egregious than settled).
- "Claim refund" and the settled "Claim" should share one button component/appearance.

---

## 3. Improvement plan (by screen, prioritized by impact)

Each screen lists its **goal** and improvements grouped per the requested dimensions. Only non-empty groups are shown.

### P0 — Live match *(core money-moment; worst cognitive load + clipping; mobile-critical)*
**Goals:** clarity · confidence · speed (act correctly in <20 s without hunting)
- **Layout:** collapse to a single turn signal. Keep the action panel as the one place for "your turn + timer"; demote the top banner to a lightweight "opponents acting" ticker when it's *not* your turn and hide it when it is; fold the bottom-right round card's "YOUR MOVE" into the round pill only.
- **Layout:** constrain `<Seats>` to a safe inset so no pod clips the viewport (clamp projected X/Y to a margin; shrink pods, or move overflowing pods inboard).
- **Components:** merge `YOUR POSITION` into the action panel (one exposure block: stack / committed / to-call), freeing the bottom-left corner (use it for the feed or remove).
- **Interaction / Motion:** ensure the pot label renders in a DOM layer *above* the coin canvas (never occluded); tick it during sweeps.
- **Mobile:** define a phone HUD — action panel becomes a full-width bottom sheet; feed collapses to a 1-line ticker or a tappable drawer; seat pods become a compact top strip (avatar + stack) instead of table-anchored plaques.
- **Accessibility:** turn timer needs `role="timer"`/`aria-live`; action buttons need visible focus; arm-buttons need pressed state exposed.

### P0 — Mobile HUD system *(cross-cuts Waiting / Live / Sealing / Resolution)*
**Goals:** usable core game on phones
- **Layout:** introduce a mobile HUD mode below ~768 px — replace the corner-pinned `.hud-bottom` 3-column flex with a single-column bottom-sheet stack; move rails into a top sheet / tab; keep the 3D table as a shrunken backdrop, not the primary surface.
- **Components:** one `BottomSheet` primitive reused by betting, seal, room-info, ceremony.
- **Performance:** consider lowering DPR / disabling bloom on mobile GPUs.

### P1 — Waiting room
**Goals:** anticipation · trust · shareability (get more seats filled)
- **Layout:** de-conflict the centre caption from the seat ring (raise caption above the felt; give pods a clear ring radius that never overlaps it).
- **Components:** single status source ("Filling · 2/5 · waiting for 3") — delete the duplicate pill.
- **Empty states:** real "awaiting first tick" chart (dimmed grid + pulsing last-price dot + label).
- **Mobile:** collapse rails into a top summary + an "Invite" sticky button; dock becomes a bottom bar.

### P1 — Price-chart overlay
**Goals:** consistency · analytical usefulness
- **Color / Consistency:** theme TradingView to the gold/near-black palette (candle up = `--up`, down = `--down`, grid = hairline, background = `--bg-void`, hide watermark) — or render natively to match the price cabinet.
- **Interaction:** Esc + backdrop-click to close.

### P2 — Resolution (settled + voided)
**Goals:** delight · trust · payout confidence
- **Layout / Motion:** on settle/void, dim+blur the entire HUD to a single focal ceremony card (kill the feed/position/mini-card/pod clipping behind it).
- **Components:** shared `ClaimButton`; replace ♛ emoji with an engraved crown glyph.
- **Mobile:** stack the reveal table (card-per-player) below ~600 px.

### P2 — Lobby join/create
**Goals:** confidence · conversion
- **Layout:** keep seated pods from colliding with the card (either inset the ring or render seats only outside the card's bounding box).
- **Components:** stronger selected-state on preset chips; label the `TABLE RULES` disclosure with a one-line preview.

### P3 — Dashboard (empty/populated/invite)
**Goals:** conversion · scannability
- **Color:** heavier scrim behind the first-run hero text; brighten LIVE sparklines.
- **Components:** replace emoji filter chips with engraved icons + a clear active pill; real avatars for invited/seated players.

### P3 — Landing
**Goals:** conversion (waitlist) · trust
- **Components:** add email/waitlist capture as the primary action; keep socials secondary.
- **Copy:** launch date or "notify me"; unify the wordmark with the app.

### P3 — Global system
- Define `--gold-rgb: 202,162,63;` in `tokens.css` (kill the second gold — **G2**).
- Raise `--text-faint`/`--text-dim` or their usage to meet AA; add `:focus-visible` rings; add `prefers-reduced-motion`.
- Self-host Fraunces; give emoji-icons real a11y labels or replace with SVG.

---

## 4. Recommended Phase-4 execution order

1. **Live match (desktop)** — highest-traffic, highest-stakes single screen; fixes the 3× turn redundancy, pod clipping, pot occlusion, and `YOUR POSITION` duplication. Biggest perceived-quality jump per unit of work.
2. **Mobile HUD system** — unlocks the whole in-match experience on phones (Waiting/Live/Sealing/Resolution) via one bottom-sheet layout mode.
3. **Waiting room** polish (dedupe status, empty chart, ring de-conflict).
4. **Price-chart theming.**
5. **Resolution focus mode.**
6. Lobby chips → Dashboard scrim/sparklines/avatars → Landing waitlist → global tokens/a11y.

> Each Phase-4 screen is executed **one at a time**: change → before/after screenshots → design-decision rationale → **wait for review** before the next.
