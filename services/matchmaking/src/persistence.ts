/**
 * Match-row persistence port (Phase 06 → Phase 05). With no indexer, the backend writes
 * the canonical `matches`/`match_seats` rows itself on a verified create/deposit. Matchmaking
 * is a zero-dependency TypeScript service with no SQL driver, so it delegates the write over
 * HTTP to a Postgres-backed writer (the worker owns `tokio-postgres` + the Phase 05
 * `INSERT_MATCH_SQL` / `INSERT_MATCH_SEAT_SQL` statements).
 *
 * IMPORTANT: this persistence is for history/registry projection only. Capital safety NEVER
 * depends on it — `begin_live` reads the authoritative seat set from `getProgramAccounts`, and
 * settlement/void read PDAs. A failed or absent persistence write must therefore never block a
 * verified create/deposit from being registered; it is logged and the flow continues.
 */

export interface InsertMatchRow {
  /** Postgres `matches.match_key` — the protocol match id, i.e. the on-chain u64 id as text. */
  matchKey: string;
  onchainMatchId: string;
  configHash: string;
  fillDeadlineMs: number;
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
 * HTTP-backed persistence posting to a Postgres writer service. The endpoints carry exactly
 * the Phase 05 INSERT params; the writer runs the SQL. Errors are swallowed (logged) because
 * the registry is UX-only — never let a persistence hiccup reject a verified deposit.
 */
export function createHttpPersistence(baseUrl: string, authToken?: string): MatchPersistence {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  async function post(path: string, body: unknown): Promise<void> {
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
    insertMatch: (row) => post('/internal/matches', row),
    insertMatchSeat: (row) => post('/internal/matches/seats', row),
  };
}
