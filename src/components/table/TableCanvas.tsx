import { useEffect, useRef } from 'react'
import { createTableScene, type TableSceneHandle } from '@/three/table/tableScene'
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
    stack: s.stack / 1e6,
    committed: s.committedThisStreet / 1e6,
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
 * connects to a live game.
 */
export function TableCanvas({ pot }: { pot?: number } = {}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<TableSceneHandle | null>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const handle = createTableScene(el)
    handleRef.current = handle

    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __setPot?: (n: number) => void
        __knock?: (seat: number) => void
        __awardPot?: (seat: number) => void
      }
      w.__setPot = (n) => handle.setPot(n)
      w.__knock = (seat) => handle.knock(seat)
      w.__awardPot = (seat) => handle.awardPot(seat)
    }

    // Decorative mode: a fixed heap, no store coupling.
    if (pot !== undefined) {
      handle.setPot(pot)
      return () => {
        handle.dispose()
        handleRef.current = null
      }
    }

    // Live mode: seed with the current pot, then follow it as the match plays out.
    // `match.pot` is in token base units (6 dp); the coin pile scales off the
    // human token amount, so a real ~18 USDC pot builds a modest heap rather than
    // saturating the 115-coin cap (which buried the pot label under the coins).
    const readPot = (p: number) => handle.setPot(p / 1e6)
    readPot(useGameStore.getState().match?.pot ?? 0)

    // Seed the per-seat coin stacks, then follow them as the hand plays out.
    const pushSeats = (m: MatchStateView | null | undefined) => handle.setSeats(seatChipStates(m))
    pushSeats(useGameStore.getState().match)

    // Price board is only visible in-match — on discovery the chart has no context yet.
    handle.setPriceBoardVisible(useGameStore.getState().view === 'table')

    let last = useGameStore.getState().match?.pot ?? 0
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
      const next = s.match?.pot ?? 0
      if (next !== last) { last = next; readPot(next) }
      const sig = seatSig(s.match)
      if (sig !== lastSeatSig) { lastSeatSig = sig; pushSeats(s.match) }
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
      // pot → winner stream, once, when the match settles
      if (s.match?.phase === 'SETTLED' && !awarded) {
        const awards = s.settlement?.awards
        if (awards && awards.length) { awarded = true; awards.forEach((a) => handle.awardPot(a.seat)) }
      }
    })

    return () => {
      unsub()
      handle.dispose()
      handleRef.current = null
    }
  }, [pot])

  return <div ref={mountRef} className="table-canvas" aria-hidden="true" />
}
