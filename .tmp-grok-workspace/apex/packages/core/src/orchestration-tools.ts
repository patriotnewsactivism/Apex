// ─── Orchestration Tools ──────────────────────────────────────────────────────
//
// The tools that make delegation a CLOSED loop instead of a one-way broadcast.
//
// Before these existed, `delegate()`/`sendMessage` wrote a child task row and
// the delegating agent immediately finished its own task — nothing ever read
// `tasks.parent_task_id` back, so a manager agent could never see whether the
// work it handed down succeeded, failed, or produced garbage. Goals had the
// same hole: `goals.status` was only ever written by a human hitting
// PATCH /api/goals/:id, so every goal stayed 'active' forever and the
// autonomous review re-read the same stale pile every cycle.
//
// These five tools give agents the missing half of the loop:
//   - get_delegation_status  — "what happened to the work I handed down?"
//   - list_goals             — "what is actually still open, with real progress?"
//   - update_goal_status     — "this goal is genuinely finished, close it"
//   - get_task_details       — "show me the full record of one task"
//   - escalate_to_human      — the charter's ESCALATE TO DON channel, as a real
//                              row a human sees, not a line buried in a log
//
// None of these take irreversible or outward-facing action, so none are
// approval-gated — they read state and move Apex's own bookkeeping forward.
// Deploys, external sends, schema changes, and financial actions keep their
// existing per-tool human-approval gates untouched.

import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { db, tasks, goals, approvals, memories } from '@workspace/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ToolDefinition } from './types.js';

/** Terminal task states — a task in one of these will never run again. */
export const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'] as const;
/** States where a task is still live in the queue and will (or may) run. */
export const OPEN_TASK_STATUSES = ['pending', 'in_progress', 'blocked', 'awaiting_approval'] as const;

/** Trim long free text so a tool result can't blow the agent's context window.
 *  Agents get an explicit "[truncated]" marker rather than silently-cut text,
 *  so they know to call get_task_details if they need the full record. */
function excerpt(value: string | null | undefined, max = 600): string | null {
  if (!value) return null;
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated — call get_task_details for the full text]`;
}

/**
 * Stable identity for a repeated escalation. Subject is normalized (case,
 * whitespace, trailing punctuation) so trivially-reworded restatements of the
 * same blocker still collapse onto one row.
 */
export function escalationDedupeKey(agentId: string, goalId: string | undefined, subject: string): string {
  const normalizedSubject = subject
    .toLowerCase()
    .replace(/\s+/g, ' ')
    // trim BEFORE stripping trailing punctuation: "cannot bill!!  " ends in a
    // space, so the punctuation anchor would never match and the reworded
    // restatement would hash to a different key than the original.
    .trim()
    .replace(/[.!?…]+$/, '')
    .trim()
    .slice(0, 160);
  return createHash('sha256')
    .update(`${agentId}\u0000${goalId ?? ''}\u0000${normalizedSubject}`)
    .digest('hex')
    .slice(0, 32);
}

export function createOrchestrationTools(): ToolDefinition[] {
  return [
    // ── get_delegation_status ────────────────────────────────────────────────
    {
      name: 'get_delegation_status',
      description:
        "Check what happened to work you delegated. Returns every child task spawned from a parent task (default: the task you are currently executing) with its status, result, and error. Call this BEFORE reporting an initiative complete — delegating is not the same as the work being done, and a child task can fail silently. Use it to verify quality, catch failures, and decide whether to re-delegate, fix, or close out.",
      schema: z.object({
        taskId: z
          .string()
          .optional()
          .describe('Parent task ID. Omit to inspect the children of the task you are currently working on.'),
        goalId: z
          .string()
          .optional()
          .describe('Instead of one parent task, inspect every task belonging to this goal.'),
      }),
      requiresApproval: false,
      async execute({ taskId, goalId }, ctx) {
        const rows = goalId
          ? await db.select().from(tasks).where(eq(tasks.goalId, goalId)).orderBy(desc(tasks.createdAt)).limit(100)
          : await (async () => {
              const parentId = taskId ?? ctx.taskId;
              if (!parentId) {
                throw new Error('No taskId given and no current task in context — pass taskId or goalId explicitly.');
              }
              return db
                .select()
                .from(tasks)
                .where(eq(tasks.parentTaskId, parentId))
                .orderBy(desc(tasks.createdAt))
                .limit(100);
            })();

        const children = rows.map((t) => ({
          taskId: t.id,
          title: t.title,
          assignedAgentId: t.assignedAgentId,
          status: t.status,
          retryCount: t.retryCount,
          result: excerpt(t.result),
          error: excerpt(t.errorMessage, 300),
          completedAt: t.completedAt?.toISOString() ?? null,
        }));

        const counts = {
          total: children.length,
          done: children.filter((c) => c.status === 'done').length,
          failed: children.filter((c) => c.status === 'failed').length,
          cancelled: children.filter((c) => c.status === 'cancelled').length,
          stillOpen: children.filter((c) => (OPEN_TASK_STATUSES as readonly string[]).includes(c.status)).length,
        };

        return {
          scope: goalId ? { goalId } : { parentTaskId: taskId ?? ctx.taskId },
          counts,
          allChildrenFinished: counts.total > 0 && counts.stillOpen === 0,
          children,
          guidance:
            counts.stillOpen > 0
              ? 'Some delegated work is still running. Do not report this initiative complete yet — summarize what is finished and note what is still in flight.'
              : counts.failed > 0
                ? 'Delegated work FAILED. Read the errors, then either re-delegate with corrected instructions, handle it yourself, or escalate_to_human if it is blocked on something outside your control.'
                : counts.total === 0
                  ? 'No child tasks found — nothing was delegated from this task.'
                  : 'All delegated work finished successfully. Verify the results actually satisfy the objective, then synthesize and close out.',
        };
      },
    },

    // ── list_goals ───────────────────────────────────────────────────────────
    {
      name: 'list_goals',
      description:
        'List business goals with REAL progress (task counts per goal), not just their titles. Use this at the start of an autonomous review to see what is genuinely open, what is stalled (open goal with zero live tasks), and what is finished but not yet closed.',
      schema: z.object({
        status: z
          .enum(['active', 'paused', 'completed', 'cancelled', 'all'])
          .optional()
          .describe("Filter by goal status. Defaults to 'active'."),
        limit: z.number().optional().describe('Max goals to return (default 25).'),
      }),
      requiresApproval: false,
      async execute({ status, limit }) {
        const wanted = status ?? 'active';
        const max = Math.min(Math.max(limit ?? 25, 1), 100);

        const goalRows = await (wanted === 'all'
          ? db.select().from(goals).orderBy(goals.priority, desc(goals.createdAt)).limit(max)
          : db.select().from(goals).where(eq(goals.status, wanted)).orderBy(goals.priority, desc(goals.createdAt)).limit(max));

        if (goalRows.length === 0) {
          return { count: 0, goals: [], guidance: `No goals with status '${wanted}'.` };
        }

        // One grouped query for all goals rather than N per-goal queries.
        const rollups = await db
          .select({
            goalId: tasks.goalId,
            status: tasks.status,
            count: sql<number>`count(*)::int`,
          })
          .from(tasks)
          .where(inArray(tasks.goalId, goalRows.map((g) => g.id)))
          .groupBy(tasks.goalId, tasks.status);

        const byGoal = new Map<string, Record<string, number>>();
        for (const r of rollups) {
          if (!r.goalId) continue;
          const bucket = byGoal.get(r.goalId) ?? {};
          bucket[r.status] = r.count;
          byGoal.set(r.goalId, bucket);
        }

        const enriched = goalRows.map((g) => {
          const bucket = byGoal.get(g.id) ?? {};
          const open = (OPEN_TASK_STATUSES as readonly string[]).reduce((n, s) => n + (bucket[s] ?? 0), 0);
          const done = bucket.done ?? 0;
          const failed = bucket.failed ?? 0;
          const total = Object.values(bucket).reduce((n, c) => n + c, 0);
          return {
            goalId: g.id,
            title: g.title,
            status: g.status,
            priority: g.priority,
            createdAt: g.createdAt?.toISOString() ?? null,
            ageHours: g.createdAt ? Math.round((Date.now() - g.createdAt.getTime()) / 3_600_000) : null,
            tasks: { total, open, done, failed },
            state:
              total === 0
                ? 'no_work_created'
                : open > 0
                  ? 'in_progress'
                  : done > 0 && failed === 0
                    ? 'work_finished_awaiting_closeout'
                    : failed > 0 && done === 0
                      ? 'stalled_all_failed'
                      : 'work_finished_with_failures',
          };
        });

        return {
          count: enriched.length,
          goals: enriched,
          guidance:
            "Act on state: 'no_work_created' means you accepted a goal and never decomposed it — do that now. " +
            "'work_finished_awaiting_closeout' means verify the results with get_delegation_status(goalId) then call update_goal_status to close it. " +
            "'stalled_all_failed' means the current approach does not work — change strategy or escalate_to_human. " +
            "Leaving finished goals open makes every future review reason over stale state.",
        };
      },
    },

    // ── update_goal_status ───────────────────────────────────────────────────
    {
      name: 'update_goal_status',
      description:
        "Close out or re-status a goal. This is how a goal actually leaves the active list — nothing closes goals automatically. Only mark a goal 'completed' after verifying the delegated work really satisfied it (use get_delegation_status first); write what was actually delivered into `result`, including anything that fell short. Honest reporting: a goal abandoned or made irrelevant is 'cancelled', not 'completed'.",
      schema: z.object({
        goalId: z.string().describe('The goal to update.'),
        status: z.enum(['active', 'paused', 'completed', 'cancelled']).describe('New goal status.'),
        result: z
          .string()
          .optional()
          .describe('What was actually delivered (or why the goal was paused/cancelled). Required when completing.'),
      }),
      requiresApproval: false,
      async execute({ goalId, status, result }, ctx) {
        const [existing] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
        if (!existing) {
          throw new Error(`Goal ${goalId} not found`);
        }

        if (status === 'completed' && !result) {
          throw new Error(
            'A goal cannot be completed without a `result` describing what was actually delivered. Verify with get_delegation_status first, then call again with result.',
          );
        }

        // Guard against closing a goal that still has live work — a manager
        // marking a goal done while its children are mid-flight is exactly the
        // kind of inflated reporting the charter forbids.
        if (status === 'completed') {
          const [open] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(tasks)
            .where(and(eq(tasks.goalId, goalId), inArray(tasks.status, [...OPEN_TASK_STATUSES])));
          if ((open?.count ?? 0) > 0) {
            return {
              updated: false,
              goalId,
              reason: `Refused: ${open.count} task(s) for this goal are still open (pending/in_progress/blocked/awaiting_approval). Wait for them to finish, or cancel them first. Do not report a goal complete while its work is still running.`,
            };
          }
        }

        const terminal = status === 'completed' || status === 'cancelled';
        await db
          .update(goals)
          .set({
            status,
            ...(result !== undefined ? { result } : {}),
            ...(terminal ? { completedAt: new Date() } : {}),
          })
          .where(eq(goals.id, goalId));

        return {
          updated: true,
          goalId,
          title: existing.title,
          previousStatus: existing.status,
          newStatus: status,
          closedBy: ctx.agentId,
        };
      },
    },

    // ── get_task_details ─────────────────────────────────────────────────────
    {
      name: 'get_task_details',
      description:
        'Read the full record of a single task — its complete description, result, error, retry count, and lineage (parent task and goal). Use this when get_delegation_status shows a truncated result or a failure you need the full text of before deciding what to do.',
      schema: z.object({
        taskId: z.string().describe('The task to inspect.'),
      }),
      requiresApproval: false,
      async execute({ taskId }) {
        const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
        if (!task) {
          throw new Error(`Task ${taskId} not found`);
        }
        return {
          taskId: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          assignedAgentId: task.assignedAgentId,
          createdByAgentId: task.createdByAgentId,
          goalId: task.goalId,
          parentTaskId: task.parentTaskId,
          retryCount: task.retryCount,
          maxRetries: task.maxRetries,
          result: task.result,
          error: task.errorMessage,
          createdAt: task.createdAt?.toISOString() ?? null,
          completedAt: task.completedAt?.toISOString() ?? null,
        };
      },
    },

    // ── escalate_to_human ────────────────────────────────────────────────────
    {
      name: 'escalate_to_human',
      description:
        "Raise something to Don that you cannot decide alone. Per the charter, escalate for: budget/spend beyond preset thresholds, legal or compliance exposure, genuinely ambiguous strategic direction, or an anomaly in a system that is normally healthy. This creates a real pending item in the dashboard's approval queue — it is a visible ask, not a log line. Do NOT use it to avoid ordinary decisions you are empowered to make, and never use it as a substitute for doing work you can do yourself.",
      schema: z.object({
        subject: z.string().describe('One-line summary of what needs a human decision.'),
        detail: z
          .string()
          .describe('Full context: what you found, what you already tried, the options as you see them, and your recommendation.'),
        urgency: z.enum(['low', 'normal', 'high', 'critical']).optional().describe("Defaults to 'normal'."),
        category: z
          .enum(['budget', 'legal', 'strategy', 'anomaly', 'other'])
          .optional()
          .describe('Which charter escalation trigger this falls under.'),
      }),
      requiresApproval: false,
      async execute({ subject, detail, urgency, category }, ctx) {
        const now = new Date();
        const resolvedUrgency = urgency ?? 'normal';
        const resolvedCategory = category ?? 'other';

        // Same agent + same goal + same subject = the same blocker raised
        // again, not a new one. Agents re-raise a blocker every shift for as
        // long as it stands, which is how this table reached 8,683 pending
        // escalations covering a handful of distinct problems. Bumping a
        // counter keeps the "still blocked, 340 shifts running" signal while
        // leaving one row to actually read and act on.
        const dedupeKey = escalationDedupeKey(ctx.agentId, ctx.goalId, subject);

        const [existing] = await db
          .select({ id: approvals.id, occurrences: approvals.occurrences })
          .from(approvals)
          .where(
            and(
              eq(approvals.kind, 'escalation'),
              eq(approvals.status, 'pending'),
              eq(approvals.dedupeKey, dedupeKey),
            ),
          )
          .limit(1);

        if (existing) {
          const occurrences = (existing.occurrences ?? 1) + 1;
          await db
            .update(approvals)
            .set({
              occurrences,
              lastOccurredAt: now,
              // Keep the newest detail — the situation may have moved on even
              // though the ask has not.
              toolArgs: { subject, detail, urgency: resolvedUrgency, category: resolvedCategory },
              reason: `[${resolvedUrgency.toUpperCase()} · ${resolvedCategory}] ${subject} (raised ${occurrences}×)`,
            })
            .where(eq(approvals.id, existing.id));

          return {
            escalated: true,
            escalationId: existing.id,
            subject,
            urgency: resolvedUrgency,
            duplicate: true,
            occurrences,
            note:
              `This exact escalation is already open and awaiting Don (raised ${occurrences}× now). ` +
              'It was NOT duplicated. Do not raise it again this task — continue with the work you can ' +
              'still do and state clearly in your final report what is blocked pending his decision.',
          };
        }

        const escalationId = randomUUID();

        // Lands in the existing approvals queue, which the dashboard already
        // surfaces — a human sees it without any new UI or notification wiring.
        await db.insert(approvals).values({
          id: escalationId,
          taskId: ctx.taskId ?? 'system',
          agentId: ctx.agentId,
          toolName: 'escalate_to_human',
          toolArgs: { subject, detail, urgency: resolvedUrgency, category: resolvedCategory },
          reason: `[${resolvedUrgency.toUpperCase()} · ${resolvedCategory}] ${subject}`,
          status: 'pending',
          kind: 'escalation',
          dedupeKey,
          occurrences: 1,
          lastOccurredAt: now,
          createdAt: now,
        });

        // Also persisted as a durable memory so the escalation survives in the
        // CEO's own recall, not only in a queue a human might clear.
        await db.insert(memories).values({
          id: randomUUID(),
          agentId: ctx.agentId,
          scope: 'global',
          key: `escalation:${now.toISOString()}`,
          value: JSON.stringify({ subject, detail, urgency: resolvedUrgency, category: resolvedCategory }),
          importance: 0.9,
          tags: ['escalation', resolvedCategory],
          createdAt: now,
          updatedAt: now,
        });

        return {
          escalated: true,
          escalationId,
          subject,
          urgency: resolvedUrgency,
          duplicate: false,
          occurrences: 1,
          note: 'Raised to Don in the escalations queue. Do NOT block waiting on an answer — continue with the work you can still do, and state clearly in your final report what is blocked pending his decision.',
        };
      },
    },
  ];
}
