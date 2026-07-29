import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { db, agents, approvals, messages, tasks as tasksTable, learningInsights, strategyRecommendations } from '@workspace/db';
import { eq, and, desc } from 'drizzle-orm';
import { createLLMClient, getDefaultLLMConfig, type LLMClient } from './llm-client.js';
import { getToolRegistry } from './tool-registry.js';
import { MemoryManager, AgentLogger, type LogLevel } from './memory.js';
import { detectMalformedToolCall, buildMalformedToolCallCorrection } from './malformed-tool-calls.js';
import { detectNonCompletion, buildNonCompletionFailure } from './non-completion.js';
import { TaskQueue } from './task-queue.js';
import { OutcomeAnalyzer } from '@workspace/learning-system';
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

// ─── Standing rules appended to every agent's system prompt ──────────────────
//
// Added 2026-07-29 after the first post-deploy log showed agents declining work
// they were fully equipped to do: `apex-frontend-001` answered "I am unable to
// access the code for the frontend" while holding readFile/listDir/fetchUrl,
// and `apex-devops-001` answered "I don't have access to the deployment
// changes" while holding readFile/listDir/runShell/runInSandbox. Neither called
// a single tool. Both were recorded as completed.
//
// Kept here rather than copied into 13 role prompts so the rule cannot drift
// between agents, and short on purpose — a long preamble crowds out the
// role-specific instructions that follow it.

const STANDING_OPERATING_RULES = `

## Standing Rules (apply to every task)
1. YOU HAVE TOOLS. The tools listed for this request are real and available right
   now. Never answer "I don't have access" or "I am unable to" without having
   actually called them and seen them fail — that answer is treated as a failed
   task, not a completed one. If a tool errors, report the real error text.
2. TRY BEFORE YOU DECLINE. Reading the workspace, fetching a URL, or listing a
   directory costs one call. Make it before concluding something is unreachable.
3. NO FICTIONAL SUCCESS. Never describe work you did not do, and never state a
   number, name, status or URL you did not verify with a tool. Guessing a
   hostname and reporting "page not found" is a fabricated finding.
4. PARTIAL IS FINE, PRETEND IS NOT. If you complete part of the work, deliver
   that part and say plainly what remains. An honest partial is a good outcome;
   an invented complete one is the worst possible outcome.
`;

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
  get tier() { return this.config.tier; }
  get currentConcurrency() { return this.concurrency; }
  get maxIterations() { return this.config.maxIterations ?? 20; }

  /** Runtime reconfiguration — applies overrides to an already-running agent
   *  instance (from PATCH /api/agents/:id). Only concurrency and maxIterations
   *  are adjustable at runtime; the LLM provider/model requires a restart. */
  reconfigure(opts: { concurrency?: number; maxIterations?: number }): void {
    if (opts.concurrency !== undefined) {
      this.concurrency = Math.max(1, opts.concurrency);
    }
    if (opts.maxIterations !== undefined) {
      this.config.maxIterations = opts.maxIterations;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Upsert agent record (safe against offline DB)
    try {
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
    } catch (err) {
      // DB offline: initialization in memory mode
    }

    // Recover any tasks that were left in_progress from a previous crashed run.
    // These will never be picked up again by dequeue() (which only selects
    // 'pending'), so we reset them to 'pending' here, once at startup, before
    // the polling loop begins.
    await db
      .update(tasksTable)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(and(
        eq(tasksTable.assignedAgentId, this.config.id),
        eq(tasksTable.status, 'in_progress'),
      ));

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
    // Promise<unknown> (not Promise<void>): executeTask resolves TaskResult on
    // success and the .catch handler resolves void on failure -- the union
    // type doesn't matter here, only Promise.race()'s settle timing is used.
    const inFlight = new Map<string, Promise<unknown>>();

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
    let toolExecutions = 0;
    let requiredApprovals = 0;
    // Self-review runs at most once per task (see the critique gate below), so
    // the extra reasoning costs exactly one additional LLM call, never a loop.
    let selfReviewed = false;
    // How many times this task's model has emitted a tool call as plain text
    // instead of issuing it through the API. Bounded: one correction, then the
    // task fails honestly rather than completing on work that never ran.
    let malformedToolCallCount = 0;
    const startTime = Date.now();
    const analyzer = new OutcomeAnalyzer();

    const recordMetricsAsync = (success: boolean, errorMsg?: string) => {
      const durationMs = Date.now() - startTime;
      // Fire-and-forget async execution so task completion is never delayed (<100ms guaranteed)
      void analyzer.recordOutcome({
        taskId,
        agentId: this.config.id,
        role: this.config.role,
        durationMs,
        success,
        toolExecutions,
        llmCalls: iterations,
        iterations,
        requiredApprovals,
        errorMessage: errorMsg,
        taskTitle: title,
        description,
      }).catch(() => {});
    };

    try {
      await this.logger.thinking(`Starting task: ${title}`, taskId);
      this.setStatus('thinking');

      // Build initial message history
      const memContext = await this.memory.buildMemoryContext(description);
      const learningContext = await this.buildLearningContext(this.config.role);
      const systemPrompt =
        this.config.systemPrompt + STANDING_OPERATING_RULES + memContext + learningContext;

      const history: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `## Task: ${title}\n\n${description}\n\nContext: ${JSON.stringify(context, null, 2)}`,
        },
      ];

      const registry = getToolRegistry(process.env.WORKSPACE_ROOT ?? process.cwd());
      const tools = registry.getLLMToolSchemas(this.config.tools);

      // Resolve this task's goal once, up front, instead of re-querying inside
      // every delegate call. It also populates ToolContext.goalId, which
      // sendMessage already reads but nothing ever set — so delegated tasks
      // now inherit their goal and roll up correctly in list_goals /
      // get_delegation_status instead of landing goal-less.
      let taskGoalId: string | undefined;
      try {
        const [row] = await db
          .select({ goalId: tasksTable.goalId })
          .from(tasksTable)
          .where(eq(tasksTable.id, taskId))
          .limit(1);
        taskGoalId = row?.goalId ?? undefined;
      } catch {
        // DB offline — delegation still works, it just can't inherit the goal.
      }

      // Agentic loop
      while (iterations < maxIter) {
        iterations++;

        const response = await this.llm.complete(history, tools);

        // Record which provider ACTUALLY served this call. persistActualProvider
        // has existed since the multi-provider fallback chain was added but was
        // never called from anywhere — so `agents.provider`/`agents.model` kept
        // whatever initialize() wrote on first insert (the CONFIGURED provider),
        // and the dashboard's per-agent "model · provider" label silently lied
        // whenever the chain fell through to a fallback. That mattered exactly
        // when it was most needed: diagnosing a stalled workforce, where knowing
        // the configured provider is failing and which fallback is carrying the
        // load is the whole question. Fire-and-forget; never throws.
        this.persistActualProvider(response.model);

        // Add assistant response to history
        history.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        if (response.content) {
          await this.logger.thinking(response.content.slice(0, 200), taskId);
        }

        // ── Guard: a tool call written as TEXT is not a finished task ──────
        //
        // Models that don't reliably use the structured tool API (typically
        // the smaller ones the fallback chain drops to once the primary
        // provider is exhausted) emit the call in the message body instead.
        // The provider then returns toolCalls: [], which the loop below would
        // read as "agent is done" — completing the task and storing the
        // pseudo-call as its RESULT. Observed live 2026-07-28: DevOps
        // "completed" an outage diagnosis in 2s having executed nothing.
        //
        // A false success is worse than a failure here, because it propagates:
        // the delegating manager sees a done child, reports the initiative
        // delivered, and the goal closes on work that never happened. Correct
        // it once; if the model does it again, fail honestly.
        if (response.toolCalls.length === 0 && response.content) {
          const malformed = detectMalformedToolCall(
            response.content,
            tools.map((t) => t.name),
          );
          if (malformed) {
            malformedToolCallCount++;
            await this.logger.warn(
              `Model emitted a text-encoded tool call (${malformed.pattern}` +
                `${malformed.toolName ? `: ${malformed.toolName}` : ''}) — nothing executed. ` +
                `Attempt ${malformedToolCallCount}.`,
              taskId,
            );

            if (malformedToolCallCount === 1 && iterations < maxIter) {
              history.push({ role: 'user', content: buildMalformedToolCallCorrection(malformed) });
              this.setStatus('thinking');
              continue;
            }

            // Refused to correct. Do NOT complete — that would record work
            // that never ran as a success.
            const failMsg =
              `Model emitted tool calls as text (${malformed.pattern}) and did not correct after being told. ` +
              `No tool actually executed, so this task is NOT done. This usually means the serving model ` +
              `does not support structured tool calls — check which provider is handling this agent. ` +
              `Excerpt: ${malformed.excerpt.slice(0, 200)}`;
            await this.logger.error(`Task failed: ${title} — ${failMsg}`, undefined, taskId);
            await this.taskQueue.fail(taskId, failMsg);
            this.setStatus('error');
            recordMetricsAsync(false, failMsg);
            return { success: false, error: failMsg };
          }
        }

        // No tool calls → the agent thinks it's finished. Before accepting
        // that, make it check its own work ONCE.
        //
        // Why: a "done" turn is just text — the model claiming success. In
        // practice that is where the weak output came from: an agent that
        // delegated three initiatives and immediately declared them complete
        // (without ever looking at whether the children ran), or a researcher
        // answering "I couldn't find anything" after a single failed search.
        // Neither is caught by the tool loop, because neither calls a tool.
        //
        // One critique turn with the tools still attached lets the agent
        // discover the gap and keep working — the loop continues normally if it
        // decides to act, and completes on the next no-tool-call turn if the
        // work genuinely holds up. Costs one LLM call per task; set
        // APEX_SELF_REVIEW=0 to disable.
        const selfReviewEnabled = !['0', 'false', 'off'].includes(
          (process.env.APEX_SELF_REVIEW ?? '1').toLowerCase(),
        );
        if (
          response.toolCalls.length === 0 &&
          selfReviewEnabled &&
          !selfReviewed &&
          iterations < maxIter
        ) {
          selfReviewed = true;
          await this.logger.thinking('Self-review: checking own work before reporting done', taskId);
          history.push({
            role: 'user',
            content: [
              'SELF-REVIEW (automatic — no human is asking). Before this is accepted as complete,',
              'audit your own answer against the original task honestly:',
              '',
              '1. Did you actually DO the work, or only describe/plan it? Producing a plan when the task',
              '   asked for a deliverable is not complete.',
              '2. If you delegated anything (sendMessage / dispatchSwarm), you have NOT verified the outcome.',
              '   Call get_delegation_status now and read what the child tasks actually returned before',
              '   claiming the initiative is done. Delegating is not delivering.',
              '3. If your answer reports empty/no results, that is a failed search strategy, not an answer.',
              '   Retry with different, narrower queries before giving up.',
              '4. Are any specifics (numbers, names, statuses) things you verified with a tool, or did you',
              '   assume them? Verify or remove them — never state an unverified figure as fact.',
              '5. Is anything genuinely blocked on a decision only Don can make? Then escalate_to_human',
              '   with your recommendation, and say plainly in your final answer what is blocked.',
              '',
              'If you find a gap: keep working — call the tools you need. If the work genuinely holds up,',
              'reply with your final report and no tool calls. Do not pad it; do not restate this checklist.',
            ].join('\n'),
          });
          this.setStatus('thinking');
          continue;
        }

        if (response.toolCalls.length === 0) {
          const result = response.content;

          // "I couldn't do it" is not a completed task. Checked only after the
          // self-review turn above, so the agent has already had one explicit
          // chance to notice the gap and keep working. Live 2026-07-29, minutes
          // after first deploy: frontend/devops/backend/qa-director/lead-dev all
          // reported inability and every one was recorded `done`. Two of those
          // claimed to lack tools they actually had — giving up was cheaper than
          // working, and nothing downstream could tell the difference.
          const gaveUp = selfReviewed ? detectNonCompletion(result) : null;
          if (gaveUp) {
            const failMsg = buildNonCompletionFailure(gaveUp, toolExecutions > 0);
            await this.logger.error(`Task failed: ${title} — ${failMsg}`, undefined, taskId);
            await this.taskQueue.fail(taskId, failMsg);
            this.setStatus('error');
            recordMetricsAsync(false, failMsg);
            return { success: false, error: failMsg };
          }

          await this.taskQueue.complete(taskId, result);
          await this.memory.remember(`task:${taskId}:result`, result.slice(0, 500), { importance: 0.6 });
          await this.logger.info(`Task completed: ${title}`, taskId);
          this.setStatus('idle');
          recordMetricsAsync(true);
          return { success: true, output: result };
        }

        // Execute tool calls
        this.setStatus('acting');
        const toolResults: LLMMessage[] = [];

        for (const tc of response.toolCalls) {
          toolExecutions++;
          await this.logger.acting(`Calling tool: ${tc.name}(${JSON.stringify(tc.args).slice(0, 100)})`, taskId);

          const toolContext: ToolContext = {
            agentId: this.config.id,
            taskId,
            goalId: taskGoalId,
            workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd(),
            requestApproval: async (toolName, args, reason) => {
              requiredApprovals++;
              return this.requestHumanApproval(taskId, toolName, args, reason);
            },
            delegateToRole: async (targetRole, input) =>
              this.delegateToRole(targetRole, {
                title: input.title,
                description: input.description,
                parentTaskId: input.parentTaskId ?? taskId,
                goalId: taskGoalId,
                context: input.context ?? undefined,
              }),
            delegateToAgent: async (targetAgentId, input) =>
              this.delegate(targetAgentId, {
                title: input.title,
                description: input.description,
                parentTaskId: input.parentTaskId ?? taskId,
                goalId: input.goalId ?? taskGoalId,
                context: input.context ?? undefined,
              }),
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
      const failMsg = `Exceeded max iterations (${maxIter})`;
      await this.taskQueue.fail(taskId, failMsg);
      recordMetricsAsync(false, failMsg);
      return { success: false, error: 'Max iterations exceeded' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The reason goes in the MESSAGE, not only in `data`. AgentLogger.error
      // stashes the Error in the log row's `data` column, but the dashboard's
      // Log Stream renders `message` — so every failure read as a bare
      // "Task failed: <title>" with no cause, making live triage impossible
      // (observed 2026-07-28: Lead Developer failed mid-delegation and the
      // stream showed nothing about why).
      await this.logger.error(`Task failed: ${title} — ${msg}`, err, taskId);
      await this.taskQueue.fail(taskId, msg);
      this.setStatus('error');
      recordMetricsAsync(false, msg);
      return { success: false, error: msg };
    }
  }

  /** Best-effort: inject active learning insights and applied strategy
   * recommendations relevant to this agent's role into the system prompt, so
   * patterns the learning system has detected actually shape future reasoning
   * (this is what closes the learning loop). Never throws — a DB hiccup must
   * not block task execution. */
  private async buildLearningContext(role: string): Promise<string> {
    try {
      const now = Date.now();
      const roleLower = role.toLowerCase();

      const recentInsights = await db
        .select()
        .from(learningInsights)
        .orderBy(desc(learningInsights.createdAt))
        .limit(30);

      const active = recentInsights.filter((i) => !i.expiresAt || i.expiresAt.getTime() > now);
      const roleRelevant = active.filter(
        (i) =>
          i.title.toLowerCase().includes(roleLower) ||
          i.description.toLowerCase().includes(roleLower),
      );
      const warnings = active.filter((i) => i.insightType === 'warning');
      const chosen = [...roleRelevant, ...warnings.filter((w) => !roleRelevant.includes(w))].slice(0, 4);

      const appliedRecs = await db
        .select()
        .from(strategyRecommendations)
        .where(eq(strategyRecommendations.status, 'applied'))
        .orderBy(desc(strategyRecommendations.createdAt))
        .limit(3);

      const lines: string[] = [];
      for (const i of chosen) {
        lines.push(`- (${i.insightType}) ${i.title}: ${i.description}`);
      }
      for (const r of appliedRecs) {
        lines.push(`- [standing strategy] ${r.title}: ${r.text}`);
      }
      if (lines.length === 0) return '';
      return `\n## What I've Learned (apply these to your decisions)\n${lines.join('\n')}\n`;
    } catch {
      return '';
    }
  }

  // ── Delegation ─────────────────────────────────────────────────────────────

  async delegate(
    targetAgentId: string,
    input: TaskInput,
  ): Promise<string> {
    // Idempotency: if a task with the same goalId + title already exists for this
    // agent (even if it failed or is in any other state), return the existing
    // task ID rather than creating a duplicate. This prevents the CEO
    // "Process Goal" retry loop from spawning fresh retryCount=0 child tasks on
    // every re-run, which bypasses maxRetries and causes the crash-loop.
    if (input.goalId) {
      const existing = await db
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(and(
          eq(tasksTable.goalId, input.goalId),
          eq(tasksTable.title, input.title),
          eq(tasksTable.assignedAgentId, targetAgentId),
        ))
        .limit(1);

      if (existing.length > 0) {
        await this.logger.info(
          `Skipping duplicate task "${input.title}" for goal ${input.goalId} — already exists (${existing[0].id})`,
          input.parentTaskId,
        );
        return existing[0].id;
      }
    }

    // Create task assigned to target agent
    const now = new Date();
    const taskId = randomUUID();

    await db.insert(tasksTable).values({
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

  /** Best-effort, fire-and-forget: updates the agent's DB row with the
   * provider/model that actually served the most recent LLM call. Never
   * awaited by the caller and never throws -- a DB hiccup here must not
   * interrupt the agent's task loop. */
  private persistActualProvider(servedModel: string): void {
    const slashIdx = servedModel.indexOf('/');
    if (slashIdx <= 0) return; // unexpected format, skip rather than guess
    const provider = servedModel.slice(0, slashIdx);
    const model = servedModel.slice(slashIdx + 1);
    db.update(agents)
      .set({ provider, model, lastActiveAt: new Date() })
      .where(eq(agents.id, this.config.id))
      .then(() => {})
      .catch(() => {
        // DB offline / not yet initialized -- fine, next successful call retries
      });
  }

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
