/**
 * v2 WebSocket wire types (`wss://…/v1/ws`). Server frames are the additive-versioned
 * envelope `{ v:1, t, server_time_ms, …payload }` (payload flattened, discriminated by `t`).
 * Client frames are `{ t, … }` (no envelope). Field names are snake_case, verbatim from the
 * game-server (`src/ws.rs` / `src/runtime.rs` / `src/view.rs`). Unknown fields/types MUST be
 * ignored (breaking changes bump `v`).
 */

/** The snapshot `state` object — mirrors the REST match detail (view.rs). */
export interface WsMatchState {
  v: number
  server_time_ms: number
  match_id: string
  onchain_match_id: number
  phase: string // filling|sealing|sealing_closed|live|settlement_pending|settled|voided
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
  seats: WsSeat[]
  pot: number | null
  round: number | null
  current_bet: number | null
  to_act: number | null
  /** The open turn (server ≥ turn-recovery patch) — lets a mid-turn refresh recover the
   *  action panel with the TRUE deadline instead of being silently timeout-folded. */
  turn?: WsTurn | null
  /** Same object as `turn`, under its documented name (§9). */
  open_turn?: WsTurn | null
  reveal: {
    settlement_price_wad: string | null
    predictions: { seat: number; price: string; source: string }[] | null
    rake: number | null
    tx_sig: string | null
  } | null
  last_seq: number
  head: string
  void_kind: string | null
}

export interface WsSeat {
  seat_index: number
  wallet: string
  sealed: boolean
  prediction_source: string | null
  stack: number | null
  committed: number | null
  total_contribution: number | null
  folded: boolean | null
  all_in: boolean | null
}

/** A live turn: who acts, what it costs, the absolute deadline, and the action-chain head
 *  the acting seat must sign against. */
export interface WsTurn {
  seat: number
  to_call: number
  min_raise_to: number
  deadline_ms: number
  round?: number
  head_hex?: string
}

/** One engine event (backfill or inside an `action` broadcast). */
export interface WsEvent {
  seq: number
  type: string
  body: Record<string, unknown>
  hash: string
}

// ---------------------------------------------------------------------------
// Server → client frames (discriminated by `t`)
// ---------------------------------------------------------------------------

interface Base {
  v: number
  server_time_ms: number
}

export type ServerFrame =
  | (Base & { t: 'challenge'; nonce: string })
  | (Base & { t: 'authenticated'; wallet: string; session: string | null; expires_at: number | null })
  | (Base & { t: 'pong' })
  | (Base & { t: 'error'; code: string; msg: string })
  | (Base & { t: 'snapshot'; match_id: string; state: WsMatchState })
  | (Base & { t: 'event'; match_id: string; seq: number; type: string; body: Record<string, unknown>; hash: string })
  | (Base & { t: 'lobby_delta'; kind: 'upsert' | 'started' | 'retired'; match_id: string; confirmed?: number; max_players?: number })
  | (Base & { t: 'seat_update'; match_id: string; confirmed: number })
  | (Base & {
      t: 'phase'
      match_id: string
      phase: string
      /** True on the sealing frame: the lock tx confirmed — safe to register a commitment. */
      lock_confirmed?: boolean
      lock_tx_sig?: string | null
      seal_deadline?: number | null
      timelock_target?: number | null
      live_start?: number | null
      scheduled_end?: number | null
      button?: number | null
    })
  | (Base & { t: 'emote'; match_id: string; seat_index: number; emote: string })
  | (Base & {
      t: 'seal_status'
      match_id: string
      closed?: boolean
      sealed?: number[]
      just_sealed?: number | null
      deadline_ms?: number | null
    })
  // `turn_update` is the PUBLIC turn frame every subscriber gets; `your_turn` is the same
  // payload delivered only to the acting wallet's authenticated socket.
  | (Base & { t: 'turn_update'; match_id: string } & WsTurn)
  | (Base & { t: 'your_turn'; match_id: string } & WsTurn)
  | (Base & {
      t: 'action'
      match_id: string
      seq: number
      events: WsEvent[]
      pot: number
      current_bet: number
      to_act: number | null
      round: number
      feed_price: string | null
      feed_price_expo: number
      feed_price_ts: number | null
      head_hex: string
    })
  | (Base & { t: 'settled'; match_id: string; payouts: { seat: number; wallet: string }[] })
  | (Base & { t: 'voided'; match_id: string; kind: string | null })
  | (Base & { t: 'default_set'; match_id: string; seat: number })
  | (Base & { t: 'sealed'; server_time_ms: number; seat_index: number }) // seal ack (WS)

export type ServerFrameType = ServerFrame['t']

// ---------------------------------------------------------------------------
// Client → server frames
// ---------------------------------------------------------------------------

/** A channel selector: the string `"lobby"`/`"wallet"` or a specific match. */
export type Channel = 'lobby' | 'wallet' | { match: string }

/** `action` payload: a plain string shortcut, or an object for parameterized moves. */
export type WsAction = 'fold' | 'check' | 'call' | 'all_in' | { kind: 'bet_to' | 'raise_to'; amount: number }

export type ClientFrame =
  // Sign the challenge nonce, OR present an existing REST session token for the wallet.
  | { t: 'auth'; wallet: string; signature: string }
  | { t: 'auth'; wallet: string; session: string }
  /** `last_seq: -1` (or omitted) backfills the whole journal incl. genesis; N → events after N. */
  | { t: 'subscribe'; channel: Channel; last_seq?: number }
  | { t: 'unsubscribe'; channel: Channel }
  /** Table talk: one of the fixed reactions (see `EMOTES`). */
  | { t: 'emote'; match_id: string; emote: string }
  | { t: 'ping' }
  | {
      t: 'act'
      match_id: string
      seat_index: number
      nonce: number
      prev_head_hex: string
      action: WsAction
      signature: string
    }
  | { t: 'set_default'; match_id: string; seat_index: number; policy: 'check_fold' | 'check_call_any'; signature: string }
  | {
      t: 'seal'
      match_id: string
      ciphertext_b64: string
      commitment_hex: string
      timelock_target: number
      signature: string
      seal_tx_sig?: string
    }
