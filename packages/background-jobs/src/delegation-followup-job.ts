import type { ScheduledJob } from '@workspace/db';

const OPEN_STATUSES = ['pending', 'in_progress', 'blocked', 'awaiting_approval'] as const;

/**
 * Crash-safe return leg for delegated work.
 *
 * The original handler inserts a synthesis task and only then marks its child
 * tasks reported. A worker/process loss in that small window leaves a durable
 * synthesis row but unreported children. The next sweep then retries the same
 * insert and can hit tasks_delegation_unique forever.
 *
 * This implementation makes the operation idempotent across that crash window:
 * before creating anything it looks for a synthesis already tied to the same
 * parent task. If one exists, it reconciles the child markers and moves on.
 * New synthesis titles also include the parent UUID, so two different parents
 * with the same human-readable title cannot collide on the tasks uniqueness
 * constraint. onConflictDoNothing covers concurrent sweeps; a losing worker
 * reconciles against the winner instead of turning a harmless race into a
 * failed scheduled job.
 */
export class CrashSafeDelegationFollowupJob {
  async execute(job: ScheduledJob): Promise<unknown> {
    const { randomUUID } = await import('crypto');
    const { db, tasks } = await import('@workspace/db');
    const { and, eq, gte, inArray, isNotNull, sql } = await import('drizzle-orm');

    const maxSyntheses = Number((job.payload as Record<string, unknown>)?.maxPerRun ?? 8);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const finishedChildren = await db
      .select({
        id: tasks.id,
        parentTaskId: tasks.parentTaskId,
        title: tasks.title,
        status: tasks.status,
        result: tasks.result,
        errorMessage: tasks.errorMessage,
        assignedAgentId: tasks.assignedAgentId,
        goalId: tasks.goalId,
      })
      .from(tasks)
      .where(
        and(
          isNotNull(tasks.parentTaskId),
          inArray(tasks.status, ['done', 'failed', 'cancelled']),
          gte(tasks.updatedAt, since),
          sql`coalesce((${tasks.context}->>'reportedToParent')::boolean, false) = false`,
        ),
      )
      .limit(300);

    if (finishedChildren.length === 0) {
      return { unreportedChildren: 0, synthesesCreated: 0, synthesesReconciled: 0 };
    }

    const byParent = new Map<string, typeof finishedChildren>();
    for (const child of finishedChildren) {
      if (!child.parentTaskId) continue;
      const group = byParent.get(child.parentTaskId) ?? [];
      group.push(child);
      byParent.set(child.parentTaskId, group);
    }

    let synthesesCreated = 0;
    let synthesesReconciled = 0;
    let deferred = 0;
    const created: Array<{ parentTaskId: string; taskId: string; delegator: string }> = [];

    const markReported = async (
      childIds: string[],
      extraContext?: Record<string, string | boolean>,
    ): Promise<void> => {
      if (childIds.length === 0) return;
      const extra = extraContext ?? {};
      await db
        .update(tasks)
        .set({
          context: sql`coalesce(${tasks.context}, '{}'::jsonb) || ${JSON.stringify({
            reportedToParent: true,
            ...extra,
          })}::jsonb`,
        })
        .where(inArray(tasks.id, childIds));
    };

    const findExistingSynthesis = async (parentTaskId: string, delegator: string) => {
      const [row] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.assignedAgentId, delegator),
            sql`${tasks.context}->>'synthesisForParentTaskId' = ${parentTaskId}`,
          ),
        )
        .limit(1);
      return row ?? null;
    };

    for (const [parentTaskId, children] of byParent) {
      if (synthesesCreated >= maxSyntheses) break;

      const [stillOpen] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.parentTaskId, parentTaskId), inArray(tasks.status, [...OPEN_STATUSES])));
      if ((stillOpen?.count ?? 0) > 0) {
        deferred++;
        continue;
      }

      const [parent] = await db.select().from(tasks).where(eq(tasks.id, parentTaskId)).limit(1);
      const delegator = parent?.assignedAgentId;
      const childIds = children.map((c) => c.id);

      if (!parent || !delegator) {
        await markReported(childIds, { reportSkipped: 'no-parent-or-delegator' });
        continue;
      }

      // Recovery path for the exact production failure: synthesis insert won,
      // process died before child markers were updated. Do not insert again.
      const existing = await findExistingSynthesis(parentTaskId, delegator);
      if (existing) {
        await markReported(childIds, {
          reportReconciled: true,
          existingSynthesisTaskId: existing.id,
        });
        synthesesReconciled++;
        continue;
      }

      const succeeded = children.filter((c) => c.status === 'done');
      const failed = children.filter((c) => c.status !== 'done');
      const description = [
        `DELEGATION RESULTS — the work you handed down from "${parent.title}" has finished.`,
        'This is the return leg of your own delegation. Nobody asked for this; the system routes',
        'completed sub-work back to whoever delegated it so outcomes are verified, not assumed.',
        '',
        `## Outcome summary: ${succeeded.length} succeeded, ${failed.length} failed/cancelled`,
        '',
        ...children.map((c) =>
          [
            `### [${c.status.toUpperCase()}] ${c.title}`,
            `- taskId: ${c.id}`,
            `- handled by: ${c.assignedAgentId ?? 'unassigned'}`,
            c.status === 'done'
              ? `- result: ${(c.result ?? '(no result recorded)').slice(0, 900)}`
              : `- error: ${(c.errorMessage ?? '(no error recorded)').slice(0, 500)}`,
          ].join('\n'),
        ),
        '',
        '## What to do now',
        '1. JUDGE THE WORK, do not just acknowledge it. Does each result actually satisfy what you asked for?',
        '   A subordinate reporting "no results found" or returning a plan instead of a deliverable has NOT',
        '   done the work — re-delegate with sharper, more specific instructions.',
        '2. For anything that failed: read the error. Decide — re-delegate with a corrected approach, handle',
        '   it yourself, or escalate_to_human if it is blocked on something outside the system (a missing',
        '   credential, a spend decision, a legal question). Do not silently drop a failure.',
        '3. Use get_task_details for the full text of any result or error truncated above.',
        '4. If this batch completes an initiative and no other work remains for its goal, verify with',
        '   get_delegation_status and then close the goal with update_goal_status. Goals do not close',
        '   themselves.',
        '5. Report honestly: what actually shipped, what did not, and what you are doing about the gap.',
        '   Never report a delegated initiative as delivered when its children failed.',
      ].join('\n');

      // Keep the readable parent title while making the database uniqueness key
      // parent-specific. The full UUID avoids collisions between two different
      // parents that happen to share the same human title.
      const synthesisTitle = `Delegation results: ${parent.title.slice(0, 120)} [${parentTaskId}]`.slice(0, 200);
      const taskId = randomUUID();
      const now = new Date();

      const inserted = await db
        .insert(tasks)
        .values({
          id: taskId,
          goalId: parent.goalId,
          title: synthesisTitle,
          description,
          status: 'pending',
          priority: Math.max(1, (parent.priority ?? 5) - 1),
          assignedAgentId: delegator,
          createdByAgentId: 'system-scheduler',
          createdAt: now,
          updatedAt: now,
          retryCount: 0,
          maxRetries: 3,
          context: {
            scheduledJobId: job.id,
            synthesisForParentTaskId: parentTaskId,
            childTaskIds: childIds,
            succeeded: succeeded.length,
            failed: failed.length,
          },
        })
        .onConflictDoNothing()
        .returning({ id: tasks.id });

      if (inserted.length === 0) {
        // Another sweep won the race. Re-read the durable winner and reconcile
        // instead of surfacing a unique-index violation as a failed cron job.
        const raced = await findExistingSynthesis(parentTaskId, delegator);
        if (!raced) {
          throw new Error(
            `Delegation synthesis conflict for parent ${parentTaskId}, but no matching synthesis row was found`,
          );
        }
        await markReported(childIds, {
          reportReconciled: true,
          existingSynthesisTaskId: raced.id,
        });
        synthesesReconciled++;
        continue;
      }

      await markReported(childIds);
      synthesesCreated++;
      created.push({ parentTaskId, taskId, delegator });
    }

    return {
      unreportedChildren: finishedChildren.length,
      parentBatches: byParent.size,
      synthesesCreated,
      synthesesReconciled,
      deferredBatchesStillRunning: deferred,
      created,
    };
  }
}
