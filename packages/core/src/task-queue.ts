import { randomUUID } from 'crypto';
import { db, tasks } from '@workspace/db';
import { eq, and, asc } from 'drizzle-orm';
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

  /** Pick next highest-priority pending task */
  async dequeue(): Promise<Task | null> {
    try {
      const pending = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.assignedAgentId, this.agentId), eq(tasks.status, 'pending')))
        .orderBy(asc(tasks.priority), asc(tasks.createdAt))
        .limit(1);

      if (pending.length > 0) {
        const task = pending[0];
        await db
          .update(tasks)
          .set({ status: 'in_progress', startedAt: new Date(), updatedAt: new Date() })
          .where(eq(tasks.id, task.id));
        return { ...task, status: 'in_progress' };
      }
    } catch (err) {
      // DB offline: check in-memory queue
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

  /** Fail a task, optionally retry */
  async fail(taskId: string, error: string): Promise<void> {
    try {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (task) {
        const canRetry = task.retryCount < task.maxRetries;
        if (canRetry) {
          await db.update(tasks).set({
            status: 'pending',
            retryCount: task.retryCount + 1,
            errorMessage: error,
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
