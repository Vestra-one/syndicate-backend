import { useEffect } from 'react'
import { TableCanvas } from '@/components/table/TableCanvas'
import { Dashboard } from '@/components/hud/Dashboard'
import { Hud } from '@/components/hud/Hud'
import { useGameStore } from '@/store/gameStore'

/**
 * Root view router.
 *
 * discovery — the live-games lobby (Dashboard) over the 3D table backdrop.
 * table     — the active match: the 3D table + the 2D HUD overlay.
 *
 * The 3D canvas is always mounted (keeps the GPU warm; table persists across
 * the discovery → game transition so the camera swoop into the match feels
 * seamless).  The pot value drives the coin pile in the Three.js scene.
 */
export default function App() {
  const view = useGameStore((s) => s.view)
  const pot = useGameStore((s) => s.match?.pot ?? 0)
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)

  // Kick off the discovery feed on first mount
  useEffect(() => {
    void loadDiscovery()
  }, [loadDiscovery])

  return (
    <>
      {/* Always-on 3D backdrop — pot drives coin pile */}
      <TableCanvas pot={pot} />
      <div className="scene-vignette" />

      {/* Surface switch — one panel at a time */}
      {view === 'discovery' && <Dashboard />}
      {view === 'table' && <Hud />}
    </>
  )
}
