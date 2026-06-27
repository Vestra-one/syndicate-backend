import { useEffect, useRef } from 'react'
import { createTableScene, type TableSceneHandle } from '@/three/table/tableScene'

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
    return () => {
      handle.dispose()
      handleRef.current = null
    }
  }, [])

  return <div ref={mountRef} className="table-canvas" aria-hidden="true" />
}
