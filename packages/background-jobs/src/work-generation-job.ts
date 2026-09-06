// ─── WorkGenerationJob — the self-growing task machine ───────────────────────
//
// Phase 5.1 of the autonomous-execution scheduler. Runs every 10 minutes and
// plans the next batch of concrete tasks from:
//   1. open goals with no live task started on them yet;
//   2. accepted opportunities (their execution plan lives in the row);
//   3. open workstreams whose scheduleHint has come due.
//
// Deterministic by design: no LLM call in the scheduler loop — "planning" here
// is the honest, deduplicated translation of durable state into durable work.
// Every enqueue is idempotent (hasOpenTaskWithPrefix + the unique delegation
// index), so firing early or after downtime can never stack duplicate tasks.
// Provider-rate-limit pauses need no special handling because this handler
// does not call any provider.

import { randomUUID } from 'crypto';
import {
  db,
  goals,
  opportunities,
  workstreams,
  tasks,
  memories,
  type ScheduledJob,
} from '@workspace/db';
import { and, asc, eq, inArray, isNotNull, like } from 'drizzle-orm';
import { CronParser } from './cron-parser.js';
import type { JobHandler } from './handlers/index.js';

const OPEN_TASK_STATUSES = ['pending', 'in_progress', 'blocked', 'awaiting_approval'] as const;
const WORK_GENERATION_AGENT = 'apex-coo-001';

/** True when this agent already has an open task whose title starts with
 *  `titlePrefix`. Kept local (not shared with handlers/index.ts) to avoid a
 *  cyclic import — the logic is the same. */
async function hasOpenTaskWithPrefix(agentId: string, titlePrefix: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedAgentId, agentId),
        inArray(tasks.status, [...OPEN_TASK_STATUSES]),
        like(tasks.title, `${titlePrefix}%`),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function insertTask(input: {
  title: string;
  description: string;
  goalId?: string | null;
  projectId?: string | null;
  priority: number;
  context?: Record<string, unknown>;
}): Promise<'created' | 'duplicate'> {
  const now = new Date();
  const [inserted] = await db
    .insert(tasks)
    .values({
      id: randomUUID(),
      goalId: input.goalId ?? null,
      title: input.title,
      description: input.description,
      status: 'pending',
      priority: input.priority,
      assignedAgentId: WORK_GENERATION_AGENT,
      createdByAgentId: 'system-scheduler',
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: 3,
      context: {
        source: 'work_generation',
        projectId: input.projectId ?? null,
        ...input.context,
      },
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  return inserted ? 'created' : 'duplicate';
}

/** Parse a workstream scheduleHint cron and say whether it is due. */
function scheduleDue(cronExpression: string, lastRunAt: Date | null, now: Date): boolean {
  try {
    if (!lastRunAt) return true;
    const next = CronParser.nextRun(cronExpression, lastRunAt);
    if (!next) return true;
    return next.getTime() <= now.getTime();
  } catch {
    return true; // unparseable hint → treat as due; the governor will floor it
  }
}

export class WorkGenerationJob implements JobHandler {
  async execute(job: ScheduledJob): Promise<unknown> {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const maxPerRun = Math.max(1, Math.min(20, Number(payload.maxPerRun ?? 6)));
    const now = new Date();

    // 1. Open goals → one task each, no duplicates (unique delegation index).
    const goalRows = await db
      .select({ id: goals.id, projectId: goals.projectId, title: goals.title, description: goals.description, priority: goals.priority })
      .from(goals)
      .where(eq(goals.status, 'active'))
      .orderBy(asc(goals.priority), asc(goals.createdAt))
      .limit(60);

    let goalTasks = 0;
    const goalBudget = Math.max(1, Math.floor(maxPerRun / 2));
    for (const goal of goalRows) {
      if (goalTasks >= goalBudget) break;
      const titlePrefix = `Execute goal: ${goal.title}`;
      if (await hasOpenTaskWithPrefix(WORK_GENERATION_AGENT, titlePrefix)) continue;
      const result = await insertTask({
        title: titlePrefix,
        description: [
          `EXECUTE GOAL (${goal.id})`,
          goal.description,
          '',
          'Plan, execute, and verify this goal to a measurable result. If it decomposes into sub-work,',
          'delegate through the normal hierarchy and verify the outcome — delegating is not delivering.',
          'Store any produced documents/builds via store_artifact so the work is durable.',
        ].join('\n'),
        goalId: goal.id,
        projectId: goal.projectId,
        priority: Math.min(10, Math.max(1, goal.priority)),
        context: { goalId: goal.id },
      });
      if (result === 'created') goalTasks++;
    }

    // 2. Accepted opportunities → scheduled tasks.
    const opportunityRows = await db
      .select({
        id: opportunities.id,
        projectId: opportunities.projectId,
        goalId: opportunities.goalId,
        title: opportunities.title,
        goalTitle: opportunities.goalTitle,
        goalDescription: opportunities.goalDescription,
        goalPriority: opportunities.goalPriority,
      })
      .from(opportunities)
      .where(eq(opportunities.status, 'accepted'))
      .orderBy(asc(opportunities.valueScore))
      .limit(30);

    let opportunityTasks = 0;
    const opportunityBudget = Math.max(1, Math.floor(maxPerRun / 3));
    for (const opp of opportunityRows) {
      if (opportunityTasks >= opportunityBudget) break;
      const titlePrefix = `Implement opportunity: ${opp.title}`;
      if (await hasOpenTaskWithPrefix(WORK_GENERATION_AGENT, titlePrefix)) continue;
      const result = await insertTask({
        title: titlePrefix,
        description: [
          `IMPLEMENT ACCEPTED OPPORTUNITY (${opp.id})`,
          `Goal: ${opp.goalTitle}`,
          '',
          opp.goalDescription,
          '',
          'Deliver the bounded, reversible next action described above and verify it measurably.',
          'Store artifacts via store_artifact.',
        ].join('\n'),
        goalId: opp.goalId ?? null,
        projectId: opp.projectId,
        priority: Math.min(10, Math.max(1, opp.goalPriority)),
        context: { opportunityId: opp.id },
      });
      if (result === 'created') {
        opportunityTasks++;
        await db.update(opportunities).set({ status: 'scheduled', updatedAt: now }).where(eq(opportunities.id, opp.id));
      }
    }

    // 3. Open workstreams whose scheduleHint is due.
    const workstreamRows = await db
      .select()
      .from(workstreams)
      .where(and(eq(workstreams.status, 'active'), isNotNull(workstreams.scheduleHint)))
      .orderBy(asc(workstreams.createdAt))
      .limit(40);

    let workstreamTasks = 0;
    const workstreamBudget = Math.max(1, maxPerRun - goalTasks - opportunityTasks);
    for (const ws of workstreamRows) {
      if (workstreamTasks >= workstreamBudget) break;
      const [lastRun] = await db
        .select({ value: memories.value })
        .from(memories)
        .where(and(
          eq(memories.agentId, 'apex-cron-governor'),
          eq(memories.scope, 'global'),
          eq(memories.key, `workstream:${ws.id}:lastWorkGen`),
        ))
        .limit(1);
      const lastRunAt = lastRun?.value ? new Date(JSON.parse(lastRun.value).at) : null;
      if (!scheduleDue(ws.scheduleHint, lastRunAt, now)) continue;

      const titlePrefix = `Workstream: ${ws.name}`;
      if (await hasOpenTaskWithPrefix(WORK_GENERATION_AGENT, titlePrefix)) {
        await upsertWorkstreamMark(ws.id, now);
        continue;
      }
      const result = await insertTask({
        title: titlePrefix,
        description: [
          `WORKSTREAM EXECUTION (${ws.projectId}/${ws.name})`,
          ws.repoUrl ? `Repository: ${ws.repoUrl}` : 'Repository: not yet created (create_github_repo when a repo deliverable is due).',
          `Artifact prefix: ${ws.artifactPrefix ?? 'unset'}`,
          '',
          'Advance this workstream one concrete, verifiable step: build, document, or ship the deliverable.',
          'Push durable files back to the workspace (push_workspace) and publish finished outputs via store_artifact.',
        ].join('\n'),
        goalId: ws.goalId ?? null,
        projectId: ws.projectId,
        priority: 5,
        context: { workstreamId: ws.id },
      });
      if (result === 'created') {
        workstreamTasks++;
        await upsertWorkstreamMark(ws.id, now);
      }
    }

    return {
      goalTasks,
      opportunityTasks,
      workstreamTasks,
      total: goalTasks + opportunityTasks + workstreamTasks,
      budget: maxPerRun,
    };
  }
}

async function upsertWorkstreamMark(workstreamId: string, at: Date): Promise<void> {
  const value = JSON.stringify({ at: at.toISOString() });
  const [existing] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(and(
      eq(memories.agentId, 'apex-cron-governor'),
      eq(memories.scope, 'global'),
      eq(memories.key, `workstream:${workstreamId}:lastWorkGen`),
    ))
    .limit(1);
  if (existing) {
    await db.update(memories).set({ value, updatedAt: at }).where(eq(memories.id, existing.id));
  } else {
    await db.insert(memories).values({
      id: randomUUID(),
      agentId: 'apex-cron-governor',
      scope: 'global',
      key: `workstream:${workstreamId}:lastWorkGen`,
      value,
      importance: 0.5,
      createdAt: at,
      updatedAt: at,
    });
  }
}