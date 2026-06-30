/**
 * Matchmaking REST (§7) — txhash reporting after on-chain create/deposit.
 *
 * The registry is UX-only: capital safety never depends on reporting succeeding
 * (a room the backend never heard about is still refundable on-chain). So all
 * calls here are BEST-EFFORT — they resolve to { ok:false } on any failure and
 * no-op entirely when VITE_MATCHMAKING_URL is unset (not deployed on devnet yet).
 */
import type { CreateRoomReport, DepositReport } from '@/lib/protocol'

const MM_URL = (import.meta.env.VITE_DEVNET_USER as string | undefined)
  ? '/api-proxy'
  : (import.meta.env.VITE_MATCHMAKING_URL as string | undefined)
    ?? (import.meta.env.VITE_API_URL as string | undefined)

interface ReportResult {
  ok: boolean
  roomCode?: string
  seat?: number
  reason?: string
}

async function post(path: string, body: unknown): Promise<ReportResult> {
  if (!MM_URL) return { ok: false, reason: 'matchmaking not configured' }
  try {
    const res = await fetch(`${MM_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { ok: false, reason: `${path} ${res.status}` }
    return (await res.json()) as ReportResult
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

/** POST /rooms — host reports a verified create_and_deposit txhash. */
export function reportCreate(body: CreateRoomReport): Promise<ReportResult> {
  return post('/rooms', body)
}

/** POST /matches/:matchId/deposits — joiner reports a verified deposit txhash. */
export function reportDeposit(matchId: string, body: DepositReport): Promise<ReportResult> {
  return post(`/matches/${encodeURIComponent(matchId)}/deposits`, body)
}
