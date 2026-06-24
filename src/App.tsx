import { useEffect } from 'react'
import { TableCanvas } from '@/components/table/TableCanvas'
import { Hud } from '@/components/hud/Hud'
import { useGameStore } from '@/store/gameStore'

export default function App() {
  const connect = useGameStore((s) => s.connect)
  const disconnect = useGameStore((s) => s.disconnect)

  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  return (
    <>
      <TableCanvas />
      <div className="scene-vignette" />
      <Hud />
    </>
  )
}
