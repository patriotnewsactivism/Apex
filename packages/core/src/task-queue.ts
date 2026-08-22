import { randomUUID } from 'crypto';
import { db, tasks } from '@workspace/db';
import { eq, and, asc, or, isNull, lte, sql } from 'drizzle-orm';
import type { Task, NewTask } from '@workspace/db';
import type { TaskInput, TaskStatus } from './types.js';
import { recordDequeueAttempt, recordDequeueSuccess, recordDequeueFailure } from './runtime-health.js';
import { isLLMProviderChainFailure } from './provider-failure.js';

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
    recordDequeueAttempt();
    try {
      const now = new Date();
      // ROOT CAUSE FOUND 2026-08-19 (via the console.error added earlier
      // today): this raw `sql` fragment interpolated the bare `now` Date
      // object directly (`next_retry_at <= ${now}`). Drizzle's typed
      // `.set({ leasedAt: now, ... })` above knows each column's type and
      // serializes Date correctly, but a raw sql`` fragment has no column
      // type context -- the driver received an unconverted Date instance as
      // a bind parameter and threw `TypeError [ERR_INVALID_ARG_TYPE]: The
      // "string" argument must be of type string or an instance of Buffer
      // or ArrayBuffer. Received an instance of Date` on every single call.
      // This was thrown BEFORE the query ever reached Postgres -- every
      // agent's dequeue() has been failing identically and (until today)
      // silently since whatever commit introduced next_retry_at, which is
      // the actual explanation for the "workers never process tasks"
      // symptom this whole investigation chased through the LLM chain.
      // Fix: serialize explicitly with .toISOString() instead of relying on
      // implicit driver coercion inside a raw fragment.
      const nowIso = now.toISOString();
      // One round-trip: claim the row atomically and return the full updated record.
      const [task] = await db
        .update(tasks)
        .set({ status: 'in_progress', leasedAt: now, startedAt: now, updatedAt: now })
        .where(sql`${tasks.id} = (
          SELECT id FROM tasks
          WHERE assigned_agent_id = ${this.agentId}
            AND status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= ${nowIso})
          ORDER BY priority ASC, created_at ASC
          LIMIT 1
        )`)
        .returning();

      // Counted as a success even when no row matched: a healthy idle queue
      // and a queue that throws on every call are indistinguishable from the
      // outside otherwise, which is exactly the trap this whole investigation
      // fell into.
      recordDequeueSuccess(Boolean(task));
      if (task) return task;
    } catch (err) {
      recordDequeueFailure(this.agentId, err);
      // 2026-08-19: this used to swallow EVERY exception silently under the
      // assumption it only ever fires when the DB is genuinely offline. That
      // assumption was never verified and there was zero logging to check it
      // -- if this query throws for ANY other reason (bad SQL, schema drift,
      // driver issue), every single dequeue() call fails identically and
      // silently forever, with the outer loop's `if (!task) break` + 5s sleep
      // producing a system that looks alive (starts fine, polls, sleeps) but
      // never executes a single task, and never says why. Log it for real.
      // Drizzle/postgres-js wraps the REAL Postgres error in `.cause` — the
      // outer error's own .message/.stack is just "Failed query: <the SQL>"
      // and tells us nothing about WHY. Log the cause chain explicitly.
      const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
      console.error(`[TaskQueue.dequeue] agent=${this.agentId} query failed:`, err instanceof Error ? err.message : err);
      if (cause) {
        console.error(`[TaskQueue.dequeue] agent=${this.agentId} ROOT CAUSE:`, cause instanceof Error ? (cause.stack ?? cause.message) : cause);
        // postgres-js errors carry structured fields (code, detail, position, etc.) not on .message
        if (typeof cause === 'object') {
          const pgFields = ['code', 'detail', 'hint', 'position', 'severity', 'where', 'schema', 'table', 'column', 'constraint'];
          const extracted: Record<string, unknown> = {};
          for (const f of pgFields) {
            const v = (cause as Record<string, unknown>)[f];
            if (v !== undefined) extracted[f] = v;
          }
          if (Object.keys(extracted).length > 0) {
            console.error(`[TaskQueue.dequeue] agent=${this.agentId} PG FIELDS:`, JSON.stringify(extracted));
          }
        }
      }
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
        // Once the complete provider chain has failed, a 2s/4s/8s task retry
        // just repeats the same chain and floods the log. This includes the
        // 2026-08-22 retired-model 404 and no-configured-key failures, not only
        // quota responses. Fail it once; StalledWorkRecoveryJob handles the
        // recoverable subset later with a long, bounded backoff.
        const canRetry = task.retryCount < task.maxRetries && !isLLMProviderChainFailure(error);
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

  /** Return a task to the queue for a future worker to claim. */
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

  /** Restore the status of a task whose current worker stayed alive while it
   * waited for an approval decision. Re-queuing that same in-flight task would
   * let another worker claim and execute it a second time. */
  async markInProgress(taskId: string): Promise<void> {
    try {
      await db.update(tasks).set({
        status: 'in_progress',
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    } catch (err) {
      // DB offline: update in memory
    }

    const memTask = this.memoryQueue.find((t) => t.id === taskId);
    if (memTask) {
      memTask.status = 'in_progress';
    }
  }
}
