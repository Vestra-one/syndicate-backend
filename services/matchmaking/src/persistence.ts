/**
 * Match-row persistence port (Phase 06 → Phase 05). With no indexer, the backend writes
 * the canonical `matches`/`match_seats` rows itself on a verified create/deposit. Matchmaking
 * is a zero-dependency TypeScript service with no SQL driver, so it delegates the write over
 * HTTP to a Postgres-backed writer (the worker owns `tokio-postgres` + the Phase 05
 * `INSERT_MATCH_SQL` / `INSERT_MATCH_SEAT_SQL` statements).
 *
 * When `MATCH_PERSISTENCE_URL` is configured, create-time persistence failures reject the
 * room report because match-engine requires the Postgres row before it can start. Deposit
 * seat writes remain best-effort (logged) so a retried deposit is not blocked.
 */

export interface InsertMatchRow {
  /** Postgres `matches.match_key` — the protocol match id, i.e. the on-chain u64 id as text. */
  matchKey: string;
  onchainMatchId: string;
  configHash: string;
  fillDeadlineMs: number;
  priceFeedSymbol: string;
  oracleTokenHex: string;
  oracleExponent?: number;
  maxOracleConfidence?: string;
  buyInChips: number;
  entryFeeChips: number;
  rakeBps: number;
  rakeCapChips: number;
  maxPlayers: number;
}

export interface InsertMatchSeatRow {
  matchKey: string;
  seatIndex: number;
  wallet: string;
  depositSignature: string;
  buyInChips: number;
  entryFeeChips: number;
}

export interface MatchPersistence {
  /** Maps to Phase 05 `INSERT_MATCH_SQL` (idempotent on match_key). */
  insertMatch(row: InsertMatchRow): Promise<void>;
  /** Maps to Phase 05 `INSERT_MATCH_SEAT_SQL` (idempotent on (match_id, seat_index)). */
  insertMatchSeat(row: InsertMatchSeatRow): Promise<void>;
}

/** Registry-only persistence: no SQL writer configured. Used in local/dev + tests. */
export const NOOP_PERSISTENCE: MatchPersistence = {
  async insertMatch() {},
  async insertMatchSeat() {},
};

/**
 * HTTP-backed persistence posting to settlement-worker. Create failures throw so the
 * caller can reject `POST /rooms`; deposit failures are logged only.
 */
export function createHttpPersistence(baseUrl: string, authToken?: string): MatchPersistence {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  async function postStrict(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`match persistence ${path} failed (${res.status}): ${detail}`);
    }
  }

  async function postBestEffort(path: string, body: unknown): Promise<void> {
    try {
      const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn(`match persistence ${path} failed (${res.status}): ${detail}`);
      }
    } catch (err) {
      console.warn(`match persistence ${path} error:`, err instanceof Error ? err.message : err);
    }
  }

  return {
    insertMatch: (row) => postStrict('/internal/matches', row),
    insertMatchSeat: (row) => postBestEffort('/internal/matches/seats', row),
  };
}
