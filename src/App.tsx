import { useEffect } from 'react'
import { TableCanvas } from '@/components/table/TableCanvas'
import { Hud } from '@/components/hud/Hud'
import { Dashboard } from '@/components/hud/Dashboard'
import { useGameStore } from '@/store/gameStore'

export default function App() {
  const view = useGameStore((s) => s.view)
  const loadDiscovery = useGameStore((s) => s.loadDiscovery)
  const disconnect = useGameStore((s) => s.disconnect)

  // Start on the live-games dashboard; connect to a table only when one is picked.
  useEffect(() => {
    void loadDiscovery()
    return () => disconnect()
  }, [loadDiscovery, disconnect])

  return (
    <>
      <TableCanvas />
      <div className="scene-vignette" />
      {view === 'discovery' ? <Dashboard /> : <Hud />}
    </>
  )
}
