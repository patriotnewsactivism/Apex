// No-answer retry policy for outbound voice calls.
//
// Vapi ends a ringing, never-answered call with endedReason
// "call.in-progress.error-assistant-did-not-receive-customer-audio" (the
// prefix varies). With zero customer audio that is a no-answer, not a
// failure. This module decides whether, and when, to retry.
//
// It never dials. A retry is only ever a queued task for the sales agent,
// whose make_outbound_call goes through the normal outbound gate:
// kill switch, outbound mode, rehearsal allowlist, daily caps
// (decideToolOutbound) and DNC/suppression + compliance
// (assertOutboundAllowed). Nothing here bypasses or reads past those gates.

import { isWithinSendWindow, type OutboundPolicySnapshot } from './outbound-policy.js';

export const NO_ANSWER_RETRY_MAX_PER_DAY = 2;
export const NO_ANSWER_RETRY_MIN_GAP_MS = 10 * 60 * 1000;
export const NO_ANSWER_RETRY_TASK_KIND = 'no_answer_retry';

const NO_AUDIO_REASON = 'assistant-did-not-receive-customer-audio';

interface MessageLike { role?: unknown; message?: unknown; content?: unknown }

/** True when the customer produced no transcript text and no user messages. */
export function hasNoCustomerSpeech(transcript: unknown, messages: unknown): boolean {
  if (Array.isArray(messages)) {
    for (const m of messages as MessageLike[]) {
      if (!m || typeof m !== 'object') continue;
      const role = typeof m.role === 'string' ? m.role.toLowerCase() : '';
      if (role !== 'user' && role !== 'customer') continue;
      const text = typeof m.message === 'string' ? m.message : typeof m.content === 'string' ? m.content : '';
      if (text.trim()) return false;
    }
  }
  if (typeof transcript === 'string') {
    for (const line of transcript.split('\n')) {
      const match = /^\s*(user|customer)\s*:\s*(.*)$/i.exec(line);
      if (match && match[2].trim()) return false;
    }
  }
  return true;
}

/** endedReason "...assistant-did-not-receive-customer-audio" (any prefix)
 *  with no customer speech at all is an unanswered call. */
export function isUnansweredNoAudio(input: {
  endedReason: unknown;
  transcript?: unknown;
  messages?: unknown;
  connectedSeconds?: number | null;
}): boolean {
  const reason = typeof input.endedReason === 'string' ? input.endedReason.toLowerCase() : '';
  if (!reason.endsWith(NO_AUDIO_REASON)) return false;
  if (typeof input.connectedSeconds === 'number' && input.connectedSeconds > 0) return false;
  return hasNoCustomerSpeech(input.transcript, input.messages);
}

/** Local calendar day (YYYY-MM-DD) in the policy timezone. */
export function localDayKey(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export type NoAnswerRetryPlan =
  | { schedule: true; notBefore: Date; retryNumber: number }
  | { schedule: false; reason: string };

/**
 * Decide when (if ever) to retry an unanswered call.
 *
 *  - at most NO_ANSWER_RETRY_MAX_PER_DAY retries per lead per local day
 *  - at least 10 minutes after the most recent attempt
 *  - never outside the outbound send window, and never rolled into another
 *    day (the next day starts fresh through the normal campaign flow)
 *  - no plan at all when the policy is unavailable, off, or kill-switched;
 *    even a scheduled retry is re-checked by the outbound gate when it runs
 */
export function planNoAnswerRetry(input: {
  now: Date;
  policy: OutboundPolicySnapshot | null;
  /** Retries already scheduled for this lead (any status), with their times. */
  retriesScheduled: Date[];
  /** Times of every call attempt to this lead (including the one just ended). */
  attempts: Date[];
}): NoAnswerRetryPlan {
  const { now, policy } = input;
  if (!policy) return { schedule: false, reason: 'outbound policy unavailable' };
  if (policy.killSwitch) return { schedule: false, reason: 'outbound kill switch is on' };
  if (policy.mode === 'off') return { schedule: false, reason: 'outbound policy is off' };

  const tz = policy.timezone || 'America/Chicago';
  const today = localDayKey(now, tz);
  const retriesToday = input.retriesScheduled.filter((d) => localDayKey(d, tz) === today).length;
  if (retriesToday >= NO_ANSWER_RETRY_MAX_PER_DAY) {
    return { schedule: false, reason: `already ${retriesToday} no-answer retries today (max ${NO_ANSWER_RETRY_MAX_PER_DAY})` };
  }

  const lastAttemptMs = Math.max(now.getTime(), ...input.attempts.map((d) => d.getTime()));
  let candidate = new Date(Math.max(now.getTime(), lastAttemptMs) + NO_ANSWER_RETRY_MIN_GAP_MS);

  // Walk forward minute by minute (bounded to the same day) until inside the window.
  for (let i = 0; i < 24 * 60 && !isWithinSendWindow(candidate, policy); i++) {
    candidate = new Date(candidate.getTime() + 60_000);
    if (localDayKey(candidate, tz) !== today) break;
  }
  if (localDayKey(candidate, tz) !== today || !isWithinSendWindow(candidate, policy)) {
    return { schedule: false, reason: 'no time left inside today\'s calling window' };
  }
  return { schedule: true, notBefore: candidate, retryNumber: retriesToday + 1 };
}
