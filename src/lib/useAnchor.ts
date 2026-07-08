import { useEffect, useRef } from 'react'
import type { ScreenPoint } from '@/three/table/tableView'

/** Options for pinning a projected 3D anchor. */
interface AnchorOptions {
  /**
   * Keep the element fully on-screen by clamping its centre so its bounding box
   * stays this many px inside the viewport. The node still rides the table as the
   * camera sways; it just parks at the edge instead of clipping off it (used by the
   * table seat pods, whose extreme side seats would otherwise run past the frame).
   */
  clampMargin?: number
}

/** Pin a DOM node to a projected 3D anchor, updated every animation frame. */
export function useAnchor<T extends HTMLElement = HTMLDivElement>(
  project: () => ScreenPoint | null,
  opts: AnchorOptions = {},
) {
  const ref = useRef<T>(null)
  const { clampMargin } = opts
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
      let { x, y } = p
      if (clampMargin != null) {
        const hw = el.offsetWidth / 2
        const hh = el.offsetHeight / 2
        // Lower bound wins if the element is wider/taller than the safe area.
        x = Math.min(Math.max(x, clampMargin + hw), window.innerWidth - clampMargin - hw)
        y = Math.min(Math.max(y, clampMargin + hh), window.innerHeight - clampMargin - hh)
      }
      el.style.opacity = ''
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [project, clampMargin])
  return ref
}
