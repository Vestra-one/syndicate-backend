import { useEffect, useRef } from 'react'
import { createTableScene, type TableSceneHandle } from '@/three/table/tableScene'
import { useGameStore } from '@/store/gameStore'

/**
 * Mounts the imperative Three.js table engine into the DOM and keeps a handle
 * to it. The engine lives outside React's render cycle — React only owns the
 * mount/unmount lifecycle. Gameplay overlays render as separate DOM/HUD layers
 * on top of this canvas.
 */
export function TableCanvas() {
  const mountRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<TableSceneHandle | null>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const handle = createTableScene(el)
    handleRef.current = handle

    // Feed the live pot value into the 3D chip pile. The scene lives outside
    // React, so we subscribe to the store imperatively and push updates in.
    let lastPot = -1
    const pushPot = (pot: number) => {
      if (pot === lastPot) return
      lastPot = pot
      handle.setPot(pot)
    }
    pushPot(useGameStore.getState().match?.pot ?? 0)
    const unsub = useGameStore.subscribe((s) => pushPot(s.match?.pot ?? 0))

    // dev-only: drive the pile directly for visual iteration (e.g. screenshots)
    if (import.meta.env.DEV) (window as unknown as { __setPot?: (n: number) => void }).__setPot = (n) => handle.setPot(n)

    return () => {
      unsub()
      handle.dispose()
      handleRef.current = null
    }
  }, [])

  return <div ref={mountRef} className="table-canvas" aria-hidden="true" />
}
