// ─── Sandbox Executor Dispatch (Cloud Run Jobs) ──────────────────────────────
//
// Phase 4 of the autonomous-execution scheduler. The control plane never runs
// heavy tasks in-process; tasks with context.runtime === 'job' are dispatched
// to a Cloud Run Job sandbox via the gcloud CLI (same pattern as
// cloud-run-deployer.ts — the repo standard is CLI, not SDK).
//
// Configuration (real operator values, never guessed):
//   APEX_EXECUTOR_JOB         required — Cloud Run Job name (e.g. "apex-executor")
//   APEX_GCP_PROJECT_ID       optional — project id (falls back to gcloud config)
//   APEX_CLOUD_RUN_REGION     optional — region (falls back to gcloud config)
//
// Dispatch is a no-op when APEX_EXECUTOR_JOB is unset (logs once per cycle),
// and per-task failures are retried with durable backoff — a transient gcloud
// blip must never lose a claimed task.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { db, tasks, jobExecutionLog } from '@workspace/db';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

export function executorJobName(): string | null {
  const name = (process.env.APEX_EXECUTOR_JOB ?? '').trim();
  return name.length > 0 ? name : null;
}

export function executorDispatchConfig(): { configured: boolean; reason?: string } {
  const name = executorJobName();
  if (!name) {
    return {
      configured: false,
      reason: 'APEX_EXECUTOR_JOB is not set — executor dispatch is disabled (no-op loop)',
    };
  }
  return { configured: true };
}

export interface DispatchResult {
  dispatched: number;
  skippedUnclaimable: number;
  failures: Array<{ taskId: string; error: string }>;
  config?: { configured: boolean; reason?: string };
}

function gcloudBaseArgs(): string[] {
  const args: string[] = ['run', 'jobs', 'execute', executorJobName() ?? ''];
  if (process.env.APEX_GCP_PROJECT_ID) args.push('--project', process.env.APEX_GCP_PROJECT_ID);
  if (process.env.APEX_CLOUD_RUN_REGION) args.push('--region', process.env.APEX_CLOUD_RUN_REGION);
  args.push('--wait=false');
  return args;
}

/**
 * Atomically mark one due executor task as dispatched (compare-and-set on the
 * context marker) so two overlapping dispatch cycles can never execute the
 * same task twice. Returns the claimed row, or null when the race was lost.
 */
async function claimDispatchSlot(taskId: string): Promise<typeof tasks.$inferSelect | null> {
  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), '{dispatchAttempts}', '0')`,
      updatedAt: now,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.status, 'pending'),
        sql`${tasks.context}->>'runtime' = 'job'`,
        sql`(${tasks.context}->>'dispatchedAt') IS NULL`,
        or(isNull(tasks.nextRetryAt), lte(tasks.nextRetryAt, now)),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Fire `gcloud run jobs execute` for every due, undispatched runtime='job'
 * task. Non-claimed tasks (already dispatched, just claimed by a worker, or
 * terminal) are no-ops. Bounded per cycle (default 3) so a burst of executor
 * work drains over a few cycles instead of spawning a job-storm.
 */
export async function dispatchDueExecutorTasks(
  options?: { maxPerCycle?: number },
): Promise<DispatchResult> {
  const config = executorDispatchConfig();
  if (!config.configured) {
    return { dispatched: 0, skippedUnclaimable: 0, failures: [], config };
  }

  const maxPerCycle = Math.max(1, Math.min(10, options?.maxPerCycle ?? 3));
  const due = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'pending'),
        sql`${tasks.context}->>'runtime' = 'job'`,
        sql`(${tasks.context}->>'dispatchedAt') IS NULL`,
        or(isNull(tasks.nextRetryAt), lte(tasks.nextRetryAt, new Date())),
      ),
    )
    .orderBy(asc(tasks.priority), asc(tasks.createdAt))
    .limit(maxPerCycle);

  const result: DispatchResult = { dispatched: 0, skippedUnclaimable: 0, failures: [], config };
  for (const task of due) {
    const claimed = await claimDispatchSlot(task.id);
    if (!claimed) {
      result.skippedUnclaimable++;
      continue;
    }
    try {
      const args = [...gcloudBaseArgs(), `--args=${task.id}`];
      await execFileAsync('gcloud', args, { timeout: 120_000 });
      await db.update(tasks).set({
        status: 'pending', // still pending until the job claims it
        context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), '{dispatchedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb)`,
        updatedAt: new Date(),
      }).where(eq(tasks.id, task.id));
      await db.insert(jobExecutionLog).values({
        jobId: `executor:${task.id}`,
        executionId: randomUUID(),
        startedAt: new Date(),
        status: 'running',
        output: `gcloud run jobs execute ${executorJobName()} --args=${task.id}`,
      });
      result.dispatched++;
      console.log(`[executor-dispatch] dispatched task ${task.id} to Cloud Run Job '${executorJobName()}'`);
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 500) : String(err);
      // Release the dispatch marker with durable backoff instead of stranding
      // the task: the next cycle will retry it after nextRetryAt.
      const retryCount = Number((task.context as Record<string, unknown> | null)?.dispatchAttempts ?? 0);
      await db.update(tasks).set({
        status: 'pending',
        nextRetryAt: new Date(Date.now() + Math.min(Math.pow(2, retryCount) * 30_000, 300_000)),
        errorMessage: `executor dispatch failed: ${error}`,
        context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), '{dispatchAttempts}', ${String(retryCount + 1)}::jsonb)`,
        updatedAt: new Date(),
      }).where(eq(tasks.id, task.id));
      result.failures.push({ taskId: task.id, error });
      console.warn(`[executor-dispatch] task ${task.id} dispatch failed: ${error}`);
    }
  }
  return result;
}

/**
 * Interval-based dispatch loop for app bootstrap, matching the CampaignRunner
 * paradigm (the 60s cron table cannot express a 30s cadence). Returns a stop
 * function.
 */
export function startExecutorDispatchLoop(options?: {
  intervalMs?: number;
  maxPerCycle?: number;
}): { stop: () => void } {
  const intervalMs = options?.intervalMs ?? 30_000;
  const maxPerCycle = 3; // bounded at the loop level; per-cycle override reserved
  let running = true;

  const cycle = async () => {
    if (!running) return;
    try {
      await dispatchDueExecutorTasks({ maxPerCycle });
    } catch (err) {
      console.warn('[executor-dispatch] cycle failed:', err instanceof Error ? err.message : err);
    }
  };

  void cycle();
  const timer = setInterval(() => void cycle(), intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      running = false;
      clearInterval(timer);
    },
  };
}

export async function getExecutorJobStatus(taskId: string): Promise<Record<string, unknown>> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return { taskId, found: false };
  return {
    taskId,
    found: true,
    status: task.status,
    runtime: (task.context as Record<string, unknown> | null)?.runtime ?? 'process',
    dispatchedAt: (task.context as Record<string, unknown> | null)?.dispatchedAt ?? null,
    dispatchAttempts: (task.context as Record<string, unknown> | null)?.dispatchAttempts ?? 0,
    errorMessage: task.errorMessage,
    result: task.result,
    jobName: executorJobName() ?? null,
    executorConfigured: executorDispatchConfig().configured,
  };
}