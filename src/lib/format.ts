export function formatPrice(value: number | null, currency = 'USD'): string {
  if (value == null) return '—'
  const fractionDigits = value >= 100 ? 2 : value >= 1 ? 3 : 6
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

export function formatAmount(value: number, currency = 'SATS'): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)} ${currency}`
}

/** ms → "M:SS" */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Token base units (6-decimal USDC) → a compact human amount, e.g. 10_500_000 → "10.5". */
export function formatChips(base: number): string {
  return (base / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })
}

/** ms → a countdown that grows an hours field when needed: "4:07", "1:02:30". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatSigned(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}`
}
