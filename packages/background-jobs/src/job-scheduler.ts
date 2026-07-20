// ─── JobScheduler ─────────────────────────────────────────────────────────────
//
// Polls the scheduled_jobs table every 60s, finds jobs where next_run_at <= now
// AND enabled = true, dispatches them to the JobExecutor, and calculates the
// next run for recurring (cron) jobs. Supports graceful start/stop.

import { db, scheduledJobs } from '@workspace/db';
import { and, eq, lte, isNotNull } from 'drizzle-orm';
import { CronParser } from './cron-parser.js';
import { JobExecutor } from './job-executor.js';
import {
  TaskDelegationJob,
  HealthCheckJob,
  ReportGenerationJob,
  MaintenanceJob,
} from './handlers/index.js';

export interface JobSchedulerConfig {
  pollIntervalMs?: number;  // default 60_000
}

export class JobScheduler {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalMs: number;
  private executor: JobExecutor;

  constructor(config?: JobSchedulerConfig) {
    this.pollIntervalMs = config?.pollIntervalMs ?? 60_000;
    this.executor = new JobExecutor();

    // Register built-in handlers
    this.executor.registerHandler('task_delegation', new TaskDelegationJob());
    this.executor.registerHandler('health_check', new HealthCheckJob());
    this.executor.registerHandler('report_generation', new ReportGenerationJob());
    this.executor.registerHandler('maintenance', new MaintenanceJob());
  }

  /** Start the scheduler polling loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('📅 JobScheduler started');
    this.poll();
  }

  /** Stop the scheduler gracefully. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('📅 JobScheduler stopped');
  }

  /** Poll for due jobs and execute them. */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      await this.processDueJobs();
    } catch (err) {
      console.error('[JobScheduler] Poll error:', err instanceof Error ? err.message : err);
    }

    // Schedule next poll
    if (this.running) {
      this.timer = setTimeout(() => this.poll(), this.pollIntervalMs);
    }
  }

  /** Find and execute all due jobs. */
  private async processDueJobs(): Promise<void> {
    const now = new Date();

    // Find enabled jobs where next_run_at <= now
    const dueJobs = await db.select().from(scheduledJobs).where(
      and(
        eq(scheduledJobs.enabled, true),
        eq(scheduledJobs.status, 'active'),
        lte(scheduledJobs.nextRunAt, now),
      ),
    );

    for (const job of dueJobs) {
      if (!this.executor.canAccept()) {
        console.warn('[JobScheduler] Executor at capacity, deferring remaining jobs');
        break;
      }

      // Execute asynchronously (don't block the loop for other due jobs)
      this.executor.execute(job.id).then(async (result) => {
        if (result.success) {
          console.log(`[JobScheduler] Job '${job.name}' completed successfully`);
        } else {
          console.warn(`[JobScheduler] Job '${job.name}' failed: ${result.error}`);
        }

        // Calculate next run for recurring cron jobs
        if (job.cronExpression && result.success) {
          const nextRun = CronParser.nextRun(job.cronExpression, new Date());
          if (nextRun) {
            await db.update(scheduledJobs).set({
              nextRunAt: nextRun,
              updatedAt: new Date(),
            }).where(eq(scheduledJobs.id, job.id));
          }
        } else if (!job.cronExpression && result.success) {
          // One-time job completed — mark as completed
          await db.update(scheduledJobs).set({
            status: 'completed',
            updatedAt: new Date(),
          }).where(eq(scheduledJobs.id, job.id));
        }
      }).catch((err) => {
        console.error(`[JobScheduler] Unexpected error executing job '${job.name}':`, err);
      });
    }
  }
}
