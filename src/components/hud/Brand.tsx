import { useGameStore } from '@/store/gameStore'

const STATUS_LABEL: Record<string, string> = {
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting',
  offline: 'offline',
}

export function Brand() {
  const status = useGameStore((s) => s.status)
  return (
    <div className="brand panel">
      <div className="brand-mark">SATOSHI'S TABLE</div>
      <div className={`conn conn--${status}`}>
        <span className="conn-dot" />
        <span className="eyebrow">{STATUS_LABEL[status]}</span>
      </div>
    </div>
  )
}
