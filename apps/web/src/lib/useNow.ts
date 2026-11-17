import { useEffect, useState } from 'react'

/**
 * A ticking clock for countdowns. Returns the current epoch-ms, refreshed at
 * the given interval. Kept tiny and shared so round timers stay in sync.
 */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
