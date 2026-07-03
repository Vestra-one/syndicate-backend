import { useEffect, useRef } from 'react'
import type { ScreenPoint } from '@/three/table/tableView'

/** Pin a DOM node to a projected 3D anchor, updated every animation frame. */
export function useAnchor<T extends HTMLElement = HTMLDivElement>(project: () => ScreenPoint | null) {
  const ref = useRef<T>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = ref.current
      if (!el) return
      const p = project()
      if (!p || p.behind) {
        el.style.opacity = '0'
        return
      }
      el.style.opacity = ''
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [project])
  return ref
}
