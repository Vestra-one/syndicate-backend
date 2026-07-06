/**
 * Syndicate v2 REST client (`/v1/*`) — the single authoritative HTTP surface.
 *
 * v2 consolidated the old api/config/matchmaking split into one service. Every response
 * is an additive-versioned envelope `{ v:1, server_time_ms, ... }`; errors are
 * `{ error: { code, message } }` with a proper HTTP status (§13). Wire fields are
 * snake_case with NO serde renames — the interfaces below mirror them verbatim.
 *
 * Conventions (§1): chips are u64 JSON numbers (USDC base units); REST timestamps are
 * **ms epoch**; prices are decimal strings. Wallet-bound routes need `Authorization:
 * Bearer <session>` — see `ensureSession`.
 */
import type { Chips } from '@/lib/protocol'

// v2 talks to VITE_API_URL (already `.../v1`) DIRECTLY — the server has open CORS and no
// basic auth, and the session's `Authorization: Bearer` must reach it untouched. The
// legacy VITE_DEVNET_USER proxy branch remains only for local backends that still need
// header injection; the proxy passes Bearer through (vite.config.ts) when set.
// The `/api-proxy` branch is a LOCAL-DEV-ONLY convenience (Vite dev server injects auth
// and rewrites to the backend). It must never activate in a production build — Netlify has
// no such proxy — so gate it on import.meta.env.DEV even if VITE_DEVNET_USER leaks into the
// build env. Production always talks to VITE_API_URL directly (backend has open CORS).
const API_BASE = (import.meta.env.DEV && (import.meta.env.VITE_DEVNET_USER as string | undefined))
  ? '/api-proxy'
  : (import.meta.env.VITE_API_URL as string | undefined)

/** A structured backend error (`{ error: { code, message } }`), carrying the HTTP status. */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// ---------------------------------------------------------------------------
// Session (auth) — nonce → sign → verify → Bearer token (24h; §2)
// ---------------------------------------------------------------------------

interface Session {
  wallet: string
  token: string
  expiresAt: number // ms epoch
}

const SESSION_KEY = 'syn.session.v2'
let session: Session | null = loadSession()

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Session
    return s.token && s.wallet && s.expiresAt ? s : null
  } catch {
    return null
  }
}

function saveSession(s: Session | null) {
  session = s
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* private-mode / storage-disabled — session lives in-memory only */
  }
}

/** Renew ≥60s before expiry so an in-flight request never races the boundary. */
function sessionValidFor(wallet: string): boolean {
  return !!session && session.wallet === wallet && session.expiresAt - 60_000 > Date.now()
}

/** Drop the cached session (e.g. on wallet switch or a 401). */
export function clearSession() {
  saveSession(null)
}

/** The current Bearer token, if a live session exists. */
export function currentToken(): string | null {
  return session && session.expiresAt > Date.now() ? session.token : null
}

/**
 * Ensure a live Bearer session for `wallet`, running the nonce→sign→verify handshake
 * only when the cached token is missing/expired/for-another-wallet. `sign` returns a
 * base64 ed25519 signature of the utf8 message (the wallet adapter's `signMessageBase64`).
 */
export async function ensureSession(
  wallet: string,
  sign: (message: string) => Promise<string>,
): Promise<string> {
  if (sessionValidFor(wallet)) return session!.token
  const { nonce } = await postJson<{ nonce: string; expires_at: number }>(
    '/auth/nonce',
    { wallet },
    false,
  )
  const signature = await sign(nonce)
  const verified = await postJson<{ session: string; wallet: string; expires_at: number }>(
    '/auth/verify',
    { wallet, signature },
    false,
  )
  saveSession({ wallet: verified.wallet, token: verified.session, expiresAt: verified.expires_at })
  return verified.session
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------

interface RequestOpts {
  method?: 'GET' | 'POST'
  body?: unknown
  auth?: boolean // attach the Bearer session
  signal?: AbortSignal
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  if (!API_BASE) throw new ApiError('config', 'VITE_API_URL is not set — configure the v2 API base', 0)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.auth) {
    const token = currentToken()
    if (!token) throw new ApiError('unauthenticated', 'No active session — call ensureSession first', 401)
    headers.Authorization = `Bearer ${token}`
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal ?? AbortSignal.timeout(12_000),
  })

  if (!res.ok) {
    if (res.status === 401 && opts.auth) clearSession() // stale token — force re-auth next call
    let code = `http_${res.status}`
    let message = `${path} ${res.status}`
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } }
      if (j.error) {
        code = j.error.code ?? code
        message = j.error.message ?? message
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(code, message, res.status)
  }
  return parseJsonU64Safe(await res.text()) as T
}

/**
 * JSON.parse that survives u64-sized integers. The backend emits full u64s (e.g.
 * `max_oracle_confidence: 18446744073709551615` = u64::MAX in create_params), which
 * JSON.parse silently rounds to a float (→ wrong Borsh bytes on-chain, and BN.js throws
 * a bare "Assertion failed" for numbers ≥ 2^53). Quote any ≥16-digit integer value into
 * a string pre-parse; consumers (BN) accept decimal strings losslessly.
 *
 * A u64 value is a digit run sitting in JSON value position: right after `:` (object value)
 * or `[`/`,` (array element), and right before `,`/`}`/`]`. The trailing delimiter is a
 * LOOKAHEAD so it isn't consumed — otherwise adjacent big integers in an array (`[a,b]`)
 * would share a delimiter and every other element would be missed. Digits inside a string
 * (e.g. a base58 signature) are preceded by `"` or an alnum char, so they never match.
 */
export function parseJsonU64Safe(text: string): unknown {
  const quoted = text.replace(/([:,[]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"')
  return JSON.parse(quoted)
}

function postJson<T>(path: string, body: unknown, auth: boolean): Promise<T> {
  return request<T>(path, { method: 'POST', body, auth })
}

/** Build a `?a=1&b=2` query string, skipping null/undefined values. */
function qs(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// ---------------------------------------------------------------------------
// Wire types (snake_case, verbatim from the game-server DTOs)
// ---------------------------------------------------------------------------

/** Numeric range bound. */
export interface Range<T = number> { min: T; max: T }

/** `GET /v1/config` — bounds, defaults, feeds, drand beacon. */
export interface ApiConfig {
  v: number
  server_time_ms: number
  program_id: string
  chips_token_mint: string
  feeds: { feed: string; oracle_symbol: string; oracle_token: string }[]
  bounds: {
    buy_in: Range
    fill_window_sec: Range
    streets: Range
    street_duration_sec: Range
    observation_sec: Range
    players: Range
  }
  defaults: {
    seal_window_sec: number
    begin_live_window_sec: number
    action_timeout_ms: number
    time_bank_sec: number
    rake_bps: number
    entry_fee: number
  }
  drand: { api: string; chain_hash: string; genesis_time: number; period_sec: number; scheme: string }
}

/** The byte-exact `create_and_deposit` params the server computed for an intent (§4). */
export interface ApiCreateParams {
  match_id: number
  buy_in: number
  entry_fee: number
  rake_bps: number
  rake_cap: number
  min_players: number
  max_players: number
  is_private: boolean
  room_commitment: string // hex (32B)
  config_hash: string // hex (32B)
  price_token: string // hex (20B)
  total_betting_duration_sec: number
  seal_window_sec: number
  begin_live_window_sec: number
  fill_window_sec: number
  /** u64 — arrives as a decimal STRING when ≥16 digits (u64::MAX today; see parseJsonU64Safe). */
  max_oracle_confidence: number | string
  oracle_exponent: number
}

export interface CreateIntentRequest {
  feed: string
  buy_in: number
  fill_window_sec: number
  min_players: number
  max_players: number
  streets: { count: number; durations_sec: number[]; observation_sec?: number[] }
  visibility: 'public' | 'private'
}

export interface CreateIntentResponse {
  v: number
  server_time_ms: number
  intent_id: string
  onchain_match_id: number
  match_pda: string
  room_code: string | null
  room_commitment: string
  config_hash: string
  timelock_target_hint: number
  expires_at: number
  create_params: ApiCreateParams
  derived: { small_blind: number; big_blind: number; total_betting_duration_sec: number }
}

export interface SubmitRoomResponse {
  v: number
  server_time_ms: number
  match_id: string // uuid
  onchain_match_id: number
  seat_status: string // "pending_verify"
  replayed?: boolean
}

export interface RoomByCodeResponse {
  v: number
  server_time_ms: number
  match_id: string
  onchain_match_id: number
  match_pda: string
  feed: string
  buy_in: number
  min_players: number
  max_players: number
  seats_confirmed: number
  candidates: number
  fill_deadline: number | null
  join_commitment: string // hex (32B)
}

export interface SubmitDepositResponse {
  v: number
  server_time_ms: number
  match_id: string
  status: string // "pending_verify"
}

/** Candidate → confirmed lifecycle (§5). */
export interface CandidateStatus {
  v: number
  server_time_ms: number
  status: string // pending_verify → candidate → confirmed | not_confirmed | rejected
  seat_index: number | null
  finalized_slot: number | null
  reason: string | null
}

export interface LobbyRoom {
  match_id: string
  onchain_match_id: number
  phase: string
  feed: string
  buy_in: number
  min_players: number | null
  max_players: number | null
  round_count: number | null
  confirmed: number
  candidates: number
  fill_deadline: number | null
  created_at: number
}

export interface LiveMatch {
  match_id: string
  onchain_match_id: number
  phase: string
  feed: string
  buy_in: number
  round_count: number | null
  live_start: number | null
  scheduled_end: number | null
  feed_price: string | number | null
}

export interface HistoryMatch {
  match_id: string
  onchain_match_id: number
  phase: string
  feed: string
  buy_in: number
  void_kind: string | null
  ended_at: number | null
}

export interface ActiveSeat {
  match_id: string
  phase: string
  seat_index: number | null
  deadline_ts: number | null
}

export interface Claimable {
  match_id: string
  onchain_match_id: number
  match_pda: string
  kind: 'payout' | 'refund'
  reason: string
  seat_index: number
  refund_amount_hint: number | null
}

/** `GET /v1/matches/{id}` — full detail (params, timing, seats, reveal). */
export interface MatchDetail {
  v: number
  server_time_ms: number
  match_id: string
  onchain_match_id: number
  phase: string
  visibility: string
  feed: string
  params: {
    buy_in: number
    entry_fee: number
    rake_bps: number
    rake_cap: number
    min_players: number
    max_players: number
    round_count: number
    round_durations_sec: number[]
    observation_windows_sec: number[]
    action_timeout_ms: number
    small_blind: number
    big_blind: number
    seal_window_sec: number
    config_hash: string | null
  }
  timing: {
    fill_deadline: number | null
    lock_ts: number | null
    seal_deadline: number | null
    live_start: number | null
    scheduled_end: number | null
    street_schedule: { street: number; open: number; close: number; end: number }[]
    timelock_target: number | null
  }
  button: number | null
  seats: {
    seat_index: number
    wallet: string
    sealed: boolean
    prediction_source: string | null
    stack: number | null
    committed: number | null
    total_contribution: number | null
    folded: boolean | null
    all_in: boolean | null
  }[]
  pot: number | null
  round: number | null
  current_bet: number | null
  to_act: number | null
  /** The open turn (server ≥ turn-recovery patch) — carries the TRUE action deadline. */
  turn?: { seat: number; to_call: number; min_raise_to: number; deadline_ms: number } | null
  reveal: unknown | null
  last_seq: number
  head: string
  void_kind: string | null
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  // — config —
  getConfig: () => request<ApiConfig>('/config'),

  // — rooms / create (Bearer) —
  createIntent: (body: CreateIntentRequest) =>
    postJson<CreateIntentResponse>('/rooms/intents', body, true),
  submitRoom: (intentId: string, txSig: string) =>
    postJson<SubmitRoomResponse>('/rooms', { intent_id: intentId, tx_sig: txSig }, true),
  getRoomByCode: (code: string) =>
    request<RoomByCodeResponse>(`/rooms/code/${encodeURIComponent(code)}`, { auth: true }),

  // — join / deposits (Bearer for the POST; candidate read is public) —
  submitDeposit: (matchId: string, txSig: string, roomCode?: string) =>
    postJson<SubmitDepositResponse>(
      `/matches/${encodeURIComponent(matchId)}/deposits`,
      roomCode ? { tx_sig: txSig, room_code: roomCode } : { tx_sig: txSig },
      true,
    ),
  getCandidate: (matchId: string, wallet: string) =>
    request<CandidateStatus>(
      `/matches/${encodeURIComponent(matchId)}/candidates/${encodeURIComponent(wallet)}`,
    ),

  // — sealing (Bearer) — REST fallback for the WS `seal` frame (§7) —
  submitSeal: (
    matchId: string,
    body: { ciphertext_b64: string; commitment_hex: string; timelock_target: number; signature: string; seal_tx_sig?: string },
  ) => postJson<{ v: number; server_time_ms: number; sealed: boolean; seat_index: number }>(
    `/matches/${encodeURIComponent(matchId)}/seal`,
    body,
    true,
  ),

  // — detail / lists —
  getMatch: (matchId: string) => request<MatchDetail>(`/matches/${encodeURIComponent(matchId)}`),
  /** Journal page (`since` is EXCLUSIVE — and the genesis event is seq 0, so it is never
   *  returned; an empty result on a live match means only genesis exists). */
  getEvents: (matchId: string, since = 0) =>
    request<{ events: { seq: number; type: string; body: Record<string, unknown>; hash: string }[] }>(
      `/matches/${encodeURIComponent(matchId)}/events${qs({ since })}`,
    ),
  getLobby: (opts: { feed?: string; buyInMin?: number; buyInMax?: number; cursor?: string; limit?: number } = {}) =>
    request<{ v: number; server_time_ms: number; rooms: LobbyRoom[] }>(
      `/lobby${qs({ feed: opts.feed, buy_in_min: opts.buyInMin, buy_in_max: opts.buyInMax, cursor: opts.cursor, limit: opts.limit })}`,
    ),
  getLive: (opts: { cursor?: string; limit?: number } = {}) =>
    request<{ v: number; server_time_ms: number; matches: LiveMatch[] }>(
      `/matches/live${qs({ cursor: opts.cursor, limit: opts.limit })}`,
    ),
  getHistory: (opts: { cursor?: string; limit?: number } = {}) =>
    request<{ v: number; server_time_ms: number; matches: HistoryMatch[] }>(
      `/matches/history${qs({ cursor: opts.cursor, limit: opts.limit })}`,
    ),

  // — wallet-scoped (reconnect / claims) —
  getActive: (wallet: string) =>
    request<{ v: number; server_time_ms: number; active: ActiveSeat[] }>(
      `/wallets/${encodeURIComponent(wallet)}/active`,
    ),
  getClaimables: (wallet: string) =>
    request<{ v: number; server_time_ms: number; wallet: string; claimables: Claimable[] }>(
      `/wallets/${encodeURIComponent(wallet)}/claimables`,
    ),
}

/** Re-export for callers that annotate amounts. */
export type { Chips }
