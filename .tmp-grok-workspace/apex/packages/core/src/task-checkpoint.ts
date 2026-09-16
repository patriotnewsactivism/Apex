/**
 * Durable checkpoint model for resumable task execution (Phase 2 of the
 * autonomous-OS upgrade).
 *
 * WHY THIS EXISTS
 * ------------------------------------------------------------------
 * BaseAgent.executeTask previously treated one invocation as an indivisible
 * unit of work: everything lived in a local `history` array, and the only two
 * outcomes were "finished" (complete()/fail() with the full result) or "the
 * hard wall-clock timeout fired and every bit of intermediate progress was
 * discarded into a blocked quarantine requiring manual operator unblock."
 * There was no way for a long task to bank the work it had already done and
 * hand off cleanly to its own next execution slice.
 *
 * A checkpoint is written at a clean iteration boundary — never mid tool-call
 * — so restoring it can never re-enter a half-finished side effect. The
 * primary resumption mechanism is restoring the actual (budget-capped)
 * conversation history, because that is strictly more faithful than any
 * hand-summarized text: the model sees its own prior tool calls and results
 * verbatim and does not need to re-derive them. The structured fields below
 * exist for the same reason the rest of this repo refuses to fabricate
 * status: they must be built ONLY from things the execution actually did
 * (tool calls it actually made, artifacts it actually produced, blockers it
 * actually raised) — never guessed or invented to make the record look more
 * complete than the work was.
 */

import type { LLMMessage } from './types.js';
import { applyHistoryBudget, resolveBudget, type BudgetMessage } from './context-budget.js';

export const CHECKPOINT_VERSION = 1 as const;

/** Why this checkpoint was written. Mirrors the structured yield-reason
 *  taxonomy in execution-outcome.ts. */
export type CheckpointReason = 'soft_deadline' | 'approval_yield' | 'manual';

export interface CheckpointRetryMetadata {
  /** LLM turns consumed by this execution slice (not cumulative). */
  iterationsUsed: number;
  /** Tool calls executed by this execution slice (not cumulative). */
  toolExecutions: number;
  maxIterations: number;
  /** How many times this task has yielded and been resumed, across its
   *  whole lifetime (carried forward from the prior checkpoint, if any). */
  yieldCount: number;
}

export interface CheckpointWorkspaceRefs {
  projectId?: string;
  worktree?: string;
}

export interface TaskCheckpoint {
  checkpointVersion: typeof CHECKPOINT_VERSION;
  taskId: string;
  /** Unique per execution attempt — distinguishes the slice that WROTE this
   *  checkpoint from the slice that will RESUME it. */
  executionId: string;
  goalId: string | null;
  agentId: string;
  /** Free-text phase label the agent loop is in. Today always 'iterating':
   *  reserved so a future planning layer can report richer phases without a
   *  schema change. */
  phase: string;
  /** Tool-call summaries in the order they executed this slice, e.g.
   *  "readFile(path=src/index.ts)". Real, not inferred. */
  completedSteps: string[];
  /** Always [] today: nothing in this codebase produces an explicit plan a
   *  checkpoint could read back. Present so a future planning tool has a
   *  field to populate without another schema change — never backfilled
   *  with a guess. */
  remainingSteps: string[];
  /** The model's own last narration this slice — the cheapest, most honest
   *  summary available, since it costs no extra LLM call and is not a
   *  paraphrase APEX invented. */
  workingSummary: string;
  /** Truncated log of read-only/informational tool calls (webSearch,
   *  fetchUrl, readFile, research tools) made this slice. */
  findings: string[];
  /** Side-effecting/durable-state tool calls made this slice (store_artifact,
   *  create_workstream, push_to_remote, schedule_task, ...). */
  decisions: string[];
  /** escalate_to_human calls raised this slice, verbatim. */
  unresolvedBlockers: string[];
  approvalRequirement: boolean;
  nextRecommendedAction: string;
  retryMetadata: CheckpointRetryMetadata;
  workspaceRefs: CheckpointWorkspaceRefs | null;
  artifactRefs: string[];
  createdAt: string;
  reason: CheckpointReason;
  /** Budget-capped resumable conversation. This — not the prose fields above
   *  — is what the next execution actually resumes from. */
  history: BudgetMessage[];
}

/** Defensive type guard: task.context is an untyped jsonb blob that may carry
 *  a checkpoint from an older schema version, a manually-edited row, or
 *  nothing at all. Never trust it without checking. */
export function isResumableCheckpoint(value: unknown): value is TaskCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    c.checkpointVersion === CHECKPOINT_VERSION &&
    typeof c.taskId === 'string' &&
    typeof c.agentId === 'string' &&
    Array.isArray(c.history)
  );
}

export interface BuildCheckpointInput {
  taskId: string;
  executionId: string;
  goalId: string | null;
  agentId: string;
  history: readonly BudgetMessage[];
  completedSteps: string[];
  findings: string[];
  decisions: string[];
  unresolvedBlockers: string[];
  approvalRequirement: boolean;
  iterationsUsed: number;
  toolExecutions: number;
  maxIterations: number;
  /** yieldCount from the checkpoint being resumed, if any. 0 for a fresh task. */
  priorYieldCount: number;
  workspaceRefs?: CheckpointWorkspaceRefs | null;
  artifactRefs?: string[];
  reason: CheckpointReason;
}

/** Cap on how much of the last assistant narration to keep as workingSummary
 *  — long enough to be genuinely useful, short enough to stay cheap to
 *  re-inject on every future turn. */
const MAX_SUMMARY_CHARS = 2000;
const MAX_LOG_ENTRIES = 25;
const MAX_LOG_ENTRY_CHARS = 240;

function capEntries(entries: string[]): string[] {
  return entries.slice(-MAX_LOG_ENTRIES).map((e) => (e.length > MAX_LOG_ENTRY_CHARS ? `${e.slice(0, MAX_LOG_ENTRY_CHARS)}…` : e));
}

/** Find the most recent non-empty assistant narration in the history — the
 *  cheapest honest "where things stand" summary available. */
function lastAssistantNarration(history: readonly BudgetMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.content && m.content.trim().length > 0) {
      return m.content.length > MAX_SUMMARY_CHARS ? `${m.content.slice(0, MAX_SUMMARY_CHARS)}…` : m.content;
    }
  }
  return '';
}

/**
 * Build the durable checkpoint record. History is budget-capped the same way
 * the live loop caps it, so a checkpoint can never smuggle an unbounded
 * conversation into the context jsonb column.
 */
export function buildCheckpoint(input: BuildCheckpointInput): TaskCheckpoint {
  const budgeted = applyHistoryBudget(input.history, resolveBudget());
  return {
    checkpointVersion: CHECKPOINT_VERSION,
    taskId: input.taskId,
    executionId: input.executionId,
    goalId: input.goalId,
    agentId: input.agentId,
    phase: 'iterating',
    completedSteps: capEntries(input.completedSteps),
    remainingSteps: [],
    workingSummary: lastAssistantNarration(input.history),
    findings: capEntries(input.findings),
    decisions: capEntries(input.decisions),
    unresolvedBlockers: capEntries(input.unresolvedBlockers),
    approvalRequirement: input.approvalRequirement,
    nextRecommendedAction:
      'Review workingSummary and the resumed conversation history, then continue the task toward a concrete completed artifact or state change.',
    retryMetadata: {
      iterationsUsed: input.iterationsUsed,
      toolExecutions: input.toolExecutions,
      maxIterations: input.maxIterations,
      yieldCount: input.priorYieldCount + 1,
    },
    workspaceRefs: input.workspaceRefs ?? null,
    artifactRefs: input.artifactRefs ?? [],
    createdAt: new Date().toISOString(),
    reason: input.reason,
    history: budgeted.history,
  };
}

/**
 * Human-readable preamble appended after the restored history so the model
 * is told explicitly that it is continuing, not starting over, and is
 * nudged toward finishing rather than re-investigating.
 */
export function formatResumePreamble(checkpoint: TaskCheckpoint): string {
  const lines = [
    `## Resuming from a checkpoint (yield #${checkpoint.retryMetadata.yieldCount}, reason: ${checkpoint.reason})`,
    `This is a continuation of the SAME task, not a new one. The conversation above is your own prior work in this task — do not repeat completed steps unless you have a concrete reason to re-verify them.`,
  ];
  if (checkpoint.workingSummary) {
    lines.push(`Your own last status before yielding: ${checkpoint.workingSummary}`);
  }
  if (checkpoint.completedSteps.length > 0) {
    lines.push(`Steps already executed this run: ${checkpoint.completedSteps.join('; ')}`);
  }
  if (checkpoint.decisions.length > 0) {
    lines.push(`Durable actions already taken: ${checkpoint.decisions.join('; ')}`);
  }
  if (checkpoint.unresolvedBlockers.length > 0) {
    lines.push(`Unresolved blockers you raised before yielding: ${checkpoint.unresolvedBlockers.join('; ')}`);
  }
  lines.push(checkpoint.nextRecommendedAction);
  return lines.join('\n');
}

/** Restore the LLMMessage[] history from a checkpoint for the resumed loop. */
export function extractCheckpointHistory(checkpoint: TaskCheckpoint): LLMMessage[] {
  return checkpoint.history.map((m) => ({
    role: m.role,
    content: m.content,
    toolCallId: m.toolCallId,
    name: m.name,
    toolCalls: m.toolCalls as LLMMessage['toolCalls'],
  }));
}

/**
 * Merge a checkpoint into a task's existing context blob without clobbering
 * unrelated keys (runtime='job', projectId, worktree, dispatch bookkeeping).
 *
 * For an executor-sandbox task (context.runtime === 'job'), the dispatch
 * marker MUST be cleared here: dispatchDueExecutorTasks() only dispatches
 * rows where context.dispatchedAt IS NULL, so a yielded job task whose old
 * dispatchedAt survives would return to 'pending' and then sit forever,
 * invisible to the dispatch loop's WHERE clause. Clearing it (and the
 * attempt counter, so backoff does not compound across ordinary yields) is
 * what makes the job actually get re-dispatched to a fresh Cloud Run Job
 * execution instead of silently stalling.
 */
export function mergeCheckpointIntoContext(
  existing: Record<string, unknown> | null | undefined,
  checkpoint: TaskCheckpoint,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(existing ?? {}), checkpoint };
  if (next.runtime === 'job') {
    delete next.dispatchedAt;
    next.dispatchAttempts = 0;
  }
  return next;
}

/** Read the yieldCount out of whatever checkpoint (if any) a task's context
 *  currently carries — used to seed retryMetadata.yieldCount on the next one. */
export function priorYieldCountFromContext(context: Record<string, unknown> | null | undefined): number {
  const checkpoint = context?.checkpoint;
  if (isResumableCheckpoint(checkpoint)) return checkpoint.retryMetadata.yieldCount;
  return 0;
}
