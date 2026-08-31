import { randomUUID } from 'crypto';
import { db, tasks } from '@workspace/db';
import { eq, and, or, isNull, lte, sql } from 'drizzle-orm';
import type { Task } from '@workspace/db';
import type { TaskInput } from './types.js';
import { recordDequeueAttempt, recordDequeueSuccess, recordDequeueFailure } from './runtime-health.js';
import {
  getLLMPauseRetryAt,
  getTransientLLMRetryDelayMs,
  isTransientLLMChainFailure,
  shouldSuppressImmediateLLMRetry,
} from './provider-failure.js';

// ─── Task Queue ───────────────────────────────────────────────────────────────

const EPHEMERAL_FALLBACK_VALUES = new Set(['1', 'true', 'on', 'yes']);
const HARD_TIMEOUT_MARKER = 'wall-clock timeout';
const TIMEOUT_QUARANTINE_PREFIX = 'Quarantined after hard task timeout:';
const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);

function ephemeralFallbackEnabled(): boolean {
  // Process-local work is intentionally opt-in for local development only.
  // Production autonomy must never report success for work that disappears on
  // restart or exists on only one Cloud Run instance.
  if (process.env.NODE_ENV === 'production') return false;
  return EPHEMERAL_FALLBACK_VALUES.has(
    (process.env.APEX_ALLOW_EPHEMERAL_QUEUE_FALLBACK ?? '').trim().toLowerCase(),
  );
}

function requireDurabilityOrAllowLocalFallback(operation: string, err: unknown): void {
  if (ephemeralFallbackEnabled()) return;
  const detail = err instanceof Error ? err.message : String(err);
  throw new Error(
    `[TaskQueue.${operation}] durable Postgres operation failed; refusing process-local fallback: ${detail}`,
  );
}

function isHardTaskTimeout(error: string): boolean {
  return error.includes('Task exceeded hard') && error.includes(HARD_TIMEOUT_MARKER);
}

function isTimeoutQuarantine(task: Pick<Task, 'status' | 'errorMessage'>): boolean {
  return task.status === 'blocked' && task.errorMessage?.startsWith(TIMEOUT_QUARANTINE_PREFIX) === true;
}

export class TaskQueue {
  private agentId: string;
  private memoryQueue: Task[] = [];

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /** Create and durably enqueue a task. */
  async enqueue(input: TaskInput & { createdByAgentId?: string }): Promise<Task> {
    const now = new Date();
    const taskId = randomUUID();
    const taskRecord: Task = {
      id: taskId,
      goalId: input.goalId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      description: input.description,
      status: 'pending',
      priority: input.priority ?? 5,
      assignedAgentId: this.agentId,
      createdByAgentId: input.createdByAgentId ?? this.agentId,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      dueAt: null,
      nextRetryAt: null,
      leasedAt: null,
      retryCount: 0,
      maxRetries: 3,
      result: null,
      errorMessage: null,
      context: (input.context as Record<string, unknown>) ?? null,
    };

    try {
      const [created] = await db.insert(tasks).values(taskRecord).returning();
      if (!created) throw new Error('insert returned no task row');
      return created;
    } catch (err) {
      requireDurabilityOrAllowLocalFallback('enqueue', err);
    }

    this.memoryQueue.push(taskRecord);
    return taskRecord;
  }

  /**
   * Claim the next highest-priority pending task whose retry window elapsed.
   *
   * The outer UPDATE repeats the pending/agent/retry predicates. That matters:
   * two workers can evaluate the scalar subquery at nearly the same time, but
   * after one changes the row to in_progress the other worker's UPDATE no
   * longer matches and therefore cannot return/execute the same task.
   */
  async dequeue(): Promise<Task | null> {
    recordDequeueAttempt();
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const [task] = await db
        .update(tasks)
        .set({ status: 'in_progress', leasedAt: now, startedAt: now, updatedAt: now })
        .where(
          and(
            eq(tasks.assignedAgentId, this.agentId),
            eq(tasks.status, 'pending'),
            or(isNull(tasks.nextRetryAt), lte(tasks.nextRetryAt, now)),
            sql`${tasks.id} = (
              SELECT id FROM tasks
              WHERE assigned_agent_id = ${this.agentId}
                AND status = 'pending'
                AND (next_retry_at IS NULL OR next_retry_at <= ${nowIso})
              ORDER BY priority ASC, created_at ASC
              LIMIT 1
            )`,
          ),
        )
        .returning();

      recordDequeueSuccess(Boolean(task));
      if (task) return task;
      return null;
    } catch (err) {
      recordDequeueFailure(this.agentId, err);
      const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
      console.error(
        `[TaskQueue.dequeue] agent=${this.agentId} query failed:`,
        err instanceof Error ? err.message : err,
      );
      if (cause) {
        console.error(
          `[TaskQueue.dequeue] agent=${this.agentId} ROOT CAUSE:`,
          cause instanceof Error ? (cause.stack ?? cause.message) : cause,
        );
        if (typeof cause === 'object') {
          const pgFields = ['code', 'detail', 'hint', 'position', 'severity', 'where', 'schema', 'table', 'column', 'constraint'];
          const extracted: Record<string, unknown> = {};
          for (const field of pgFields) {
            const value = (cause as Record<string, unknown>)[field];
            if (value !== undefined) extracted[field] = value;
          }
          if (Object.keys(extracted).length > 0) {
            console.error(`[TaskQueue.dequeue] agent=${this.agentId} PG FIELDS:`, JSON.stringify(extracted));
          }
        }
      }
      requireDurabilityOrAllowLocalFallback('dequeue', err);
    }

    const nowMs = Date.now();
    const nextMemIdx = this.memoryQueue.findIndex(
      (task) => task.status === 'pending' && (!task.nextRetryAt || task.nextRetryAt.getTime() <= nowMs),
    );
    if (nextMemIdx !== -1) {
      const task = this.memoryQueue[nextMemIdx];
      const now = new Date();
      task.status = 'in_progress';
      task.startedAt = now;
      task.leasedAt = now;
      return task;
    }

    return null;
  }

  /**
   * Complete only work still owned by the live execution. A task cancelled or
   * otherwise terminalized by another actor must never be resurrected as done
   * by a late promise. The one exception is a timeout-quarantined task: if the
   * original execution eventually returns real completion evidence, that same
   * execution may close its quarantine successfully.
   */
  async complete(taskId: string, result: string): Promise<void> {
    try {
      const [completed] = await db
        .update(tasks)
        .set({
          status: 'done',
          result,
          errorMessage: null,
          nextRetryAt: null,
          leasedAt: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            or(
              eq(tasks.status, 'in_progress'),
              and(
                eq(tasks.status, 'blocked'),
                sql`${tasks.errorMessage} LIKE ${`${TIMEOUT_QUARANTINE_PREFIX}%`}`,
              ),
            ),
          ),
        )
        .returning({ id: tasks.id });

      if (!completed) {
        throw new Error(
          `Task ${taskId} completion rejected because it is no longer owned by this execution state`,
        );
      }
    } catch (err) {
      requireDurabilityOrAllowLocalFallback('complete', err);
    }

    const memTask = this.memoryQueue.find((task) => task.id === taskId);
    if (memTask) {
      if (memTask.status !== 'in_progress' && !isTimeoutQuarantine(memTask)) {
        throw new Error(
          `Task ${taskId} completion rejected because it is no longer owned by this execution state`,
        );
      }
      memTask.status = 'done';
      memTask.result = result;
      memTask.errorMessage = null;
      memTask.nextRetryAt = null;
      memTask.leasedAt = null;
      memTask.completedAt = new Date();
    }
  }

  /** Fail a task, optionally retry with durable exponential backoff. */
  async fail(taskId: string, error: string): Promise<void> {
    const capacityRetryAt = getLLMPauseRetryAt(error, taskId);

    try {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (task) {
        // A hard timeout in BaseAgent is a race against an execution that may
        // still be alive: Promise.race cannot cancel arbitrary tool/DB work.
        // Automatic retry here would permit a second worker to execute the same
        // task while the first execution is still capable of side effects.
        // Quarantine instead. Operators/recovery logic can inspect the explicit
        // blocked state; if the original execution later finishes successfully,
        // complete() is allowed to close this specific quarantine.
        if (isHardTaskTimeout(error)) {
          if (TERMINAL_TASK_STATUSES.has(task.status)) return;
          if (isTimeoutQuarantine(task)) return;

          const quarantineReason = `${TIMEOUT_QUARANTINE_PREFIX} ${error}`;
          await db.update(tasks).set({
            status: 'blocked',
            errorMessage: quarantineReason,
            nextRetryAt: null,
            leasedAt: null,
            updatedAt: new Date(),
          }).where(and(eq(tasks.id, taskId), eq(tasks.status, 'in_progress')));
          return;
        }

        // Once a timeout has quarantined a still-live execution, a late error
        // from that detached promise must not turn the row back into retryable
        // work. That would recreate the duplicate-side-effect race.
        if (isTimeoutQuarantine(task)) return;

        // Never overwrite an independently terminalized task (for example an
        // operator cancellation) with a late failure from an old execution.
        if (TERMINAL_TASK_STATUSES.has(task.status)) return;

        if (capacityRetryAt) {
          await db
            .update(tasks)
            .set({
              status: 'pending',
              errorMessage: error,
              nextRetryAt: capacityRetryAt,
              leasedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, taskId));
          return;
        }

        const canRetry = task.retryCount < task.maxRetries && !shouldSuppressImmediateLLMRetry(error);
        if (canRetry) {
          const baseDelayMs = Math.min(Math.pow(2, task.retryCount) * 1000, 300_000);
          const retryDelayMs = isTransientLLMChainFailure(error)
            ? getTransientLLMRetryDelayMs(baseDelayMs, taskId)
            : baseDelayMs;
          const nextRetryAt = new Date(Date.now() + retryDelayMs);
          await db.update(tasks).set({
            status: 'pending',
            retryCount: task.retryCount + 1,
            errorMessage: error,
            nextRetryAt,
            leasedAt: null,
            updatedAt: new Date(),
          }).where(eq(tasks.id, taskId));
        } else {
          await db.update(tasks).set({
            status: 'failed',
            errorMessage: error,
            nextRetryAt: null,
            leasedAt: null,
            updatedAt: new Date(),
          }).where(eq(tasks.id, taskId));
        }
        return;
      }

      throw new Error(`task ${taskId} not found while recording failure`);
    } catch (err) {
      requireDurabilityOrAllowLocalFallback('fail', err);
    }

    const memTask = this.memoryQueue.find((task) => task.id === taskId);
    if (memTask) {
      if (isHardTaskTimeout(error)) {
        if (TERMINAL_TASK_STATUSES.has(memTask.status) || isTimeoutQuarantine(memTask)) return;
        memTask.status = 'blocked';
        memTask.errorMessage = `${TIMEOUT_QUARANTINE_PREFIX} ${error}`;
        memTask.nextRetryAt = null;
        memTask.leasedAt = null;
        return;
      }
      if (isTimeoutQuarantine(memTask) || TERMINAL_TASK_STATUSES.has(memTask.status)) return;
      if (capacityRetryAt) {
        memTask.status = 'pending';
        memTask.errorMessage = error;
        memTask.nextRetryAt = capacityRetryAt;
        memTask.leasedAt = null;
        return;
      }
      memTask.status = 'failed';
      memTask.errorMessage = error;
      memTask.leasedAt = null;
    }
  }

  /** Block a task while waiting on an external dependency. */
  async block(taskId: string, reason: string): Promise<void> {
    try {
      await db.update(tasks).set({
        status: 'blocked',
        errorMessage: reason,
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    } catch (err) {
      requireDurabilityOrAllowLocalFallback('block', err);
    }

    const memTask = this.memoryQueue.find((task) => task.id === taskId);
    if (memTask) {
      memTask.status = 'blocked';
      memTask.errorMessage = reason;
    }
  }

  /** Unblock a task and return it to the durable queue. */
  async unblock(taskId: string): Promise<void> {
    try {
      await db.update(tasks).set({
        status: 'pending',
        errorMessage: null,
        leasedAt: null,
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    } catch (err) {
      requireDurabilityOrAllowLocalFallback('unblock', err);
    }

    const memTask = this.memoryQueue.find((task) => task.id === taskId);
    if (memTask) {
      memTask.status = 'pending';
      memTask.errorMessage = null;
      memTask.leasedAt = null;
    }
  }

  /** Mark a task awaiting human approval for a gated tool call. */
  async awaitApproval(taskId: string): Promise<void> {
    try {
      await db.update(tasks).set({
        status: 'awaiting_approval',
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    } catch (err) {
      requireDurabilityOrAllowLocalFallback('awaitApproval', err);
    }

    const memTask = this.memoryQueue.find((task) => task.id === taskId);
    if (memTask) memTask.status = 'awaiting_approval';
  }

  /** Return a task to the queue for a future worker to claim. */
  async resume(taskId: string): Promise<void> {
    try {
      await db.update(tasks).set({
        status: 'pending',
        leasedAt: null,
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    } catch (err) {
      requireDurabilityOrAllowLocalFallback('resume', err);
    }

    const memTask = this.memoryQueue.find((task) => task.id === taskId);
    if (memTask) {
      memTask.status = 'pending';
      memTask.leasedAt = null;
    }
  }

  /** Restore a live worker's status after an approval decision. */
  async markInProgress(taskId: string): Promise<void> {
    const now = new Date();
    try {
      await db.update(tasks).set({
        status: 'in_progress',
        leasedAt: now,
        updatedAt: now,
      }).where(eq(tasks.id, taskId));
    } catch (err) {
      requireDurabilityOrAllowLocalFallback('markInProgress', err);
    }

    const memTask = this.memoryQueue.find((task) => task.id === taskId);
    if (memTask) {
      memTask.status = 'in_progress';
      memTask.leasedAt = now;
    }
  }
}
