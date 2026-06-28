/** Versioned inter-service event schemas (v1). Mirror of shared/src/events.rs */

export const EVENT_SCHEMA_VERSION = 1;

export type StartPolicyAction = 'start' | 'void' | 'wait';
export type StartPolicyTrigger = 'host' | 'max_fill' | 'fill_deadline' | 'cancel';

export interface StartPolicyResult {
  schemaVersion: number;
  action: StartPolicyAction;
  reason?: string;
  trigger?: StartPolicyTrigger;
}

export interface FormationBootstrapped {
  schemaVersion: number;
  matchId: string;
  onchainMatchId: number;
  tierId: string;
  feedId: string;
  token: string;
  bucket: string;
  fillDeadlineMs: number;
  maxPlayers: number;
}

export interface DepositConfirmed {
  schemaVersion: number;
  matchId: string;
  wallet: string;
  seatIndex: number;
  txSignature: string;
  finalityTsMs: number;
}

export interface StartPolicyTriggered {
  schemaVersion: number;
  matchId: string;
  result: StartPolicyResult;
  seated: number;
  minPlayers: number;
  maxPlayers: number;
}

export interface MatchStarted {
  schemaVersion: number;
  matchId: string;
  onchainMatchId: number;
  configHash: string;
}

export interface FormationDissolved {
  schemaVersion: number;
  matchId: string;
  reason: string;
}

export interface ProfileDelta {
  schemaVersion: number;
  wallet: string;
  matchId: string;
  buyIn: number;
  payout: number;
  won: boolean;
  folded: boolean;
  showdown: boolean;
}

export function startPolicyResult(
  action: StartPolicyAction,
  trigger?: StartPolicyTrigger,
  reason?: string,
): StartPolicyResult {
  return { schemaVersion: EVENT_SCHEMA_VERSION, action, trigger, reason };
}
