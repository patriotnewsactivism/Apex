import { randomUUID } from 'crypto';
import { db, tasks } from '@workspace/db';
import { eq, and, asc, or, isNull, lte, sql } from 'drizzle-orm';
import type { Task, NewTask } from '@workspace/db';
import type { TaskInput, TaskStatus } from './types.js';

// ─── Task Queue ───────────────────────────────────────────────────────────────

export class TaskQueue {
  private agentId: string;
  private memoryQueue: Task[] = [];

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /** Create a new task and enqueue it */
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
      if (created) return created;
    } catch (err) {
      // DB offline: fallback to memory queue
    }

    this.memoryQueue.push(taskRecord);
    return taskRecord;
  }

  /** Pick next highest-priority pending task whose retry window has elapsed.
   *
   * Uses a single atomic UPDATE ... RETURNING so two concurrent workers
   * can never both claim the same task row (the non-atomic SELECT + UPDATE
   * that was here before had a TOCTOU window). The sub-select is ordered by
   * priority ASC, then created_at ASC so oldest high-priority tasks win. */
  async dequeue(): Promise<Task | null> {
    try {
      const now = new Date();
      // One round-trip: claim the row atomically and return the full updated record.
      const [task] = await db
        .update(tasks)
        .set({ status: 'in_progress', leasedAt: now, startedAt: now, updatedAt: now })
        .where(sql`${tasks.id} = (
          SELECT id FROM tasks
          WHERE assigned_agent_id = ${this.agentId}
            AND status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= ${now})
          ORDER BY priority ASC, created_at ASC
          LIMIT 1
        )`)
        .returning();

      if (task) return task;
    } catch (err) {
      // 2026-08-19: this used to swallow EVERY exception silently under the
      // assumption it only ever fires when the DB is genuinely offline. That
      // assumption was never verified and there was zero logging to check it
      // -- if this query throws for ANY other reason (bad SQL, schema drift,
      // driver issue), every single dequeue() call fails identically and
      // silently forever, with the outer loop's `if (!task) break` + 5s sleep
      // producing a system that looks alive (starts fine, polls, sleeps) but
      // never executes a single task, and never says why. Log it for real.
      console.error(`[TaskQueue.dequeue] agent=${this.agentId} query failed:`, err instanceof Error ? err.stack ?? err.message : err);
    }

    const nextMemIdx = this.memoryQueue.findIndex((t) => t.status === 'pending');
    if (nextMemIdx !== -1) {
      const task = this.memoryQueue[nextMemIdx];
      task.status = 'in_progress';
      task.startedAt = new Date();
      return task;
    }

    return null;
  }

  /** Complete a task with result */
  async complete(taskId: string, result: string): Promise<void> {
    try {
      await db
        .update(tasks)
        .set({ status: 'done', result, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
    } catch (err) {
      // DB offline: update in memory
    }

    const memTask = this.memoryQueue.find((t) => t.id === taskId);
    if (memTask) {
      memTask.status = 'done';
      memTask.result = result;
      memTask.completedAt = new Date();
    }
  }

  /** Fail a task, optionally retry with exponential backoff */
  async fail(taskId: string, error: string): Promise<void> {
    try {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (task) {
        // A capacity/rate-limit exhaustion (the whole LLM chain 429/402/401'd)
        // will not clear within the backoff window — retrying just hammers the
        // exhausted providers and floods the dashboard. Fail it now; the
        // autonomous loop / a re-submit picks it up once capacity returns.
        const canRetry = task.retryCount < task.maxRetries && !this.isCapacityExhaustion(error);
        if (canRetry) {
          // Exponential backoff: 2s, 4s, 8s … capped at 5 minutes (300s).
          // nextRetryAt is written to the DB so ALL workers respect the window —
          // the previous setTimeout-only approach only blocked the calling worker
          // while other workers could pick the task up immediately.
          const retryDelayMs = Math.min(Math.pow(2, task.retryCount) * 1000, 300_000);
          const nextRetryAt = new Date(Date.now() + retryDelayMs);
          await db.update(tasks).set({
            status: 'pending',
            retryCount: task.retryCount + 1,
            errorMessage: error,
            nextRetryAt,
            updatedAt: new Date(),
          }).where(eq(tasks.id, taskId));
        } else {
          await db.update(tasks).set({
            status: 'failed',
            errorMessage: error,
            updatedAt: new Date(),
          }).where(eq(tasks.id, taskId));
        }
        return;
      }
    } catch (err) {
      // DB offline: update in memory
    }

    const memTask = this.memoryQueue.find((t) => t.id === taskId);
    if (memTask) {
      memTask.status = 'failed';
      memTask.errorMessage = error;
    }
  }

  /** True when `error` is a whole-chain LLM capacity/rate-limit exhaustion that
   * retrying on a backoff window cannot fix (every provider 429/402/401'd). */
  private isCapacityExhaustion(error: string): boolean {
    if (!error.includes('All LLM providers failed')) return false;
    return /(\b429\b|\b402\b|\b401\b|rate limit|insufficient credits|quota|tokens per day)/i.test(error);
  }

  /** Block a task (waiting on external dependency) */
  async block(taskId: string, reason: string): Promise<void> {
    try {
      await db.update(tasks).set({
        status: 'blocked',
        errorMessage: reason,
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    } catch (err) {
      // DB offline: update in memory
    }

    const memTask = this.memoryQueue.find((t) => t.id === taskId);
    if (memTask) {
      memTask.status = 'blocked';
      memTask.errorMessage = reason;
    }
  }

  /** Unblock a task */
  async unblock(taskId: string): Promise<void> {
    try {
      await db.update(tasks).set({
        status: 'pending',
        errorMessage: null,
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    } catch (err) {
      // DB offline: update in memory
    }

    const memTask = this.memoryQueue.find((t) => t.id === taskId);
    if (memTask) {
      memTask.status = 'pending';
      memTask.errorMessage = null;
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
      // DB offline: update in memory
    }

    const memTask = this.memoryQueue.find((t) => t.id === taskId);
    if (memTask) {
      memTask.status = 'awaiting_approval';
    }
  }

  /** Resume a task after an approval decision back to pending/in_progress */
  async resume(taskId: string): Promise<void> {
    try {
      await db.update(tasks).set({
        status: 'pending',
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    } catch (err) {
      // DB offline: update in memory
    }

    const memTask = this.memoryQueue.find((t) => t.id === taskId);
    if (memTask) {
      memTask.status = 'pending';
    }
  }
}
