import type { StartPolicyAction, StartPolicyTrigger } from '../../shared/src/events.ts';

export type StartMode = 'private_host' | 'public_formation';

export interface StartPolicyResult {
  action: StartPolicyAction;
  reason?: string;
  trigger?: StartPolicyTrigger;
}

export function evaluateStartPolicy(input: {
  mode: StartMode;
  seated: number;
  minPlayers: number;
  maxPlayers: number;
  fillDeadlineReached: boolean;
  hostStartRequested?: boolean;
}): StartPolicyResult {
  const { mode, seated, minPlayers, maxPlayers, fillDeadlineReached, hostStartRequested } = input;

  if (mode === 'private_host') {
    if (hostStartRequested && seated >= minPlayers) {
      return { action: 'start', trigger: 'host' };
    }
    if (fillDeadlineReached && seated < minPlayers) {
      return { action: 'void', reason: 'not enough players', trigger: 'fill_deadline' };
    }
    return { action: 'wait' };
  }

  // public_formation
  if (seated === maxPlayers) {
    return { action: 'start', trigger: 'max_fill' };
  }
  if (fillDeadlineReached) {
    if (seated >= minPlayers) {
      return { action: 'start', trigger: 'fill_deadline' };
    }
    return { action: 'void', reason: 'not enough players', trigger: 'fill_deadline' };
  }
  return { action: 'wait' };
}

/** @deprecated use evaluateStartPolicy */
export { evaluateFill } from './index.ts';
