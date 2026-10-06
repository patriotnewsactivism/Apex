import { z } from 'zod';

export const ACTOR_HEADER = 'x-apex-actor';

/**
 * Resolve the cancellation actor: header wins over body, fallback to 'system'.
 * Returns null if no actor can be attested (for 400 rejection).
 */
export function resolveCancelActor(headers: Record<string, string | string[] | undefined>, bodyActor?: string): string | null {
  // Header can be multi-value; take the first.
  const headerVal = headers[ACTOR_HEADER];
  if (Array.isArray(headerVal)) {
    return headerVal[0] ?? null;
  }
  if (typeof headerVal === 'string') {
    return headerVal;
  }
  // Fall back to body actor if present
  if (bodyActor && typeof bodyActor === 'string' && bodyActor.trim() !== '') {
    return bodyActor.trim();
  }
  return null;
}

/**
 * Validate cancellation reason: must be a non-empty string of 3..2000 trimmed chars.
 * Returns null if valid, or an error message if invalid.
 */
export function validateCancelReason(reason: string | undefined): string | null {
  if (reason === undefined) {
    return 'missing reason';
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return 'empty reason';
  }
  if (trimmed.length < 3) {
    return 'reason too short (minimum 3 characters)';
  }
  if (trimmed.length > 2000) {
    return 'reason too long (maximum 2000 characters)';
  }
  return null;
}

/**
 * Standard error object for cancellation attribution failures.
 */
export function cancelAttestationError(problem: string) {
  return { error: `Cancellation attribution failed: ${problem}` };
}

/**
 * Build the cancellation update set for tasks or goals.
 * 
 * @param actor - Attested actor string (non-empty)
 * @param reason - Attested reason string (non-empty, 3..2000)
 * @param existingContext - Existing context JSONB object to merge into
 * @param options - Control what fields to set
 * @returns Object containing the fields to set in the DB update
 */
export function buildCancellationUpdate(
  actor: string,
  reason: string,
  existingContext: Record<string, unknown> = {},
  options: {
    setCompletedAt?: boolean;
    setResult?: boolean;
  } = {}
) {
  const now = new Date();
  const trimmedReason = reason.trim();
  
  // Build the context.cancel object, merging into existing context
  const context = {
    ...existingContext,
    cancel: {
      actor,
      reason: trimmedReason,
      source: 'manual', // could be 'job-scheduler', 'executor', etc. in future
      at: now.toISOString(),
    },
  };

  const result: Record<string, unknown> = {
    cancelledBy: actor,
    cancelReason: trimmedReason,
    cancelledAt: now,
    errorMessage: `[cancelled] actor=${actor} reason=${trimmedReason}`,
    context,
  };

  if (options.setCompletedAt !== false) {
    result.completedAt = now;
  }

  if (options.setResult === true) {
    result.result = `[cancelled] actor=${actor} reason=${trimmedReason}`;
  }

  return result;
}

/**
 * For duplicate goal cancellation: construct a reason that names the canonical
 * goal id, the duplicate goal id, and the trigger task id.
 */
export function duplicateGoalCancelReason(canonicalGoalId: string, duplicateGoalId: string, triggerTaskId: string): string {
  return `Duplicate goal cancelled: canonical=${canonicalGoalId}, duplicate=${duplicateGoalId}, trigger=${triggerTaskId}`;
}

/**
 * For goal cancellation cascade: construct a reason that embeds the goal id
 * and indicates it was cascaded to child tasks.
 */
export function goalCascadeReason(goalId: string): string {
  return `Goal ${goalId} cancelled, cascaded to child tasks`;
}