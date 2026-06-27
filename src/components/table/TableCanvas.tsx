import { useEffect, useRef } from 'react'
import { createTableScene, type TableSceneHandle } from '@/three/table/tableScene'
import { useGameStore } from '@/store/gameStore'

/**
 * Mounts the imperative Three.js table engine into the DOM and keeps a handle
 * to it. The engine lives outside React's render cycle — React only owns the
 * mount/unmount lifecycle. Gameplay overlays render as separate DOM/HUD layers
 * on top of this canvas.
 *
 * The live pot value is the one piece of game state the 3D scene consumes: we
 * subscribe to the store directly (not via a React render) and push it into the
 * scene's coin pile so the heap grows and shrinks with the hand.
 */
export function TableCanvas() {
  const mountRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<TableSceneHandle | null>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const handle = createTableScene(el)
    handleRef.current = handle

    // seed with the current pot, then follow it as the match plays out
    const readPot = (pot: number) => handle.setPot(pot)
    readPot(useGameStore.getState().match?.pot ?? 0)
    let last = useGameStore.getState().match?.pot ?? 0
    const unsub = useGameStore.subscribe((s) => {
      const pot = s.match?.pot ?? 0
      if (pot !== last) {
        last = pot
        readPot(pot)
      }
    })

    if (import.meta.env.DEV) {
      ;(window as unknown as { __setPot?: (n: number) => void }).__setPot = readPot
    }

    return () => {
      unsub()
      handle.dispose()
      handleRef.current = null
    }
  }, [])

  return <div ref={mountRef} className="table-canvas" aria-hidden="true" />
}
