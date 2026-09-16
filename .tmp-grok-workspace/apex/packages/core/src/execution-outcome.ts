/**
 * Structured outcome/timeout taxonomy (Phase 7 of the autonomous-OS upgrade).
 *
 * WHY THIS EXISTS
 * ------------------------------------------------------------------
 * LLM generation telemetry (provider, model, attempt, latency, token usage,
 * cost, attribution) already exists and is durable — see
 * model-intelligence.ts's recordModelTelemetry/recordResponseTelemetry and
 * AGENTS.md's Model Intelligence policy. What did NOT exist is a distinguishable
 * reason for how a TASK execution ended when it was not a clean success: a
 * hard timeout, a soft-deadline yield, an approval yield, a malformed tool
 * call, a provider capacity pause, and an ordinary failure were all just
 * "the task failed" with a free-text error string, told apart (if at all) by
 * ad-hoc substring matching duplicated wherever it mattered
 * (isHardTaskTimeout in task-queue.ts, isLLMIntentionalPause in
 * provider-failure.ts, isApprovalYieldSignal in approval-continuation.ts).
 * This module gives that ad-hoc matching one shared vocabulary and a single
 * structured log line shape, without replacing any of the existing detection
 * functions — they remain the source of truth; this only labels their result
 * consistently for logs/dashboards.
 */

export type ExecutionOutcomeReason =
  | 'completed'
  | 'failed'
  | 'provider_timeout'
  | 'task_hard_timeout'
  | 'soft_yield'
  | 'approval_yield'
  | 'malformed_tool_call'
  | 'non_completion'
  | 'tool_timeout'
  | 'rate_limit'
  | 'circuit_breaker'
  | 'task_ownership_loss'
  | 'capacity_pause';

/** Mirrors task-queue.ts's own hard-timeout marker convention (kept
 *  duplicated on purpose — see isHardTaskTimeout there — rather than
 *  imported, so this module has no dependency on task-queue.ts's internals). */
function looksLikeHardTaskTimeout(message: string): boolean {
  return message.includes('Task exceeded hard') && message.includes('wall-clock timeout');
}

function looksLikeRateLimit(message: string): boolean {
  return /\b429\b/.test(message) || /rate.?limit/i.test(message);
}

function looksLikeCircuitBreaker(message: string): boolean {
  return /circuit breaker/i.test(message);
}

function looksLikeOwnershipLoss(message: string): boolean {
  return /no longer owned by this execution/i.test(message) || /refusing to continue approved work/i.test(message);
}

function looksLikeProviderTimeout(message: string): boolean {
  return /\btimed?[- ]?out\b/i.test(message) && !looksLikeHardTaskTimeout(message);
}

/**
 * Best-effort classification of a task's terminal error string into a
 * structured reason, for logging only — never used to change control flow.
 * Checks are ordered most-specific first. Falls back to 'failed' rather than
 * guessing a more specific category the message does not actually support.
 */
export function classifyTaskFailureReason(message: string): ExecutionOutcomeReason {
  if (looksLikeHardTaskTimeout(message)) return 'task_hard_timeout';
  if (looksLikeOwnershipLoss(message)) return 'task_ownership_loss';
  if (looksLikeCircuitBreaker(message)) return 'circuit_breaker';
  if (looksLikeRateLimit(message)) return 'rate_limit';
  if (looksLikeProviderTimeout(message)) return 'provider_timeout';
  return 'failed';
}

export interface TaskOutcomeLogFields {
  runId?: string;
  taskId: string;
  goalId?: string | null;
  agentId: string;
  reason: ExecutionOutcomeReason;
  elapsedMs: number;
  iterations?: number;
  toolExecutions?: number;
  detail?: string;
}

/** One structured JSON line per non-trivial task outcome. Deliberately a
 *  plain console.log (not a DB write): this is meant to be grep/query-able
 *  from Cloud Run's own log sink without adding a new write path that could
 *  itself fail. Durable counters for the dashboard live in
 *  runtime-health.ts's autonomyCounters and task_checkpoints; this is the
 *  structured-log half, not a replacement for either. */
export function logTaskOutcome(fields: TaskOutcomeLogFields): void {
  console.log(
    JSON.stringify({
      kind: 'apex.task_outcome',
      ...fields,
    }),
  );
}

export interface ToolCallLogFields {
  taskId: string;
  agentId: string;
  tool: string;
  /** Already-truncated/summarized — never the raw sensitive payload. */
  argsSummary: string;
  startedAt: number;
  durationMs: number;
  success: boolean;
  /** True when a retry of the exact same call would be reasonable (network
   *  blip, transient provider error) as opposed to a validation/logic error
   *  that will fail identically every time. Best-effort, from the tool
   *  result shape only — never guessed beyond what the result actually says. */
  retryable?: boolean;
  sideEffect: 'read' | 'write' | 'none';
  approvalStatus?: 'not_required' | 'auto_approved' | 'approved' | 'rejected' | 'yielded';
}

export function logToolCallOutcome(fields: ToolCallLogFields): void {
  console.log(
    JSON.stringify({
      kind: 'apex.tool_call',
      ...fields,
    }),
  );
}
