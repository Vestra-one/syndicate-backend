import { useEffect, useRef } from 'react'
import { createTableScene, type TableSceneHandle } from '@/three/table/tableScene'
import { useGameStore } from '@/store/gameStore'

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
      ;(window as unknown as { __setPot?: (n: number) => void }).__setPot = (n) => handle.setPot(n)
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
    const readPot = (p: number) => handle.setPot(p)
    readPot(useGameStore.getState().match?.pot ?? 0)
    let last = useGameStore.getState().match?.pot ?? 0
    const unsub = useGameStore.subscribe((s) => {
      const next = s.match?.pot ?? 0
      if (next !== last) {
        last = next
        readPot(next)
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
