import { randomInt } from 'node:crypto';
import type { InviteAction, SendStage } from './types.js';
import { SEND_CODE_THRESHOLD } from './types.js';

/**
 * TODO(feat/send-safeguard): feat/send-safeguard is not on origin, so
 * `assertSendAllowed` does not exist in this tree. `assertCalendarSendAllowed`
 * is the single hook calendar invites, reschedules, and cancellations call.
 * When that module lands, delegate this function to `assertSendAllowed` and
 * delete the local ladder. Until then the ladder below is the build-1 rule:
 *
 *   initial check → confirm → second confirm
 *   and a 4-digit code once the rolling 24-hour outbound count reaches 5.
 *
 * Kill switch and do-not-contact both refuse the invite. Google events stay
 * at sendUpdates="none" until this returns allowed.
 */

export interface SendGateInput {
  stage: SendStage;
  action: InviteAction;
  codeRequired: boolean;
  suppliedCode?: string | null;
  expectedCode?: string | null;
  killSwitch: boolean;
  doNotContact: boolean;
  /** Messages already counted in the rolling 24h window, including this job. */
  outboundCountInWindow: number;
}

export interface SendGateDecision {
  allowed: boolean;
  stage: SendStage;
  sendUpdates: 'none' | 'all';
  reason: string;
  confirmations: number;
  codeRequired: boolean;
}

export function assertCalendarSendAllowed(input: SendGateInput): SendGateDecision {
  // TODO(feat/send-safeguard): return assertSendAllowed(input) here.
  return evaluateCalendarSendGate(input);
}

export function evaluateCalendarSendGate(input: SendGateInput): SendGateDecision {
  const codeRequired = input.codeRequired || input.outboundCountInWindow >= SEND_CODE_THRESHOLD;
  if (input.killSwitch) return blocked('kill_switch', codeRequired);
  if (input.doNotContact) return blocked('do_not_contact', codeRequired);
  if (input.stage === 'blocked') return blocked('blocked', codeRequired);
  if (input.stage === 'cleared') {
    return {
      allowed: true,
      stage: 'cleared',
      sendUpdates: 'all',
      reason: 'already_cleared',
      confirmations: 3,
      codeRequired,
    };
  }

  let stage = input.stage;
  let confirmations = confirmationsFor(stage);
  if (input.action === 'initial_check' && stage === 'initial_check') {
    stage = 'confirm';
    confirmations = 1;
  } else if (input.action === 'confirm' && stage === 'confirm') {
    stage = 'second_confirm';
    confirmations = 2;
  } else if (
    (input.action === 'second_confirm' && stage === 'second_confirm')
    || (input.action === 'submit_code' && (stage === 'second_confirm' || stage === 'code_required'))
  ) {
    if (codeRequired && !codeMatches(input.suppliedCode, input.expectedCode)) {
      return {
        allowed: false,
        stage: 'code_required',
        sendUpdates: 'none',
        reason: 'code_required',
        confirmations: 2,
        codeRequired: true,
      };
    }
    return {
      allowed: true,
      stage: 'cleared',
      sendUpdates: 'all',
      reason: 'cleared',
      confirmations: 3,
      codeRequired,
    };
  }

  return {
    allowed: false,
    stage,
    sendUpdates: 'none',
    reason: stage,
    confirmations,
    codeRequired,
  };
}

function confirmationsFor(stage: SendStage): number {
  if (stage === 'confirm') return 1;
  if (stage === 'second_confirm' || stage === 'code_required') return 2;
  if (stage === 'cleared') return 3;
  return 0;
}

function codeMatches(supplied: string | null | undefined, expected: string | null | undefined): boolean {
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < supplied.length; i++) mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

function blocked(reason: string, codeRequired: boolean): SendGateDecision {
  return {
    allowed: false,
    stage: 'blocked',
    sendUpdates: 'none',
    reason,
    confirmations: 0,
    codeRequired,
  };
}

export function randomChallengeCode(randomInt: (max: number) => number = defaultRandomInt): string {
  return String(randomInt(10_000)).padStart(4, '0');
}

function defaultRandomInt(max: number): number {
  return randomInt(0, max);
}
