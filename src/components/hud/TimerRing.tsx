/**
 * A circular countdown ring. Drives both the your-turn action bar and the
 * opponent pods off the same visual: a sweeping arc that drains as the clock
 * runs down and warms from gold → amber → red as the deadline nears, so the
 * urgency reads the same everywhere at the table (§12.7, §13.1).
 *
 * Purely presentational — the caller owns the clock (server deadline for you,
 * an estimate for opponents) and passes the fraction remaining.
 */
export function TimerRing({
  remainingMs,
  totalMs,
  size = 46,
  stroke = 4,
  label,
  children,
}: {
  remainingMs: number
  totalMs: number
  size?: number
  stroke?: number
  /** short countdown text drawn in the middle (e.g. "8", "0:42"); omit for a bare ring */
  label?: string
  children?: React.ReactNode
}) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const frac = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0
  const secs = Math.ceil(Math.max(0, remainingMs) / 1000)
  // Warmth thresholds mirror the spec: gold >10s, amber 5–10s, red pulse <5s.
  const urgency = secs <= 5 ? 'crit' : secs <= 10 ? 'warn' : 'calm'

  return (
    <span className={`timer-ring timer-ring--${urgency}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="timer-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="timer-ring-arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {(label || children) && <span className="timer-ring-label mono">{children ?? label}</span>}
    </span>
  )
}
