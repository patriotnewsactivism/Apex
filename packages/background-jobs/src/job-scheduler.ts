// ─── JobScheduler ─────────────────────────────────────────────────────────────
//
// Polls the durable scheduled_jobs table for due work. A scheduled occurrence is
// claimed by an atomic status transition before execution, so process-local
// timers are only wake-up mechanisms — they are not ownership or deduplication
// state. A crash leaves the occurrence due and recoverable after the claim lease
// expires.

import { db, scheduledJobs, tasks } from '@workspace/db';
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { CronParser } from './cron-parser.js';
import { JobExecutor } from './job-executor.js';
import {
  TaskDelegationJob,
  HealthCheckJob,
  ReportGenerationJob,
  MaintenanceJob,
  GoalReviewJob,
  LearningAnalysisJob,
  DelegationFollowupJob,
  GoalProgressJob,
  FailureReviewJob,
  BranchReviewJob,
  StalledWorkRecoveryJob,
  PromptSelfImproveJob,
} from './handlers/index.js';
import { OpportunityDiscoveryJob, WorkforcePlannerJob } from './opportunity-jobs.js';

const OPEN_TASK_STATUSES = ['pending', 'in_progress', 'blocked', 'awaiting_approval'] as const;
const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;

export interface JobSchedulerConfig {
  pollIntervalMs?: number;  // default 60_000
  staleClaimMs?: number;    // default 5 minutes; must exceed normal job timeout
}

export class JobScheduler {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalMs: number;
  private staleClaimMs: number;
  private executor: JobExecutor;

  constructor(config?: JobSchedulerConfig) {
    this.pollIntervalMs = config?.pollIntervalMs ?? 60_000;
    this.staleClaimMs = Math.max(config?.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS, 60_000);
    this.executor = new JobExecutor();

    // Register built-in handlers
    this.executor.registerHandler('task_delegation', new TaskDelegationJob());
    this.executor.registerHandler('health_check', new HealthCheckJob());
    this.executor.registerHandler('report_generation', new ReportGenerationJob());
    this.executor.registerHandler('maintenance', new MaintenanceJob());
    this.executor.registerHandler('goal_review', new GoalReviewJob());
    this.executor.registerHandler('learning_analysis', new LearningAnalysisJob());
    this.executor.registerHandler('delegation_followup', new DelegationFollowupJob());
    this.executor.registerHandler('goal_progress', new GoalProgressJob());
    this.executor.registerHandler('failure_review', new FailureReviewJob());
    this.executor.registerHandler('branch_review', new BranchReviewJob());
    this.executor.registerHandler('stalled_work_recovery', new StalledWorkRecoveryJob());
    this.executor.registerHandler('prompt_self_improve', new PromptSelfImproveJob());
    this.executor.registerHandler('opportunity_discovery', new OpportunityDiscoveryJob());
    this.executor.registerHandler('workforce_planner', new WorkforcePlannerJob());
  }

  /** Start the in-process wake loop. Durable ownership remains in Postgres. */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('📅 JobScheduler started');
    void this.poll();
  }

  /** Stop scheduling new polls. Claimed work remains recoverable from Postgres. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('📅 JobScheduler stopped');
  }

  /**
   * Run one complete durable scheduling cycle and wait for all work claimed by
   * this cycle to settle. This is intentionally public so an external durable
   * wake primitive can invoke the same code without depending on a browser or
   * a permanently alive JavaScript timer.
   */
  async runOnce(): Promise<number> {
    await this.recoverStaleClaims();
    return this.processDueJobs();
  }

  /** Poll for due jobs and execute them. */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      await this.runOnce();
    } catch (err) {
      console.error('[JobScheduler] Poll error:', err instanceof Error ? err.message : err);
    }

    if (this.running) {
      this.timer = setTimeout(() => void this.poll(), this.pollIntervalMs);
    }
  }

  /**
   * Recover a claim whose worker disappeared before it could record success or
   * failure. nextRunAt is deliberately not advanced at claim time, so the same
   * occurrence remains due after recovery instead of being silently lost.
   */
  private async recoverStaleClaims(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.staleClaimMs);
    const recovered = await db
      .update(scheduledJobs)
      .set({
        status: 'active',
        error: 'Recovered stale scheduler claim after worker loss or timeout',
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledJobs.status, 'running'),
          lte(scheduledJobs.updatedAt, cutoff),
        ),
      )
      .returning({ id: scheduledJobs.id });

    if (recovered.length > 0) {
      console.warn(`[JobScheduler] Recovered ${recovered.length} stale scheduled-job claim(s)`);
    }
  }

  /** Atomically claim one due occurrence. Only one worker can win. */
  private async claim(jobId: string, dueAt: Date): Promise<typeof scheduledJobs.$inferSelect | null> {
    const now = new Date();
    const [claimed] = await db
      .update(scheduledJobs)
      .set({ status: 'running', updatedAt: now })
      .where(
        and(
          eq(scheduledJobs.id, jobId),
          eq(scheduledJobs.enabled, true),
          eq(scheduledJobs.status, 'active'),
          isNotNull(scheduledJobs.nextRunAt),
          lte(scheduledJobs.nextRunAt, dueAt),
        ),
      )
      .returning();

    return claimed ?? null;
  }

  /** Find, claim, and execute all due jobs. */
  private async processDueJobs(): Promise<number> {
    const now = new Date();
    const dueJobs = await db
      .select()
      .from(scheduledJobs)
      .where(
        and(
          eq(scheduledJobs.enabled, true),
          eq(scheduledJobs.status, 'active'),
          isNotNull(scheduledJobs.nextRunAt),
          lte(scheduledJobs.nextRunAt, now),
        ),
      )
      .orderBy(asc(scheduledJobs.priority), asc(scheduledJobs.nextRunAt));

    const executions: Promise<void>[] = [];
    let claimedCount = 0;

    for (const candidate of dueJobs) {
      if (!this.executor.canAccept()) {
        console.warn('[JobScheduler] Executor at capacity, deferring remaining jobs');
        break;
      }

      const claimed = await this.claim(candidate.id, now);
      if (!claimed) continue; // another worker won the claim

      // A recurring task_delegation job must never manufacture another copy of
      // the same expensive LLM task while the prior copy is still open.
      if (claimed.jobType === 'task_delegation' && claimed.targetAgentId) {
        const liveScheduledTasks = await db
          .select({ id: tasks.id, createdAt: tasks.createdAt })
          .from(tasks)
          .where(
            and(
              eq(tasks.assignedAgentId, claimed.targetAgentId),
              eq(tasks.createdByAgentId, 'system-scheduler'),
              inArray(tasks.status, [...OPEN_TASK_STATUSES]),
              sql`${tasks.context}->>'scheduledJobId' = ${claimed.id}`,
            ),
          )
          .orderBy(asc(tasks.createdAt));

        if (liveScheduledTasks.length > 1) {
          const duplicateIds = liveScheduledTasks.slice(1).map((row) => row.id);
          await db
            .update(tasks)
            .set({
              status: 'cancelled',
              errorMessage: `Superseded duplicate from scheduled job ${claimed.id}`,
              nextRetryAt: null,
              leasedAt: null,
              updatedAt: new Date(),
            })
            .where(inArray(tasks.id, duplicateIds));
          console.warn(
            `[JobScheduler] Cancelled ${duplicateIds.length} duplicate task(s) for scheduled job '${claimed.name}'`,
          );
        }

        if (liveScheduledTasks.length > 0) {
          const nextRun = claimed.cronExpression
            ? CronParser.nextRun(claimed.cronExpression, now)
            : new Date(now.getTime() + this.pollIntervalMs);
          await db
            .update(scheduledJobs)
            .set({
              status: 'active',
              nextRunAt: nextRun ?? new Date(now.getTime() + this.pollIntervalMs),
              updatedAt: new Date(),
            })
            .where(and(eq(scheduledJobs.id, claimed.id), eq(scheduledJobs.status, 'running')));
          console.log(
            `[JobScheduler] Skipping '${claimed.name}' — prior scheduled task ${liveScheduledTasks[0].id} is still open`,
          );
          continue;
        }
      }

      claimedCount++;
      executions.push(this.executeClaimedJob(claimed));
    }

    await Promise.allSettled(executions);
    return claimedCount;
  }

  private async executeClaimedJob(job: typeof scheduledJobs.$inferSelect): Promise<void> {
    try {
      const result = await this.executor.execute(job.id);
      const completedAt = new Date();

      if (!result.success) {
        console.warn(`[JobScheduler] Job '${job.name}' failed: ${result.error}`);
        return; // JobExecutor owns retry/dead-letter state on ordinary failure.
      }

      if (job.cronExpression) {
        const nextRun = CronParser.nextRun(job.cronExpression, completedAt);
        await db
          .update(scheduledJobs)
          .set({
            status: 'active',
            nextRunAt: nextRun ?? new Date(completedAt.getTime() + this.pollIntervalMs),
            updatedAt: completedAt,
          })
          .where(and(eq(scheduledJobs.id, job.id), eq(scheduledJobs.status, 'running')));
      } else {
        await db
          .update(scheduledJobs)
          .set({ status: 'completed', nextRunAt: null, updatedAt: completedAt })
          .where(and(eq(scheduledJobs.id, job.id), eq(scheduledJobs.status, 'running')));
      }

      console.log(`[JobScheduler] Job '${job.name}' completed successfully`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[JobScheduler] Unexpected error executing job '${job.name}':`, err);

      // Executor-level infrastructure failure before normal retry bookkeeping:
      // release the durable claim with a bounded delay rather than stranding it.
      await db
        .update(scheduledJobs)
        .set({
          status: 'active',
          nextRunAt: new Date(Date.now() + Math.max(this.pollIntervalMs, 30_000)),
          error: `Scheduler execution error: ${error}`,
          updatedAt: new Date(),
        })
        .where(and(eq(scheduledJobs.id, job.id), eq(scheduledJobs.status, 'running')))
        .catch((releaseErr) => {
          console.error(`[JobScheduler] Failed to release claim for '${job.name}':`, releaseErr);
        });
    }
  }
}
