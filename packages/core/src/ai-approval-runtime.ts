// Runtime wiring for the two-gate AI approval. Kept separate from the pure
// logic in ai-approval-gates.ts so that file stays testable with no LLM or DB.
//
// Why a sweeper and not a hook inside requestHumanApproval: live agents never
// wait in-process. InstrumentedBaseAgent saves the approval row, yields the
// task as `awaiting_approval`, and a later decision resumes it through the
// one-shot compare-and-set in consumeDecision. So the gates act exactly like a
// human clicking Approve/Reject: they flip a pending row, then requeue the task
// with the same guard the approvals API uses. That also drains any backlog that
// existed before the feature was switched on.

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { db, approvals, tasks as tasksTable } from '@workspace/db';
import { createLLMClient, getDefaultLLMConfig } from './llm-client.js';
import {
  aiApprovalMode,
  formatAuditNote,
  runTwoGates,
  type AskModel,
  type ApprovalRequest,
  type GateOutcome,
  type GateMode,
} from './ai-approval-gates.js';

/** Reviewer and Manager use different roles so they can land on different models. */
function makeAsk(role: string): AskModel {
  return async (messages) => {
    const client = createLLMClient({
      ...getDefaultLLMConfig(role),
      temperature: 0, // a gate must be as repeatable as possible
      maxTokens: 120, // two short lines; also caps token spend per decision
    });
    const res = await client.complete(messages);
    return res.content ?? '';
  };
}

export interface GateResult {
  mode: GateMode;
  outcome: GateOutcome;
  note: string;
}

/**
 * Decide one request with the two gates. Returns null when the feature is off.
 * Never throws: any failure becomes a reject outcome.
 */
export async function evaluateWithAiGates(req: ApprovalRequest): Promise<GateResult | null> {
  const mode = aiApprovalMode();
  if (mode === 'off') return null;
  try {
    const outcome = await runTwoGates(req, {
      reviewer: makeAsk('QA'),
      manager: makeAsk('QA_DIRECTOR'),
    });
    return { mode, outcome, note: formatAuditNote(outcome, mode) };
  } catch (err) {
    const outcome: GateOutcome = {
      decision: 'reject',
      stage: 'error',
      why: `gate crashed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return { mode, outcome, note: formatAuditNote(outcome, mode) };
  }
}

/** Same guarded requeue the approvals API uses: only a task still awaiting approval. */
async function requeueAwaitingApprovalTask(taskId: string): Promise<void> {
  await db
    .update(tasksTable)
    .set({ status: 'pending', leasedAt: null, updatedAt: new Date() })
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.status, 'awaiting_approval')))
    .catch((err) => {
      console.warn(
        `[ai-approval] requeue failed for task ${taskId} (durable sweep will retry):`,
        err instanceof Error ? err.message : err,
      );
    });
}

export interface SweepSummary {
  mode: GateMode;
  examined: number;
  approved: number;
  rejected: number;
  leftForHuman: number;
  shadowRecorded: number;
}

/** Marker so shadow verdicts are not re-evaluated every tick. */
const SHADOW_PREFIX = '[ai-gates:shadow]';
const DECIDED_PREFIX = '[ai-gates:on]';

let sweeping = false;

/**
 * Decide up to `batch` pending gated approvals. Safe to call on a timer:
 * re-entrancy guarded, bounded per tick, and every state change is a
 * compare-and-set so a human who acts first always wins.
 */
export async function sweepPendingApprovalsWithAiGates(batch = 8): Promise<SweepSummary> {
  const mode = aiApprovalMode();
  const summary: SweepSummary = { mode, examined: 0, approved: 0, rejected: 0, leftForHuman: 0, shadowRecorded: 0 };
  if (mode === 'off' || sweeping) return summary;
  sweeping = true;
  try {
    // Oldest first, only real gated approvals, only ones no gate has touched.
    const rows = await db
      .select()
      .from(approvals)
      .where(and(
        eq(approvals.kind, 'approval'),
        eq(approvals.status, 'pending'),
        or(isNull(approvals.reviewerNote), sql`${approvals.reviewerNote} not like '[ai-gates:%'`),
      ))
      .orderBy(asc(approvals.createdAt))
      .limit(batch);

    for (const row of rows) {
      summary.examined++;
      const result = await evaluateWithAiGates({
        toolName: row.toolName,
        agentId: row.agentId,
        reason: row.reason,
        args: (row.toolArgs ?? {}) as Record<string, unknown>,
      });
      if (!result) continue;
      const { outcome, note } = result;

      if (outcome.decision === 'human') {
        // Mark it so we do not re-ask every tick; it stays pending for a person.
        await db.update(approvals).set({ reviewerNote: note })
          .where(and(eq(approvals.id, row.id), eq(approvals.status, 'pending')));
        summary.leftForHuman++;
        continue;
      }

      if (result.mode === 'shadow') {
        await db.update(approvals).set({ reviewerNote: note.replace('[ai-gates:shadow]', SHADOW_PREFIX) })
          .where(and(eq(approvals.id, row.id), eq(approvals.status, 'pending')));
        summary.shadowRecorded++;
        continue;
      }

      const status = outcome.decision === 'approve' ? 'approved' : 'rejected';
      const updated = await db
        .update(approvals)
        .set({ status, reviewedAt: new Date(), reviewerNote: note.replace('[ai-gates:on]', DECIDED_PREFIX) })
        .where(and(
          eq(approvals.id, row.id),
          eq(approvals.kind, 'approval'),
          eq(approvals.status, 'pending'), // a human who got there first wins
        ))
        .returning({ id: approvals.id, taskId: approvals.taskId });
      if (updated.length === 0) continue;
      if (updated[0].taskId) await requeueAwaitingApprovalTask(updated[0].taskId);
      if (status === 'approved') summary.approved++;
      else summary.rejected++;
    }
    return summary;
  } finally {
    sweeping = false;
  }
}
