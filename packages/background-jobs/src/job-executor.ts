// ─── JobExecutor ──────────────────────────────────────────────────────────────
//
// Executes a single scheduled job with timeout + retry (exponential backoff).
// Logs every attempt to the job_execution_log table. Enforces a max concurrent
// jobs limit (default 50) per ROADMAP.md governance spec.

import crypto from 'crypto';
import { db, scheduledJobs, jobExecutionLog } from '@workspace/db';
import { eq } from 'drizzle-orm';
import type { JobHandler } from './handlers/index.js';

export interface JobExecutorConfig {
  maxConcurrent?: number;  // default 50
  defaultTimeoutMs?: number;  // default 60_000
}

export class JobExecutor {
  private inFlight = 0;
  private maxConcurrent: number;
  private defaultTimeoutMs: number;
  private handlers = new Map<string, JobHandler>();

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

  /**
   * Execute a job. Returns the execution result. Handles retry logic:
   * on failure, increments retry_count with exponential backoff delay.
   */
  async execute(jobId: string): Promise<{ success: boolean; output?: string; error?: string }> {
    // Fetch the job
    const [job] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, jobId)).limit(1);
    if (!job) {
      return { success: false, error: `Job ${jobId} not found` };
    }

    if (!job.enabled) {
      return { success: false, error: `Job ${jobId} is disabled` };
    }

    const handler = this.handlers.get(job.jobType);
    if (!handler) {
      return { success: false, error: `No handler registered for job type '${job.jobType}'` };
    }

    if (!this.canAccept()) {
      return { success: false, error: `Executor at capacity (${this.maxConcurrent} concurrent jobs)` };
    }

    const executionId = crypto.randomUUID();
    const startedAt = new Date();

    // Log execution start
    await db.insert(jobExecutionLog).values({
      jobId: job.id,
      executionId,
      startedAt,
      status: 'running',
    });

    this.inFlight++;

    try {
      // Execute with timeout
      const result = await Promise.race([
        handler.execute(job),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Job timed out after ${this.defaultTimeoutMs}ms`)), this.defaultTimeoutMs),
        ),
      ]);

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      // Log success
      await db.update(jobExecutionLog).set({
        status: 'completed',
        completedAt,
        durationMs,
        output: typeof result === 'string' ? result : JSON.stringify(result),
      }).where(eq(jobExecutionLog.executionId, executionId));

      // Update job
      await db.update(scheduledJobs).set({
        lastRunAt: completedAt,
        retryCount: 0, // Reset on success
        error: null,
        updatedAt: completedAt,
      }).where(eq(scheduledJobs.id, jobId));

      return { success: true, output: typeof result === 'string' ? result : JSON.stringify(result) };
    } catch (err) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMsg.includes('timed out');

      // Log failure
      await db.update(jobExecutionLog).set({
        status: isTimeout ? 'timeout' : 'failed',
        completedAt,
        durationMs,
        error: errorMsg,
      }).where(eq(jobExecutionLog.executionId, executionId));

      // Update job with retry logic (exponential backoff)
      const newRetryCount = job.retryCount + 1;
      const maxRetries = job.maxRetries ?? 3;

      if (newRetryCount >= maxRetries) {
        // Max retries exhausted — mark job as failed
        await db.update(scheduledJobs).set({
          retryCount: newRetryCount,
          error: errorMsg,
          status: 'failed',
          lastRunAt: completedAt,
          updatedAt: completedAt,
        }).where(eq(scheduledJobs.id, jobId));
      } else {
        // Schedule retry with exponential backoff: 2^retry * 30s
        const backoffMs = Math.pow(2, newRetryCount) * 30_000;
        const nextRetry = new Date(completedAt.getTime() + backoffMs);

        await db.update(scheduledJobs).set({
          retryCount: newRetryCount,
          error: errorMsg,
          nextRunAt: nextRetry,
          lastRunAt: completedAt,
          updatedAt: completedAt,
        }).where(eq(scheduledJobs.id, jobId));
      }

      return { success: false, error: errorMsg };
    } finally {
      this.inFlight--;
    }
  }
}
