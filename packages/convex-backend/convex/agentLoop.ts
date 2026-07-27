import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal, api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import { getDefaultLLMConfig } from './llmConfig.js';
import type { LLMMessage } from './llm.js';
import { dispatchTool, getLLMToolSchemas, TOOL_DEFS, type ToolContext } from './toolRegistry.js';

// ─── Agent Loop ──────────────────────────────────────────────────────────────
//
// Replaces packages/core/src/base-agent.ts's BaseAgent.start() (an in-process
// `while(true)` + setTimeout poll) with 13 independent self-chaining actions —
// one recursive tick() per agent, each keeping its own concurrency/backoff,
// mirroring the isolation the old in-process Map-per-agent gave for free.
// runIteration replaces executeTask's agentic while-loop: each invocation
// does exactly one LLM turn + its tool executions, persists state to
// taskRuns, and either completes the task or schedules the next iteration —
// see the migration plan (§3) for the full design rationale, including why
// the old busy-wait approval gate (`while(Date.now()<deadline){sleep(1000)}`)
// couldn't be ported as-is and became the pendingJoins/resumeToolCall design
// below instead.

const IDLE_POLL_MS = 2000;
const ERROR_BACKOFF_BASE_MS = 2000;
const ERROR_BACKOFF_CAP_MS = 30_000;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_STALE_MS = 30_000;

type AgentMeta = {
  maxIterations?: number;
  concurrency?: number;
  tools?: string[];
  approvalRequired?: boolean;
};

type PendingJoin = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  kind: 'approval' | 'externalJob';
  refId: string;
};

// ─── Tick: per-agent self-chaining scheduler loop ───────────────────────────

export const tick = internalAction({
  args: { agentId: v.id('agents'), concurrency: v.number(), consecutiveErrors: v.optional(v.number()) },
  handler: async (ctx, { agentId, concurrency, consecutiveErrors }) => {
    try {
      // Heartbeat first, unconditionally — this is what lets the watchdog
      // cron tell "chain alive but idle/busy" apart from "chain died".
      await ctx.runMutation(internal.agents.touchHeartbeat, { agentId });

      const inProgressCount: number = await ctx.runQuery(internal.tasks.countInProgress, { agentId });
      if (inProgressCount >= Math.max(1, concurrency)) {
        await ctx.scheduler.runAfter(IDLE_POLL_MS, internal.agentLoop.tick, { agentId, concurrency });
        return;
      }

      const task = await ctx.runMutation(internal.tasks.dequeueFor, { agentId });
      if (!task) {
        await ctx.scheduler.runAfter(IDLE_POLL_MS, internal.agentLoop.tick, { agentId, concurrency });
        return;
      }

      // Kick off this task's iteration loop, then immediately look for more
      // work up to the concurrency limit — mirrors the old top-up-in-flight
      // loop in BaseAgent.start().
      await ctx.scheduler.runAfter(0, internal.agentLoop.runIteration, { taskId: task._id, agentId });
      await ctx.scheduler.runAfter(0, internal.agentLoop.tick, { agentId, concurrency });
    } catch (err) {
      // Never let a transient error (a blip in a downstream call, etc.) kill
      // this agent's chain permanently — log it, back off, keep going.
      const errors = (consecutiveErrors ?? 0) + 1;
      const backoff = Math.min(ERROR_BACKOFF_BASE_MS * Math.pow(2, errors), ERROR_BACKOFF_CAP_MS);
      console.error(`[agentLoop] tick error for agent ${agentId} (attempt ${errors}):`, err);
      await ctx.scheduler.runAfter(backoff, internal.agentLoop.tick, { agentId, concurrency, consecutiveErrors: errors });
    }
  },
});

/** Watchdog: re-kicks any agent whose heartbeat has gone stale (an uncaught
 * error killed its chain before it could reschedule itself). A healthy chain
 * touches its heartbeat every ~0-2s via tick, so this never flags a live one. */
export const resurrectStaleChains = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - HEARTBEAT_STALE_MS;
    const all = await ctx.db.query('agents').collect();
    const stale = all.filter((a) => !a.lastActiveAt || a.lastActiveAt < cutoff);
    for (const agent of stale) {
      const meta = (agent.metadata as AgentMeta | undefined) ?? {};
      await ctx.scheduler.runAfter(0, internal.agentLoop.tick, { agentId: agent._id, concurrency: meta.concurrency ?? 1 });
    }
    return stale.length;
  },
});

// ─── Delegation helpers (ported from BaseAgent.delegate/delegateToRole) ─────

type DelegateInput = { title: string; description: string; parentTaskId?: string; goalId?: string; priority?: number; context?: Record<string, unknown> };

async function delegateToAgentImpl(
  ctx: ActionCtx, fromAgentId: Id<'agents'>, currentTaskId: Id<'tasks'>, targetAgentId: Id<'agents'>, input: DelegateInput,
): Promise<string> {
  const currentTask = await ctx.runQuery(api.tasks.get, { taskId: currentTaskId });
  return await ctx.runMutation(internal.tasks.delegate, {
    assignedAgentId: targetAgentId,
    createdByAgentId: fromAgentId,
    goalId: (input.goalId as Id<'goals'> | undefined) ?? currentTask?.goalId,
    parentTaskId: (input.parentTaskId as Id<'tasks'> | undefined) ?? currentTaskId,
    title: input.title,
    description: input.description,
    priority: input.priority,
    context: input.context,
  });
}

async function delegateToRoleImpl(
  ctx: ActionCtx, fromAgentId: Id<'agents'>, currentTaskId: Id<'tasks'>, targetRole: string, input: DelegateInput,
): Promise<string> {
  const candidates = await ctx.runQuery(internal.agents.listByRole, { role: targetRole });
  const target = candidates[0];
  if (!target) throw new Error(`No active agent found with role: ${targetRole}`);
  return delegateToAgentImpl(ctx, fromAgentId, currentTaskId, target._id, input);
}

function buildToolContext(ctx: ActionCtx, agentId: Id<'agents'>, taskId: Id<'tasks'>): ToolContext {
  return {
    agentId,
    taskId,
    delegateToRole: (targetRole: string, input: DelegateInput) => delegateToRoleImpl(ctx, agentId, taskId, targetRole, input),
    delegateToAgent: (targetAgentId: string, input: DelegateInput) => delegateToAgentImpl(ctx, agentId, taskId, targetAgentId as Id<'agents'>, input),
    requestApproval: async () => {
      throw new Error(
        "requestApproval is not callable from within a tool — approval gating is applied uniformly by agentLoop before dispatch, based on the tool's requiresApproval flag in TOOL_DEFS.",
      );
    },
  } as ToolContext;
}

// ─── Learning context reads (full learning-system port is M4; these two
// read-only queries are a hard dependency of every task iteration, so they
// live here rather than waiting) ─────────────────────────────────────────────

export const recentLearningInsights = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('learningInsights').order('desc').take(30);
    return rows;
  },
});

export const appliedStrategyRecommendations = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('strategyRecommendations').withIndex('by_status', (q) => q.eq('status', 'applied')).order('desc').take(3);
    return rows;
  },
});

// ─── Context builders (ported from packages/core/src/{memory,base-agent}.ts) ─

async function buildMemoryContext(ctx: ActionCtx, agentId: Id<'agents'>, query: string): Promise<string> {
  let mems;
  try {
    const queryEmbedding: number[] = await ctx.runAction(internal.llm.createEmbedding, { text: query });
    mems = await ctx.runQuery(internal.memories.recallByEmbedding, { agentId, queryEmbedding, limit: 8 });
  } catch (err) {
    console.warn('Vector recall failed, falling back to keyword search:', err);
    mems = await ctx.runQuery(internal.memories.recallByKeyword, { agentId, keyword: query, limit: 8 });
  }
  if (!mems || mems.length === 0) return '';

  const lines = [...mems]
    .sort((a: any, b: any) => b.importance - a.importance)
    .slice(0, 10)
    .map((m: any) => `- [${m.key}]: ${m.value}`);
  return `\n## My Memories\n${lines.join('\n')}\n`;
}

/** Best-effort: inject active learning insights + applied strategy
 * recommendations relevant to this agent's role. Never throws — a hiccup
 * here must not block task execution. */
async function buildLearningContext(ctx: ActionCtx, role: string): Promise<string> {
  try {
    const now = Date.now();
    const roleLower = role.toLowerCase();

    const recentInsights = await ctx.runQuery(internal.agentLoop.recentLearningInsights, {});
    const active = recentInsights.filter((i: any) => !i.expiresAt || i.expiresAt > now);
    const roleRelevant = active.filter(
      (i: any) => i.title.toLowerCase().includes(roleLower) || i.description.toLowerCase().includes(roleLower),
    );
    const warnings = active.filter((i: any) => i.insightType === 'warning');
    const chosen = [...roleRelevant, ...warnings.filter((w: any) => !roleRelevant.includes(w))].slice(0, 4);

    const appliedRecs = await ctx.runQuery(internal.agentLoop.appliedStrategyRecommendations, {});

    const lines: string[] = [];
    for (const i of chosen) lines.push(`- (${i.insightType}) ${i.title}: ${i.description}`);
    for (const r of appliedRecs) lines.push(`- [standing strategy] ${r.title}: ${r.text}`);
    if (lines.length === 0) return '';
    return `\n## What I've Learned (apply these to your decisions)\n${lines.join('\n')}\n`;
  } catch {
    return '';
  }
}

// ─── runIteration: one LLM turn + its tool executions ───────────────────────

export const runIteration = internalAction({
  args: { taskId: v.id('tasks'), agentId: v.id('agents') },
  handler: async (ctx, { taskId, agentId }) => {
    const agent = await ctx.runQuery(api.agents.get, { agentId });
    const task = await ctx.runQuery(api.tasks.get, { taskId });
    if (!agent || !task) return;

    const meta = (agent.metadata as AgentMeta | undefined) ?? {};
    const maxIterations = meta.maxIterations ?? 20;
    const allowedTools = meta.tools && meta.tools.length > 0 ? meta.tools : undefined;
    // Mirrors WorkforceOptions.approvalRequired's env-driven override in the
    // old packages/agents/src/index.ts: APEX_APPROVAL_MODE='strict' forces
    // approval for every agent regardless of role default, 'off' forces none,
    // unset falls through to this role's own configured default.
    const approvalMode = process.env.APEX_APPROVAL_MODE;
    const approvalRequired = approvalMode === 'strict' ? true : approvalMode === 'off' ? false : (meta.approvalRequired ?? false);

    const existingRun = await ctx.runQuery(internal.taskRuns.getByTask, { taskId });
    let history: LLMMessage[];
    let iteration: number;

    if (!existingRun) {
      const memoryContext = await buildMemoryContext(ctx, agentId, task.description);
      const learningContext = await buildLearningContext(ctx, agent.role);
      const systemPrompt = agent.systemPrompt + memoryContext + learningContext;

      history = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `## Task: ${task.title}\n\n${task.description}\n\nContext: ${JSON.stringify(task.context ?? {}, null, 2)}` },
      ];
      iteration = 1;
      await ctx.runMutation(internal.taskRuns.upsert, { taskId, agentId, iteration, history, status: 'running' });
    } else {
      history = existingRun.history as LLMMessage[];
      iteration = existingRun.iteration;
    }

    if (iteration > maxIterations) {
      const failMsg = `Exceeded max iterations (${maxIterations})`;
      await ctx.runMutation(internal.logs.append, { agentId, taskId, level: 'error', message: failMsg });
      await ctx.runMutation(internal.tasks.fail, { taskId, error: failMsg });
      await ctx.runMutation(internal.taskRuns.deleteByTask, { taskId });
      await ctx.runMutation(internal.agents.updateStatus, { agentId, status: 'error' });
      return;
    }

    await ctx.runMutation(internal.agents.updateStatus, { agentId, status: 'thinking' });
    await ctx.runMutation(internal.logs.append, { agentId, taskId, level: 'thinking', message: `Iteration ${iteration}: ${task.title}` });

    const llmConfig = getDefaultLLMConfig(agent.role);
    const toolSchemas = getLLMToolSchemas(allowedTools);

    let response;
    try {
      response = await ctx.runAction(internal.llm.complete, {
        messages: history,
        tools: toolSchemas,
        model: llmConfig.model,
        temperature: llmConfig.temperature,
        maxTokens: llmConfig.maxTokens,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.logs.append, { agentId, taskId, level: 'error', message: `Task failed: ${task.title}`, data: { error: msg } });
      await ctx.runMutation(internal.tasks.fail, { taskId, error: msg });
      await ctx.runMutation(internal.taskRuns.deleteByTask, { taskId });
      await ctx.runMutation(internal.agents.updateStatus, { agentId, status: 'error' });
      return;
    }

    history = [...history, { role: 'assistant', content: response.content, toolCalls: response.toolCalls }];

    if (response.content) {
      await ctx.runMutation(internal.logs.append, { agentId, taskId, level: 'thinking', message: response.content.slice(0, 200) });
    }

    // No tool calls → task is done.
    if (response.toolCalls.length === 0) {
      const result = response.content;
      await ctx.runMutation(internal.tasks.complete, { taskId, result });

      let embedding: number[] | undefined;
      try {
        embedding = await ctx.runAction(internal.llm.createEmbedding, { text: `task:${taskId}:result: ${result.slice(0, 500)}` });
      } catch {
        // embedding is best-effort, matching the old try/catch
      }
      await ctx.runMutation(internal.memories.upsert, {
        agentId, key: `task:${taskId}:result`, value: result.slice(0, 500), embedding, importance: 0.6,
      });

      await ctx.runMutation(internal.logs.append, { agentId, taskId, level: 'info', message: `Task completed: ${task.title}` });
      await ctx.runMutation(internal.agents.updateStatus, { agentId, status: 'idle' });
      await ctx.runMutation(internal.taskRuns.deleteByTask, { taskId }); // done — no need to keep the row around
      return;
    }

    // Execute tool calls.
    await ctx.runMutation(internal.agents.updateStatus, { agentId, status: 'acting' });
    const toolContext = buildToolContext(ctx, agentId, taskId);

    const pendingJoins: PendingJoin[] = [];
    const partialToolResults: LLMMessage[] = [];

    for (const tc of response.toolCalls) {
      await ctx.runMutation(internal.logs.append, {
        agentId, taskId, level: 'acting', message: `Calling tool: ${tc.name}(${JSON.stringify(tc.args).slice(0, 100)})`,
      });

      const def = TOOL_DEFS[tc.name];
      if (!def) {
        partialToolResults.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: JSON.stringify({ success: false, error: `Unknown tool: ${tc.name}` }) });
        continue;
      }

      if (def.requiresApproval && approvalRequired) {
        const approvalId = await ctx.runMutation(internal.approvals.request, {
          taskId, toolCallId: tc.id, agentId, toolName: tc.name, toolArgs: tc.args,
          reason: `Tool "${tc.name}" requires human approval`,
        });
        await ctx.scheduler.runAfter(APPROVAL_TIMEOUT_MS, internal.approvals.expireIfStillPending, { approvalId });
        pendingJoins.push({ toolCallId: tc.id, toolName: tc.name, args: tc.args, kind: 'approval', refId: approvalId });
        continue;
      }

      const outcome = await dispatchTool(ctx, tc.name, tc.args, toolContext, tc.id);
      if (outcome.kind === 'sync') {
        partialToolResults.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: JSON.stringify(outcome.result) });
      } else {
        pendingJoins.push({ toolCallId: tc.id, toolName: tc.name, args: tc.args, kind: 'externalJob', refId: outcome.jobId });
      }
    }

    if (pendingJoins.length === 0) {
      const newHistory = [...history, ...partialToolResults];
      await ctx.runMutation(internal.agents.updateStatus, { agentId, status: 'thinking' });
      await ctx.runMutation(internal.taskRuns.upsert, { taskId, agentId, iteration: iteration + 1, history: newHistory, status: 'running' });
      await ctx.scheduler.runAfter(0, internal.agentLoop.runIteration, { taskId, agentId });
    } else {
      const status = pendingJoins.some((j) => j.kind === 'approval') ? 'awaiting_approval' : 'awaiting_external_job';
      if (status === 'awaiting_approval') await ctx.runMutation(internal.tasks.awaitApproval, { taskId });
      await ctx.runMutation(internal.taskRuns.upsert, { taskId, agentId, iteration, history, status, pendingJoins, partialToolResults });
      // No further scheduling — resumeToolCall (below) continues once every
      // join clears, triggered by approvals.resolve/expireIfStillPending now,
      // and by the M5 CI/CD worker's reportJobResult later.
    }
  },
});

// ─── resumeToolCall: continue an iteration once one of its pending joins
// resolves (an approval decision, or later an external-job result) ─────────

export const resumeToolCall = internalAction({
  args: {
    taskId: v.id('tasks'),
    toolCallId: v.string(),
    kind: v.union(v.literal('approval'), v.literal('externalJob')),
    approved: v.optional(v.boolean()),
    externalResult: v.optional(v.any()),
    externalError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(internal.taskRuns.getByTask, { taskId: args.taskId });
    if (!run || !run.pendingJoins) return;

    const joinIdx = run.pendingJoins.findIndex((j: PendingJoin) => j.toolCallId === args.toolCallId && j.kind === args.kind);
    if (joinIdx === -1) return; // already resolved, or a stale/duplicate callback

    const join = run.pendingJoins[joinIdx] as PendingJoin;
    const remainingJoins: PendingJoin[] = [...(run.pendingJoins as PendingJoin[])];
    const partialToolResults: LLMMessage[] = [...((run.partialToolResults as LLMMessage[] | undefined) ?? [])];

    if (args.kind === 'approval') {
      if (!args.approved) {
        remainingJoins.splice(joinIdx, 1);
        partialToolResults.push({ role: 'tool', toolCallId: join.toolCallId, name: join.toolName, content: JSON.stringify({ success: false, error: 'Approval rejected' }) });
      } else {
        // Approved — actually run the tool now.
        const toolContext = buildToolContext(ctx, run.agentId, args.taskId);
        const outcome = await dispatchTool(ctx, join.toolName, join.args, toolContext, join.toolCallId);
        if (outcome.kind === 'sync') {
          remainingJoins.splice(joinIdx, 1);
          partialToolResults.push({ role: 'tool', toolCallId: join.toolCallId, name: join.toolName, content: JSON.stringify(outcome.result) });
        } else {
          // The now-approved tool itself needs the CI/CD worker — this join
          // isn't resolved yet, just transitions from waiting-on-approval to
          // waiting-on-external-job (same toolCallId, new refId).
          remainingJoins[joinIdx] = { ...join, kind: 'externalJob', refId: outcome.jobId };
        }
      }
    } else {
      // externalJob resolved (the M5 CI/CD worker calling back in via cicd.reportJobResult)
      remainingJoins.splice(joinIdx, 1);
      const content = args.externalError
        ? { success: false, error: args.externalError }
        : { success: true, result: args.externalResult };
      partialToolResults.push({ role: 'tool', toolCallId: join.toolCallId, name: join.toolName, content: JSON.stringify(content) });
    }

    if (remainingJoins.length === 0) {
      const newHistory = [...(run.history as LLMMessage[]), ...partialToolResults];
      await ctx.runMutation(internal.tasks.markInProgress, { taskId: args.taskId });
      await ctx.runMutation(internal.agents.updateStatus, { agentId: run.agentId, status: 'thinking' });
      await ctx.runMutation(internal.taskRuns.upsert, {
        taskId: args.taskId, agentId: run.agentId, iteration: run.iteration + 1, history: newHistory, status: 'running',
      });
      await ctx.scheduler.runAfter(0, internal.agentLoop.runIteration, { taskId: args.taskId, agentId: run.agentId });
    } else {
      const status = remainingJoins.some((j) => j.kind === 'approval') ? 'awaiting_approval' : 'awaiting_external_job';
      await ctx.runMutation(internal.taskRuns.upsert, {
        taskId: args.taskId, agentId: run.agentId, iteration: run.iteration, history: run.history,
        status, pendingJoins: remainingJoins, partialToolResults,
      });
    }
  },
});
