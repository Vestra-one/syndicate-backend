import { createHash } from 'node:crypto';

/**
 * @syndicate/trust-safety — detection heuristics + enforcement decision (`06 §9`,
 * risks S3/S4, `08 OQ15/OQ16`). Enforcement is advisory/pre-settlement (deny seat,
 * ban) — never a retroactive clawback of settled on-chain funds. Detectors are
 * explainable (auditable for appeals).
 */

/** Per-hand net chip change by wallet, plus the hand's winner. */
export interface HandResult {
  winner: string;
  net: Record<string, number>;
}

/** Fraction of hands where `a` loses chips and `b` wins — chip-dumping signal. */
export function chipDumpScore(history: HandResult[], a: string, b: string): number {
  let dumps = 0;
  let total = 0;
  for (const h of history) {
    total++;
    if ((h.net[a] ?? 0) < 0 && h.winner === b) dumps++;
  }
  return total ? dumps / total : 0;
}

/** Coefficient of variation of action intervals; near-zero ⇒ bot-like consistency. */
export function botTimingScore(intervalsMs: number[]): number {
  if (intervalsMs.length < 3) return 0;
  const mean = intervalsMs.reduce((a, b) => a + b, 0) / intervalsMs.length;
  if (mean === 0) return 1;
  const variance = intervalsMs.reduce((a, b) => a + (b - mean) ** 2, 0) / intervalsMs.length;
  const cv = Math.sqrt(variance) / mean;
  return cv < 0.05 ? 1 : 0;
}

/** Group wallets that share a device id and funding source (Sybil clusters). */
export function sybilClusters(signals: { wallet: string; deviceId: string; funder: string }[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const s of signals) {
    const key = `${s.deviceId}|${s.funder}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s.wallet);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export type Decision = 'allow' | 'flag' | 'ban';

export interface Scores {
  chipDump: number;
  bot: number;
  sybilSize: number;
}

export interface Thresholds {
  chipDumpFlag: number;
  chipDumpBan: number;
  sybilFlag: number;
  sybilBan: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  chipDumpFlag: 0.6,
  chipDumpBan: 0.8,
  sybilFlag: 2,
  sybilBan: 3,
};

export function decide(s: Scores, t: Thresholds = DEFAULT_THRESHOLDS): Decision {
  if (s.chipDump >= t.chipDumpBan || s.sybilSize >= t.sybilBan) return 'ban';
  if (s.chipDump >= t.chipDumpFlag || s.bot >= 1 || s.sybilSize >= t.sybilFlag) return 'flag';
  return 'allow';
}

export interface SeatingEvent {
  matchId: string;
  wallet: string;
  ts: number;
}

export interface CoSeatingPair {
  wallets: [string, string];
  sharedMatches: string[];
  score: number;
}

export function coSeatingPairs(events: SeatingEvent[], minSharedMatches = 3): CoSeatingPair[] {
  const byMatch = new Map<string, Set<string>>();
  for (const event of events) {
    if (!byMatch.has(event.matchId)) byMatch.set(event.matchId, new Set());
    byMatch.get(event.matchId)!.add(event.wallet);
  }

  const pairs = new Map<string, { wallets: [string, string]; matches: Set<string> }>();
  for (const [matchId, wallets] of byMatch) {
    const sorted = [...wallets].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const pair: [string, string] = [sorted[i], sorted[j]];
        const key = pair.join('|');
        if (!pairs.has(key)) pairs.set(key, { wallets: pair, matches: new Set() });
        pairs.get(key)!.matches.add(matchId);
      }
    }
  }

  return [...pairs.values()]
    .map((p) => ({
      wallets: p.wallets,
      sharedMatches: [...p.matches].sort(),
      score: p.matches.size,
    }))
    .filter((p) => p.score >= minSharedMatches)
    .sort((a, b) => b.score - a.score || a.wallets.join('|').localeCompare(b.wallets.join('|')));
}

export type SignalKind = 'chip_dumping' | 'bot_timing' | 'sybil_cluster' | 'co_seating' | 'geofence' | 'kyc';
export type Severity = 'info' | 'flag' | 'ban';

export interface RiskSignal {
  id: string;
  wallet: string;
  kind: SignalKind;
  severity: Severity;
  score: number;
  evidence: Record<string, unknown>;
  createdAt: number;
}

export interface RiskAssessment {
  wallet: string;
  scores: Scores;
  decision: Decision;
  signals: RiskSignal[];
  explanation: string[];
}

export interface WalletSignal {
  wallet: string;
  deviceId?: string;
  funder?: string;
  country?: string;
  kycStatus?: KycStatus;
}

export interface AssessWalletInput {
  wallet: string;
  hands?: HandResult[];
  suspectedCounterparties?: string[];
  actionIntervalsMs?: number[];
  walletSignals?: WalletSignal[];
  seatingEvents?: SeatingEvent[];
  thresholds?: Thresholds;
  now?: number;
}

export function assessWalletRisk(input: AssessWalletInput): RiskAssessment {
  const now = input.now ?? Date.now();
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const counterparties = input.suspectedCounterparties ?? [];
  const chipDump = Math.max(0, ...counterparties.map((wallet) => chipDumpScore(input.hands ?? [], input.wallet, wallet)));
  const bot = botTimingScore(input.actionIntervalsMs ?? []);
  const cluster = sybilClusters(input.walletSignals ?? []).find((group) => group.includes(input.wallet));
  const sybilSize = cluster?.length ?? 1;
  const coSeat = coSeatingPairs(input.seatingEvents ?? [], 3).find((pair) => pair.wallets.includes(input.wallet));
  const scores = { chipDump, bot, sybilSize };
  let decision = decide(scores, thresholds);
  if (coSeat && decision === 'allow') decision = 'flag';

  const signals: RiskSignal[] = [];
  const explanation: string[] = [];
  if (chipDump >= thresholds.chipDumpFlag) {
    const severity: Severity = chipDump >= thresholds.chipDumpBan ? 'ban' : 'flag';
    signals.push(signal(input.wallet, 'chip_dumping', severity, chipDump, { counterparties, threshold: thresholds.chipDumpFlag }, now));
    explanation.push(`chip_dumping score ${chipDump.toFixed(2)} crossed ${severity} threshold`);
  }
  if (bot >= 1) {
    signals.push(signal(input.wallet, 'bot_timing', 'flag', bot, { intervalsMs: input.actionIntervalsMs ?? [] }, now));
    explanation.push('bot_timing showed superhuman consistency');
  }
  if (sybilSize >= thresholds.sybilFlag) {
    const severity: Severity = sybilSize >= thresholds.sybilBan ? 'ban' : 'flag';
    signals.push(signal(input.wallet, 'sybil_cluster', severity, sybilSize, { wallets: cluster }, now));
    explanation.push(`sybil_cluster size ${sybilSize} crossed ${severity} threshold`);
  }
  if (coSeat) {
    signals.push(signal(input.wallet, 'co_seating', 'flag', coSeat.score, { pair: coSeat.wallets, sharedMatches: coSeat.sharedMatches }, now));
    explanation.push(`co_seating with ${coSeat.wallets.filter((w) => w !== input.wallet).join(',')} across ${coSeat.score} matches`);
  }
  if (explanation.length === 0) explanation.push('no trust-safety threshold crossed');
  return { wallet: input.wallet, scores, decision, signals, explanation };
}

export type EnforcementType = 'seat_deny' | 'temporary_ban' | 'ban' | 'kyc_required' | 'geofence_block';
export type EnforcementStatus = 'active' | 'lifted' | 'expired';
export type AppealStatus = 'open' | 'accepted' | 'rejected';

export interface EnforcementAction {
  actionId: string;
  wallet: string;
  type: EnforcementType;
  status: EnforcementStatus;
  reason: string;
  evidence: RiskSignal[];
  createdAt: number;
  expiresAt?: number;
  appealIds: string[];
}

export interface AppealRecord {
  appealId: string;
  actionId: string;
  wallet: string;
  status: AppealStatus;
  statement: string;
  createdAt: number;
  resolvedAt?: number;
  reviewer?: string;
  resolution?: string;
}

export class EnforcementRegistry {
  private actions = new Map<string, EnforcementAction>();
  private appeals = new Map<string, AppealRecord>();

  applyAssessment(assessment: RiskAssessment, now = Date.now()): EnforcementAction | null {
    if (assessment.decision === 'allow') return null;
    const type: EnforcementType = assessment.decision === 'ban' ? 'ban' : 'seat_deny';
    const existing = this.activeActions(assessment.wallet, now)[0];
    if (existing && !(type === 'ban' && existing.type !== 'ban')) return existing;
    const action: EnforcementAction = {
      actionId: stableId('enforce', assessment.wallet, now, assessment.decision),
      wallet: assessment.wallet,
      type,
      status: 'active',
      reason: assessment.explanation.join('; '),
      evidence: assessment.signals,
      createdAt: now,
      expiresAt: type === 'seat_deny' ? now + 24 * 60 * 60 * 1000 : undefined,
      appealIds: [],
    };
    this.actions.set(action.actionId, action);
    return action;
  }

  applyCompliance(action: EnforcementAction): EnforcementAction {
    const existing = this.activeActions(action.wallet, action.createdAt).find((a) => a.type === action.type);
    if (existing) return existing;
    this.actions.set(action.actionId, action);
    return action;
  }

  activeActions(wallet: string, now = Date.now()): EnforcementAction[] {
    for (const action of this.actions.values()) {
      if (action.status === 'active' && action.expiresAt !== undefined && action.expiresAt <= now) {
        action.status = 'expired';
      }
    }
    return [...this.actions.values()].filter((a) => a.wallet === wallet && a.status === 'active');
  }

  canJoinTable(wallet: string, now = Date.now()): { allowed: boolean; reasons: string[] } {
    const actions = this.activeActions(wallet, now).filter((a) =>
      ['seat_deny', 'temporary_ban', 'ban', 'kyc_required', 'geofence_block'].includes(a.type),
    );
    return {
      allowed: actions.length === 0,
      reasons: actions.map((a) => `${a.type}: ${a.reason}`),
    };
  }

  submitAppeal(actionId: string, statement: string, now = Date.now()): AppealRecord {
    const action = this.actions.get(actionId);
    if (!action) throw new Error(`unknown enforcement action: ${actionId}`);
    const appeal: AppealRecord = {
      appealId: stableId('appeal', actionId, now, statement),
      actionId,
      wallet: action.wallet,
      status: 'open',
      statement,
      createdAt: now,
    };
    this.appeals.set(appeal.appealId, appeal);
    action.appealIds.push(appeal.appealId);
    return appeal;
  }

  resolveAppeal(appealId: string, accepted: boolean, reviewer: string, resolution: string, now = Date.now()): AppealRecord {
    const appeal = this.appeals.get(appealId);
    if (!appeal) throw new Error(`unknown appeal: ${appealId}`);
    appeal.status = accepted ? 'accepted' : 'rejected';
    appeal.reviewer = reviewer;
    appeal.resolution = resolution;
    appeal.resolvedAt = now;
    const action = this.actions.get(appeal.actionId);
    if (accepted && action) action.status = 'lifted';
    return appeal;
  }

  listActions(wallet?: string): EnforcementAction[] {
    return [...this.actions.values()].filter((a) => !wallet || a.wallet === wallet);
  }

  listAppeals(wallet?: string): AppealRecord[] {
    return [...this.appeals.values()].filter((a) => !wallet || a.wallet === wallet);
  }
}

export type KycStatus = 'none' | 'pending' | 'verified' | 'rejected';

export interface ComplianceInput {
  wallet: string;
  country?: string;
  geofenceBlocklist: string[];
  kycStatus?: KycStatus;
  requireKyc?: boolean;
  now?: number;
}

export function complianceAction(input: ComplianceInput): EnforcementAction | null {
  const now = input.now ?? Date.now();
  const country = input.country?.toUpperCase();
  if (country && input.geofenceBlocklist.map((c) => c.toUpperCase()).includes(country)) {
    return {
      actionId: stableId('geo', input.wallet, country, now),
      wallet: input.wallet,
      type: 'geofence_block',
      status: 'active',
      reason: `country ${country} is geofenced`,
      evidence: [signal(input.wallet, 'geofence', 'ban', 1, { country }, now)],
      createdAt: now,
      appealIds: [],
    };
  }
  if (input.requireKyc && input.kycStatus !== 'verified') {
    return {
      actionId: stableId('kyc', input.wallet, input.kycStatus ?? 'none', now),
      wallet: input.wallet,
      type: 'kyc_required',
      status: 'active',
      reason: `kyc status ${input.kycStatus ?? 'none'} is not verified`,
      evidence: [signal(input.wallet, 'kyc', 'flag', 1, { kycStatus: input.kycStatus ?? 'none' }, now)],
      createdAt: now,
      appealIds: [],
    };
  }
  return null;
}

function signal(
  wallet: string,
  kind: SignalKind,
  severity: Severity,
  score: number,
  evidence: Record<string, unknown>,
  createdAt: number,
): RiskSignal {
  return {
    id: stableId('signal', wallet, kind, createdAt, score),
    wallet,
    kind,
    severity,
    score,
    evidence,
    createdAt,
  };
}

function stableId(...parts: unknown[]): string {
  const body = parts.map((p) => JSON.stringify(p)).join('|');
  return `ts_${createHash('sha256').update(body).digest('hex').slice(0, 24)}`;
}
