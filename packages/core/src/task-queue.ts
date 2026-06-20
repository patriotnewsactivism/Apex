import { randomUUID } from 'crypto';
import { db, tasks } from '@workspace/db';
import { eq, and, inArray, asc } from 'drizzle-orm';
import type { Task, NewTask } from '@workspace/db';
import type { TaskInput, TaskStatus } from './types.js';

// ─── Task Queue ───────────────────────────────────────────────────────────────

export class TaskQueue {
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /** Create a new task and enqueue it */
  async enqueue(input: TaskInput & { createdByAgentId?: string }): Promise<Task> {
    const now = new Date();
    const task: NewTask = {
      id: randomUUID(),
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
      retryCount: 0,
      maxRetries: 3,
      context: input.context ?? null,
    };

    const [created] = await db.insert(tasks).values(task).returning();
    return created;
  }

  /** Pick next highest-priority pending task */
  async dequeue(): Promise<Task | null> {
    const pending = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.assignedAgentId, this.agentId), eq(tasks.status, 'pending')))
      .orderBy(asc(tasks.priority), asc(tasks.createdAt))
      .limit(1);

    if (pending.length === 0) return null;
    const task = pending[0];

    // Mark as in_progress
    await db
      .update(tasks)
      .set({ status: 'in_progress', startedAt: new Date(), updatedAt: new Date() })
      .where(eq(tasks.id, task.id));

    return { ...task, status: 'in_progress' };
  }

  /** Complete a task with result */
  async complete(taskId: string, result: string): Promise<void> {
    await db
      .update(tasks)
      .set({ status: 'done', result, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
  }

  /** Fail a task, optionally retry */
  async fail(taskId: string, error: string): Promise<void> {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return;

    const canRetry = task.retryCount < task.maxRetries;
    const delay = Math.pow(2, task.retryCount) * 1000; // exponential backoff

    if (canRetry) {
      await db.update(tasks).set({
        status: 'pending',
        retryCount: task.retryCount + 1,
        errorMessage: error,
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));

      // Simple delay before retry
      await new Promise((r) => setTimeout(r, delay));
    } else {
      await db.update(tasks).set({
        status: 'failed',
        errorMessage: error,
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    }
  }

  /** Block a task (waiting on external dependency) */
  async block(taskId: string, reason: string): Promise<void> {
    await db.update(tasks).set({
      status: 'blocked',
      errorMessage: reason,
      updatedAt: new Date(),
    }).where(eq(tasks.id, taskId));
  }

  /** Set task to awaiting approval */
  async awaitApproval(taskId: string): Promise<void> {
    await db.update(tasks).set({
      status: 'awaiting_approval',
      updatedAt: new Date(),
    }).where(eq(tasks.id, taskId));
  }

  /** Resume a blocked/awaiting_approval task */
  async resume(taskId: string): Promise<void> {
    await db.update(tasks).set({
      status: 'in_progress',
      updatedAt: new Date(),
    }).where(eq(tasks.id, taskId));
  }

  /** Get all pending tasks for this agent */
  async getPending(): Promise<Task[]> {
    return db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedAgentId, this.agentId),
          inArray(tasks.status, ['pending', 'in_progress']),
        ),
      )
      .orderBy(asc(tasks.priority), asc(tasks.createdAt));
  }

  /** Get a specific task */
  async get(taskId: string): Promise<Task | null> {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return task ?? null;
  }

  /** Get all subtasks of a parent task */
  async getChildren(parentTaskId: string): Promise<Task[]> {
    return db.select().from(tasks).where(eq(tasks.parentTaskId, parentTaskId));
  }
}
