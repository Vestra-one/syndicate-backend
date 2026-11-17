import { describe, expect, it } from 'vitest'
import { edgeRead, typicalMove, volPerSqrtSec } from './edge'

const tape = (steps: number[], dtMs = 1000) => {
  let price = 64_000
  return steps.map((d, i) => ({ price: (price += d), ts: i * dtMs }))
}

describe('edge', () => {
  it('measures realised volatility per √second', () => {
    // ±4 every second → 4 per √s.
    const t = tape(Array.from({ length: 60 }, (_, i) => (i % 2 ? 4 : -4)))
    expect(volPerSqrtSec(t)).toBeCloseTo(4, 5)
    expect(typicalMove(t, 100)).toBeCloseTo(40, 5)
  })

  it('falls back to a BTC-like volatility on a short tape', () => {
    const t = tape([0, 1, -1])
    expect(volPerSqrtSec(t)).toBeNull()
    expect(typicalMove(t, 100)).toBeCloseTo(64_000 * 0.00009 * 10, 3)
  })

  it('reads the gap in typical moves', () => {
    expect(edgeRead(10, 40).level).toBe('in-range')
    expect(edgeRead(-60, 40).level).toBe('needs-move')
    expect(edgeRead(200, 40).level).toBe('long-shot')
    expect(edgeRead(0, 40).fill).toBe(1)
    expect(edgeRead(200, 40).fill).toBe(0)
  })
})
