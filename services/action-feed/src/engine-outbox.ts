/**
 * Adapt match-engine transactional outbox payloads into action-feed projection messages.
 *
 * Match-engine persists engine log JSON (`kind: "match.started"`, `player.action`, …).
 * The projector expects `{ type: "match-event", event: SequencedRawEvent }`.
 */

import type { RawEvent, SequencedRawEvent } from './index.ts';
import type { ProjectionMessage } from './projector.ts';

type EnginePayload = Record<string, unknown>;

export function adaptEngineOutboxPayload(
  payload: unknown,
  outboxId?: string,
): ProjectionMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;

  if (body.type === 'match-event' && body.event && typeof body.event === 'object') {
    return payload as ProjectionMessage;
  }
  if (body.type === 'profile-event' && body.event) {
    return payload as ProjectionMessage;
  }

  const kind = typeof body.kind === 'string' ? body.kind : null;
  if (!kind) return null;

  const matchId = String(body.match_id ?? body.matchId ?? '');
  if (!matchId) return null;

  const seq = nonNegativeInt(body.seq, 0);
  const ts = nonNegativeInt(body.ts, Date.now());
  const eventId = typeof body.event_id === 'string' ? body.event_id : outboxId ?? crypto.randomUUID();
  const timelockOpen = body.timelock_open === true || body.timelockOpen === true;

  const raw = engineKindToRaw(kind, body, matchId, ts);
  if (!raw) return null;

  const event: SequencedRawEvent = { id: eventId, seq, timelockOpen, raw };
  return { type: 'match-event', event };
}

function engineKindToRaw(
  kind: string,
  body: EnginePayload,
  matchId: string,
  ts: number,
): RawEvent | null {
  switch (kind) {
    case 'match.started':
      return { kind: 'round', matchId, round: 1, ts };
    case 'player.action': {
      const parsed = parseEngineAction(String(body.action ?? 'call'));
      return {
        kind: 'action',
        matchId,
        wallet: String(body.wallet ?? ''),
        seat: nonNegativeInt(body.seat_index, 0),
        action: parsed.action,
        amount: parsed.amount,
        feedPrice: nonNegativeInt(body.feed_price, 0),
        pot: nonNegativeInt(body.pot, 0),
        ts,
      };
    }
    case 'timeout.default': {
      const defaultAction = String(body.default ?? 'check_fold').toLowerCase();
      if (defaultAction.includes('fold')) {
        return {
          kind: 'fold',
          matchId,
          wallet: '',
          seat: nonNegativeInt(body.seat_index, 0),
          ts,
        };
      }
      return {
        kind: 'action',
        matchId,
        wallet: '',
        seat: nonNegativeInt(body.seat_index, 0),
        action: 'check',
        amount: 0,
        feedPrice: 0,
        pot: 0,
        ts,
      };
    }
    case 'match.public.settled':
    case 'match.public.voided':
      return {
        kind: 'settlement',
        matchId,
        settlementPrice: nonNegativeInt(body.settlement_price, 0),
        awards: Array.isArray(body.awards)
          ? body.awards.flatMap((row) => {
              if (!row || typeof row !== 'object') return [];
              const seat = nonNegativeInt((row as EnginePayload).seat, -1);
              const amount = nonNegativeInt((row as EnginePayload).amount, 0);
              return seat >= 0 ? [{ seat, amount }] : [];
            })
          : [],
        ts,
        voided: kind === 'match.public.voided' || body.voided === true,
      };
    default:
      return null;
  }
}

function parseEngineAction(raw: string): { action: string; amount: number } {
  const raise = /^Raise\((\d+)\)$/i.exec(raw.trim());
  if (raise) return { action: 'raise', amount: Number(raise[1]) };
  const normalized = raw.replace(/[({].*$/, '').trim().toLowerCase();
  return { action: normalized || 'call', amount: 0 };
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
