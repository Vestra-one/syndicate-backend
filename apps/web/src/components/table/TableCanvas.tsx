import { useEffect, useRef } from 'react'
import { createTableScene, type TableSceneHandle } from '@/three/table/tableScene'
import { playCoinClink, onReplayRequest } from '@/lib/coinAudio'
import { useGameStore } from '@/store/gameStore'
import { seatFanAngles } from '@/three/table/tableView'
import type { SeatChipState } from '@/three/table/seatChips'
import type { MatchStateView } from '@/lib/protocol'

/**
 * Snapshot the live seat state into the shape the 3D chip system consumes:
 * each seat's fan angle (shared with the HUD pods) plus its stack and
 * committed-this-round amounts in whole token units (base units are 6-dp).
 */
function seatChipStates(match: MatchStateView | null | undefined): SeatChipState[] {
  if (!match) return []
  const angleFor = seatFanAngles(match.seats.map((s) => s.seat), match.yourSeat)
  return match.seats.map((s) => ({
    seat: s.seat,
    angle: angleFor.get(s.seat) ?? 0,
    stack: Number(s.stack) / 1e6,
    committed: Number(s.committedThisStreet) / 1e6,
    folded: s.folded,
    allIn: s.allIn,
  }))
}

/**
 * Mounts the imperative Three.js table engine into the DOM and keeps a handle
 * to it. The engine lives outside React's render cycle — React only owns the
 * mount/unmount lifecycle. Gameplay overlays render as separate DOM/HUD layers
 * on top of this canvas.
 *
 * The live pot value is the one piece of game state the 3D scene consumes. By
 * default we subscribe to the store directly (not via a React render) and push
 * it into the scene's coin pile so the heap grows and shrinks with the hand.
 *
 * Pass a fixed `pot` to drive a decorative, static heap instead — used by the
 * coming-soon page, which renders the table purely as a showpiece and never
 * connects to a live game. `spin` slowly rotates the whole table (coming-soon only).
 */
export function TableCanvas({ pot, spin = false }: { pot?: number; spin?: boolean } = {}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<TableSceneHandle | null>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    // Decorative landing pour: ring a synthesised coin clink as each coin lands
    // (see coinAudio). The live game stays silent — the pot builds constantly
    // there, so per-coin clinks would be noise, not delight.
    const decorative = pot !== undefined
    // The 3D table is presentation only — every game control lives in the DOM HUD on top
    // of it. If WebGL is unavailable (GPU blocklisted, hardware acceleration off, locked-down
    // or headless browsers) the renderer throws; without this guard that exception unmounted
    // the whole app. Degrade to the HUD over a plain backdrop instead.
    let handle: TableSceneHandle
    try {
      handle = createTableScene(el, {
        autoSpin: spin,
        onCoinLand: decorative ? playCoinClink : undefined,
      })
    } catch (err) {
      console.warn('[table] 3D scene unavailable — continuing without it:', err)
      return
    }
    handleRef.current = handle

    // DEV console helpers — cleared on unmount so they don't retain a disposed scene (and
    // invoking them post-dispose can't drive a torn-down composer).
    let clearDev = () => {}
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>
      w.__setPot = (n: number) => handle.setPot(n)
      w.__knock = (seat: number) => handle.knock(seat)
      w.__awardPot = (seat: number) => handle.awardPot(seat)
      clearDev = () => { delete w.__setPot; delete w.__knock; delete w.__awardPot }
    }

    // Decorative mode: a fixed heap, no store coupling. The price cabinet has no
    // context here (coming-soon landing), so keep it hidden — table as showpiece only.
    if (pot !== undefined) {
      handle.setPot(pot)
      handle.setPriceBoardVisible(false)
      // Enabling sound (or the first user gesture) replays the pour so the coins
      // rain in again audibly — the on-load drop is silent under autoplay policy.
      onReplayRequest(() => handle.replayPour())
      return () => {
        onReplayRequest(null)
        clearDev()
        handle.dispose()
        handleRef.current = null
      }
    }

    // Live mode: seed with the current pot, then follow it as the match plays out.
    // `match.pot` is in token base units (6 dp); the coin pile scales off the
    // human token amount, so a real ~18 USDC pot builds a modest heap rather than
    // saturating the 115-coin cap (which buried the pot label under the coins).
    // `instant` on the seed places coins at rest so joining a hand already in
    // progress shows a settled table, not a replay of every bet that led here.
    //
    // The backend `pot` is a grand total that ALREADY includes every seat's
    // current-street commitment (it's Σ total_contribution). Those same chips are
    // drawn in front of each player as their committed pile, so feeding raw `pot`
    // to the central heap double-counts them. Drive the heap with the chips
    // already *gathered* to the middle — pot minus what's still committed this
    // street — so during a street the heap holds steady while bets sit in front of
    // players, then steps up as the committed piles sweep in at street's end.
    const gatheredPot = (m: MatchStateView | null | undefined): bigint => {
      if (!m) return 0n
      const committed = m.seats.reduce((a, s) => a + s.committedThisStreet, 0n)
      const h = m.pot - committed
      return h > 0n ? h : 0n
    }
    const readPot = (p: bigint, instant = false) => handle.setPot(Number(p) / 1e6, instant)
    readPot(gatheredPot(useGameStore.getState().match), true)

    // Seed the per-seat coin stacks, then follow them as the hand plays out.
    const pushSeats = (m: MatchStateView | null | undefined, instant = false) =>
      handle.setSeats(seatChipStates(m), instant)
    const seedMatch = useGameStore.getState().match
    pushSeats(seedMatch, true)

    // If the match hydrated at mount, we've already snapped it. If it hadn't
    // (mounted before the match arrived), the first subscription tick carrying
    // real seats is still the initial hydration — snap that one too so a mid-hand
    // join never animates its own build-up, whichever path delivers it first.
    let hydrated = !!seedMatch?.seats.length

    // Price board is only visible in-match — on discovery the chart has no context yet.
    handle.setPriceBoardVisible(useGameStore.getState().view === 'table')

    let last = gatheredPot(useGameStore.getState().match)
    let lastView = useGameStore.getState().view
    // A cheap signature of the seat state (≤6 seats) so we only re-push the 3D
    // chips when a stack, bet, fold or seating actually changes.
    const seatSig = (m: MatchStateView | null | undefined) =>
      m ? m.seats.map((s) => `${s.seat}:${s.stack}:${s.committedThisStreet}:${s.folded ? 1 : 0}:${s.allIn ? 1 : 0}`).join('|') + `#${m.yourSeat ?? ''}` : ''
    let lastSeatSig = seatSig(useGameStore.getState().match)
    // Event beats the state diff can't infer: a check moves no money (ripple the
    // felt), a win is a one-time award (stream the pot home). We watch the feed
    // tail so pre-existing history at subscribe time never re-fires.
    let feedMatch = useGameStore.getState().match?.matchId ?? ''
    let feedLen = useGameStore.getState().feed?.length ?? 0
    let awarded = useGameStore.getState().match?.phase === 'SETTLED'
    const unsub = useGameStore.subscribe((s) => {
      // First real snapshot after an empty mount is still hydration, not play.
      const hydrating = !hydrated && !!s.match?.seats.length
      if (hydrating) hydrated = true
      const next = gatheredPot(s.match)
      if (next !== last) { last = next; readPot(next, hydrating) }
      const sig = seatSig(s.match)
      if (sig !== lastSeatSig) { lastSeatSig = sig; pushSeats(s.match, hydrating) }
      if (s.view !== lastView) {
        lastView = s.view
        handle.setPriceBoardVisible(s.view === 'table')
      }
      // check ripples off new feed events
      const mid = s.match?.matchId ?? ''
      const feed = s.feed ?? []
      if (mid !== feedMatch) { feedMatch = mid; feedLen = 0; awarded = s.match?.phase === 'SETTLED' }
      if (feed.length < feedLen) feedLen = 0 // feed was reset/resynced
      for (let i = feedLen; i < feed.length; i++) {
        const e = feed[i]
        if (e.kind === 'action' && e.action === 'check') handle.knock(e.seat)
      }
      feedLen = feed.length
      // pot → winner stream, once, when the match settles. Settlement lands in
      // two steps: the `settled` frame names the winning seats but their amounts
      // hydrate a beat later from the on-chain read. Wait for a positive amount so
      // the stream scales to the real pot won (and only pours to seats that won),
      // instead of firing a placeholder handful off the zero-amount first frame.
      if (s.match?.phase === 'SETTLED' && !awarded) {
        const awards = s.settlement?.awards
        if (awards && awards.some((a) => a.amount > 0n)) {
          awarded = true
          for (const a of awards) if (a.amount > 0n) handle.awardPot(a.seat, Number(a.amount) / 1e6)
        }
      }
    })

    return () => {
      clearDev()
      unsub()
      handle.dispose()
      handleRef.current = null
    }
  }, [pot, spin])

  return <div ref={mountRef} className="table-canvas" aria-hidden="true" />
}
