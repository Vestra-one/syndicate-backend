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
