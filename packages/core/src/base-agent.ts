import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { db, agents, approvals, messages } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { createLLMClient, getDefaultLLMConfig, type LLMClient } from './llm-client.js';
import { getToolRegistry } from './tool-registry.js';
import { MemoryManager, AgentLogger, type LogLevel } from './memory.js';
import { TaskQueue } from './task-queue.js';
import type {
  AgentConfig,
  AgentStatus,
  ApexEvent,
  LLMMessage,
  TaskInput,
  TaskResult,
  ToolContext,
} from './types.js';

// ─── Global Event Bus ─────────────────────────────────────────────────────────

export const apexEventBus = new EventEmitter();
apexEventBus.setMaxListeners(100);

export function emitApexEvent(event: ApexEvent) {
  apexEventBus.emit('event', event);
}

// ─── Base Agent ───────────────────────────────────────────────────────────────

export abstract class BaseAgent {
  protected config: AgentConfig;
  protected llm: LLMClient;
  protected memory: MemoryManager;
  protected logger: AgentLogger;
  protected taskQueue: TaskQueue;
  protected status: AgentStatus = 'idle';
  // Task IDs this instance currently has in flight. Plural because with
  // concurrency > 1 this agent may be executing several swarm-dispatched
  // tasks at once. Only used as a best-effort tag for log lines that don't
  // pass an explicit taskId (executeTask itself always threads the real
  // taskId through explicitly, so this is a fallback only).
  protected currentTaskIds: Set<string> = new Set();
  private running = false;
  // How many tasks this instance will pull off its own queue and run at
  // once. Default 1 = old strictly-sequential behavior.
  private concurrency: number;

  constructor(config: AgentConfig) {
    this.config = config;
    const llmConfig = {
      ...getDefaultLLMConfig(config.role),
      ...config.llm,
    };
    this.llm = createLLMClient(llmConfig);
    this.memory = new MemoryManager(config.id);
    this.logger = new AgentLogger(config.id, (level: LogLevel, message: string) => {
      emitApexEvent({
        type: 'log',
        agentId: config.id,
        // Best-effort: with concurrency > 1 there can be several in-flight
        // tasks. Real log lines from executeTask pass their own taskId
        // explicitly (see logger.info(msg, taskId) calls) and aren't
        // affected by this fallback.
        taskId: [...this.currentTaskIds][0],
        level,
        message,
        timestamp: Date.now(),
      });
    });
    this.taskQueue = new TaskQueue(config.id);
    this.concurrency = Math.max(1, config.concurrency ?? 1);
  }

  get id() { return this.config.id; }
  get name() { return this.config.name; }
  get role() { return this.config.role; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Upsert agent record
    await db.insert(agents).values({
      id: this.config.id,
      name: this.config.name,
      role: this.config.role,
      tier: this.config.tier,
      parentId: this.config.parentId ?? null,
      status: 'idle',
      systemPrompt: this.config.systemPrompt,
      model: this.config.llm.model,
      provider: this.config.llm.provider,
      createdAt: new Date(),
    }).onConflictDoUpdate({
      target: agents.id,
      set: {
        status: 'idle',
        lastActiveAt: new Date(),
      },
    });

    await this.logger.info(`Agent ${this.name} (${this.role}) initialized`);
    this.setStatus('idle');
  }

  /** Start the autonomous execution loop.
   *
   * Runs up to `this.concurrency` tasks from this agent's own queue at once.
   * This is what makes dispatchSwarm's fan-out actually parallel: a swarm
   * dispatched to a role creates N independent task rows, but previously
   * this loop dequeued and fully awaited one task before ever looking at the
   * next, so N swarm instances for the same role just queued up behind each
   * other. Concurrency=1 (the default for most roles) preserves that old
   * behavior exactly; roles that receive swarms set a higher concurrency. */
  async start(): Promise<void> {
    this.running = true;
    await this.logger.info(
      `${this.name} starting autonomous loop (concurrency=${this.concurrency})`,
    );
    this.setStatus('idle');

    let consecutiveErrors = 0;
    const inFlight = new Map<string, Promise<void>>();

    while (this.running) {
      try {
        // Top up in-flight work up to the concurrency limit.
        while (this.running && inFlight.size < this.concurrency) {
          const task = await this.taskQueue.dequeue();
          if (!task) break;

          consecutiveErrors = 0;
          this.currentTaskIds.add(task.id);
          const p = this.executeTask(task.id, task.title, task.description, task.context ?? {})
            .catch(async (err) => {
              // executeTask already catches+logs+fails its own errors; this is
              // just a last-resort guard so a truly unexpected throw can never
              // take down the whole worker-pool loop.
              const msg = err instanceof Error ? err.message : String(err);
              await this.logger.error(`Unhandled task error: ${msg}`, err, task.id).catch(() => {});
            })
            .finally(() => {
              this.currentTaskIds.delete(task.id);
              inFlight.delete(task.id);
            });
          inFlight.set(task.id, p);
        }

        if (inFlight.size === 0) {
          await new Promise((r) => setTimeout(r, 2000)); // Poll every 2s
          continue;
        }

        // Wait for at least one running task to free up a slot, then loop
        // back around to top up again (rather than waiting for ALL of them,
        // which would collapse back to sequential-ish batching).
        await Promise.race(inFlight.values());
      } catch (err) {
        // NEVER let a transient error (DB blip, pooler hiccup, etc.) kill this agent's
        // loop permanently. Log it, back off, and keep polling. Previously an uncaught
        // error here would reject start()'s promise, the caller would only log it
        // (agent.start().catch(...)), and this agent's queue would stall forever.
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        await this.logger.error(`Polling loop error (will retry): ${msg}`, err).catch(() => {});
        const backoff = Math.min(2000 * Math.pow(2, consecutiveErrors), 30000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  stop() {
    this.running = false;
    this.setStatus('idle');
  }

  // ── Core Reasoning ─────────────────────────────────────────────────────────

  protected async executeTask(
    taskId: string,
    title: string,
    description: string,
    context: Record<string, unknown>,
  ): Promise<TaskResult> {
    const maxIter = this.config.maxIterations ?? 20;
    let iterations = 0;

    try {
      await this.logger.thinking(`Starting task: ${title}`, taskId);
      this.setStatus('thinking');

      // Build initial message history
      const memContext = await this.memory.buildMemoryContext(description);
      const systemPrompt = this.config.systemPrompt + memContext;

      const history: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `## Task: ${title}\n\n${description}\n\nContext: ${JSON.stringify(context, null, 2)}`,
        },
      ];

      const registry = getToolRegistry(process.env.WORKSPACE_ROOT ?? process.cwd());
      const tools = registry.getLLMToolSchemas(this.config.tools);

      // Agentic loop
      while (iterations < maxIter) {
        iterations++;

        const response = await this.llm.complete(history, tools);

        // Add assistant response to history
        history.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        if (response.content) {
          await this.logger.thinking(response.content.slice(0, 200), taskId);
        }

        // No tool calls → task is done
        if (response.toolCalls.length === 0) {
          const result = response.content;
          await this.taskQueue.complete(taskId, result);
          await this.memory.remember(`task:${taskId}:result`, result.slice(0, 500), { importance: 0.6 });
          await this.logger.info(`Task completed: ${title}`, taskId);
          this.setStatus('idle');
          return { success: true, output: result };
        }

        // Execute tool calls
        this.setStatus('acting');
        const toolResults: LLMMessage[] = [];

        for (const tc of response.toolCalls) {
          await this.logger.acting(`Calling tool: ${tc.name}(${JSON.stringify(tc.args).slice(0, 100)})`, taskId);

          const toolContext: ToolContext = {
            agentId: this.config.id,
            taskId,
            workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd(),
            requestApproval: async (toolName, args, reason) => {
              return this.requestHumanApproval(taskId, toolName, args, reason);
            },
            delegateToRole: async (targetRole, input) => {
              const { db, tasks } = await import('@workspace/db');
              const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
              return this.delegateToRole(targetRole, {
                title: input.title,
                description: input.description,
                parentTaskId: input.parentTaskId ?? taskId,
                goalId: task?.goalId ?? undefined,
                context: input.context ?? undefined,
              });
            },
            delegateToAgent: async (targetAgentId, input) => {
              const { db, tasks } = await import('@workspace/db');
              const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
              return this.delegate(targetAgentId, {
                title: input.title,
                description: input.description,
                parentTaskId: input.parentTaskId ?? taskId,
                goalId: input.goalId ?? task?.goalId ?? undefined,
                context: input.context ?? undefined,
              });
            },
          };

          const result = await registry.execute(tc.name, tc.args, toolContext);

          toolResults.push({
            role: 'tool',
            toolCallId: tc.id,
            name: tc.name,
            content: JSON.stringify(result),
          });
        }

        history.push(...toolResults);
        this.setStatus('thinking');
      }

      // Hit iteration limit
      await this.taskQueue.fail(taskId, `Exceeded max iterations (${maxIter})`);
      return { success: false, error: 'Max iterations exceeded' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.logger.error(`Task failed: ${title}`, err, taskId);
      await this.taskQueue.fail(taskId, msg);
      this.setStatus('error');
      return { success: false, error: msg };
    }
  }

  // ── Delegation ─────────────────────────────────────────────────────────────

  async delegate(
    targetAgentId: string,
    input: TaskInput,
  ): Promise<string> {
    // Create task assigned to target agent
    const now = new Date();
    const { randomUUID } = await import('crypto');
    const taskId = randomUUID();

    const { tasks } = await import('@workspace/db');
    await db.insert(tasks).values({
      id: taskId,
      goalId: input.goalId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      description: input.description,
      status: 'pending',
      priority: input.priority ?? 5,
      assignedAgentId: targetAgentId,
      createdByAgentId: this.config.id,
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: 3,
      context: input.context ?? null,
    });

    emitApexEvent({ type: 'task:created', taskId, title: input.title, assignedAgentId: targetAgentId });
    await this.logger.info(`Delegated task "${input.title}" to agent ${targetAgentId}`, input.parentTaskId);

    return taskId;
  }

  async findAgentIdByRole(role: string): Promise<string | null> {
    const { eq } = await import('drizzle-orm');
    const { db, agents } = await import('@workspace/db');
    const [row] = await db.select({ id: agents.id }).from(agents).where(eq(agents.role, role)).limit(1);
    return row?.id ?? null;
  }

  async delegateToRole(
    targetRole: string,
    input: TaskInput,
  ): Promise<string> {
    const agentId = await this.findAgentIdByRole(targetRole);
    if (!agentId) {
      throw new Error(`No active agent found with role: ${targetRole}`);
    }
    return this.delegate(agentId, input);
  }

  // ── Human Approval Gate ────────────────────────────────────────────────────

  async requestHumanApproval(
    taskId: string,
    toolName: string,
    args: unknown,
    reason: string,
  ): Promise<boolean> {
    // If approval not required, auto-approve
    if (!this.config.approvalRequired) return true;

    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      taskId,
      agentId: this.config.id,
      toolName,
      toolArgs: args as Record<string, unknown>,
      reason,
      status: 'pending',
      createdAt: new Date(),
    });

    await this.taskQueue.awaitApproval(taskId);
    emitApexEvent({ type: 'approval:requested', approvalId, agentId: this.config.id, toolName, reason });

    // Poll for approval decision (max 5 min)
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
      if (row?.status === 'approved') {
        await this.taskQueue.resume(taskId);
        return true;
      }
      if (row?.status === 'rejected') {
        await this.taskQueue.resume(taskId);
        return false;
      }
    }

    // Timeout: previously this just returned false, leaving the task's
    // status permanently stuck at 'awaiting_approval' (getPending() only
    // ever queries 'pending'/'in_progress' -- a timed-out approval meant
    // the task silently vanished from the queue forever, requiring a human
    // to be watching and clicking within 5 minutes or the work was lost).
    // Fixed 2026-07-18: mark the approval row rejected and resume the task
    // so the agent's own loop sees the rejection and can react (retry,
    // report back, try a different approach) instead of the run just dying.
    await db.update(approvals).set({ status: 'rejected' }).where(eq(approvals.id, approvalId));
    await this.taskQueue.resume(taskId);
    return false; // Timeout = reject
  }

  // ── Memory shortcuts ───────────────────────────────────────────────────────

  async remember(key: string, value: string, importance = 0.5) {
    await this.memory.remember(key, value, { importance });
    emitApexEvent({ type: 'memory:updated', agentId: this.config.id, key });
  }

  async recall(query: string) {
    return this.memory.recall(query);
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  protected setStatus(status: AgentStatus, message?: string) {
    this.status = status;
    db.update(agents)
      .set({ status, lastActiveAt: new Date() })
      .where(eq(agents.id, this.config.id))
      .then(() => {});
    emitApexEvent({ type: 'agent:status', agentId: this.config.id, status, message });
  }

  getStatus(): AgentStatus {
    return this.status;
  }
}
