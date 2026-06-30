import { useEffect } from 'react'
import { TableCanvas } from '@/components/table/TableCanvas'
import { Dashboard } from '@/components/hud/Dashboard'
import { Hud } from '@/components/hud/Hud'
import { useGameStore } from '@/store/gameStore'
import { startPriceFeed } from '@/lib/realtime/priceFeed'

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
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)

  // Kick off the discovery feed on first mount
  useEffect(() => {
    void loadDiscovery()
  }, [loadDiscovery])

  // Stream live BTC/USD ticks into the cabinet chart (keeps it alive pre-match).
  useEffect(() => {
    const feed = startPriceFeed('BTCUSD', useGameStore.getState().ingestLivePrice)
    return () => feed.stop()
  }, [])

  return (
    <>
      {/* Always-on 3D table: candlelit felt + price cabinet + pot heap. Live mode
          (no `pot` prop) → the coin pile follows the match pot from the store. */}
      <TableCanvas />
      <div className="scene-vignette" />

      {/* Surface switch — one panel at a time. The HUD layers players (Seats),
          the pot label, and the betting panel over the 3D table during a match. */}
      {view === 'discovery' && <Dashboard />}
      {view === 'table' && <Hud />}
    </>
  )
}
