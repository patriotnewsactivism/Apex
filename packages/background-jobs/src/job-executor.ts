// ─── JobExecutor ──────────────────────────────────────────────────────────────
//
// Executes one already-claimed scheduled job with timeout + bounded retry.
// Logs every attempt to job_execution_log. Concurrency is process-local load
// protection; durable ownership/deduplication is provided by JobScheduler's
// scheduled_jobs status claim.

import crypto from 'crypto';
import { db, scheduledJobs, jobExecutionLog } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { CronParser } from './cron-parser.js';
import type { JobHandler } from './handlers/index.js';

class JobTimeoutError extends Error {}

export interface JobExecutorConfig {
  maxConcurrent?: number;  // default 50
  defaultTimeoutMs?: number;  // default 60_000
}

export class JobExecutor {
  private inFlight = 0;
  private maxConcurrent: number;
  private defaultTimeoutMs: number;
  private handlers = new Map<string, JobHandler>();
  private abortControllers = new Map<string, AbortController>();

  constructor(config?: JobExecutorConfig) {
    this.maxConcurrent = config?.maxConcurrent ?? 50;
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 60_000;
  }

  registerHandler(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  get currentLoad(): number {
    return this.inFlight;
  }

  canAccept(): boolean {
    return this.inFlight < this.maxConcurrent;
  }

  /** Atomically reserve one process-local concurrency slot. */
  reserveSlot(): boolean {
    if (this.inFlight >= this.maxConcurrent) return false;
    this.inFlight++;
    return true;
  }

  /**
   * Execute a durably claimed job. On ordinary failure, retry state is written
   * back to scheduled_jobs and the claim is released to status='active'.
   */
  async execute(jobId: string): Promise<{ success: boolean; output?: string; error?: string }> {
    // Reserve before the first await so a scheduler dispatch loop cannot race
    // past maxConcurrent while several DB reads are still pending.
    if (!this.reserveSlot()) {
      return { success: false, error: `Executor at capacity (${this.maxConcurrent} concurrent jobs)` };
    }

    let executionId: string | null = null;
    let abortController: AbortController | null = null;

    try {
      const [job] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, jobId)).limit(1);
      if (!job) {
        return { success: false, error: `Job ${jobId} not found` };
      }

      if (!job.enabled) {
        return { success: false, error: `Job ${jobId} is disabled` };
      }

      if (job.status !== 'running') {
        return {
          success: false,
          error: `Job ${jobId} is not durably claimed (status=${job.status})`,
        };
      }

      const handler = this.handlers.get(job.jobType);
      if (!handler) {
        const errorMsg = `No handler registered for job type '${job.jobType}'`;
        await db.update(scheduledJobs).set({
          status: 'failed',
          error: errorMsg,
          updatedAt: new Date(),
        }).where(eq(scheduledJobs.id, jobId));
        return { success: false, error: errorMsg };
      }

      executionId = crypto.randomUUID();
      abortController = new AbortController();
      this.abortControllers.set(executionId, abortController);
      const startedAt = new Date();

      await db.insert(jobExecutionLog).values({
        jobId: job.id,
        executionId,
        startedAt,
        status: 'running',
      });

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            // Abort first so cooperative handlers stop before the timeout is
            // recorded and the occurrence becomes eligible for retry.
            if (abortController && !abortController.signal.aborted) {
              abortController.abort();
            }
            reject(new JobTimeoutError(`Job timed out after ${this.defaultTimeoutMs}ms`));
          }, this.defaultTimeoutMs);
          abortController?.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        });

        const result = await Promise.race([
          handler.execute(job, abortController.signal),
          timeoutPromise,
        ]);

        const completedAt = new Date();
        const durationMs = completedAt.getTime() - startedAt.getTime();

        await db.update(jobExecutionLog).set({
          status: 'completed',
          completedAt,
          durationMs,
          output: typeof result === 'string' ? result : JSON.stringify(result),
        }).where(eq(jobExecutionLog.executionId, executionId));

        // Leave status='running' until JobScheduler atomically finalizes this
        // exact claimed occurrence and advances nextRunAt.
        await db.update(scheduledJobs).set({
          lastRunAt: completedAt,
          retryCount: 0,
          error: null,
          updatedAt: completedAt,
        }).where(eq(scheduledJobs.id, jobId));

        return { success: true, output: typeof result === 'string' ? result : JSON.stringify(result) };
      } catch (err) {
        const completedAt = new Date();
        const durationMs = completedAt.getTime() - startedAt.getTime();
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof JobTimeoutError;

        await db.update(jobExecutionLog).set({
          status: isTimeout ? 'timeout' : 'failed',
          completedAt,
          durationMs,
          error: errorMsg,
        }).where(eq(jobExecutionLog.executionId, executionId));

        const newRetryCount = job.retryCount + 1;
        const maxRetries = job.maxRetries ?? 3;

        if (newRetryCount >= maxRetries) {
          if (job.cronExpression) {
            // A recurring job is not permanently destroyed by a transient
            // outage. Close this failed occurrence and schedule the next one.
            const nextRun = CronParser.nextRun(job.cronExpression, completedAt);
            await db.update(scheduledJobs).set({
              retryCount: 0,
              error: `Recovered after ${maxRetries} retries: ${errorMsg}`,
              status: 'active',
              nextRunAt: nextRun ?? new Date(completedAt.getTime() + 60_000),
              lastRunAt: completedAt,
              updatedAt: completedAt,
            }).where(eq(scheduledJobs.id, jobId));
          } else {
            await db.update(scheduledJobs).set({
              retryCount: newRetryCount,
              error: errorMsg,
              status: 'failed',
              lastRunAt: completedAt,
              updatedAt: completedAt,
            }).where(eq(scheduledJobs.id, jobId));
          }
        } else {
          const backoffMs = Math.pow(2, newRetryCount) * 30_000;
          const nextRetry = new Date(completedAt.getTime() + backoffMs);

          await db.update(scheduledJobs).set({
            status: 'active',
            retryCount: newRetryCount,
            error: errorMsg,
            nextRunAt: nextRetry,
            lastRunAt: completedAt,
            updatedAt: completedAt,
          }).where(eq(scheduledJobs.id, jobId));
        }

        return { success: false, error: errorMsg };
      }
    } finally {
      this.inFlight--;
      if (executionId) this.abortControllers.delete(executionId);
      if (abortController && !abortController.signal.aborted) {
        abortController.abort();
      }
    }
  }
}
