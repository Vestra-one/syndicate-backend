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

/**
 * Per-currency display decimals. Every money amount on a table renders with the
 * same fixed precision so `2.8` and `2.35` never sit next to each other ragged.
 */
const MONEY_DECIMALS: Record<string, number> = { USDC: 2, USD: 2, SATS: 0 }

function moneyDecimals(token: string): number {
  return MONEY_DECIMALS[token] ?? 2
}

/**
 * Token base units (6-decimal) → a human amount with thousands separators and a
 * currency-appropriate fixed precision, e.g. 10_500_000 → "10.50",
 * 11_200_000 → "11.20", 1_234_500_000 → "1,234.50". No token suffix — callers
 * that render `{formatChips(x)} {token}` keep working; use `formatMoney` to get
 * the suffix bundled in.
 */
export function formatChips(base: bigint | number, token = 'USDC'): string {
  const digits = moneyDecimals(token)
  // Chips are bigint u64 base units; convert at the display edge (values are bounded well
  // under 2^53 for real amounts, so the float is exact here).
  return (Number(base) / 1e6).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/**
 * Token base units → a fully formatted money string with its currency, the one
 * way an amount should read anywhere in the product: "1,234.50 USDC".
 * `signed` prefixes a `+` on positive values (for deltas / deposits).
 */
export function formatMoney(base: bigint | number, token = 'USDC', opts?: { signed?: boolean }): string {
  const sign = opts?.signed && Number(base) > 0 ? '+' : ''
  return `${sign}${formatChips(base, token)} ${token}`
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
