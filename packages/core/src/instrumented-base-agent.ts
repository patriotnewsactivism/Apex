import { randomUUID } from 'crypto';
import { db, approvals, tasks as tasksTable } from '@workspace/db';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { BaseAgent as CoreBaseAgent, emitApexEvent } from './base-agent.js';
import { getToolRegistry } from './tool-registry.js';
import {
  APPROVAL_RECOVERY_STALE_MS,
  APPROVAL_WAIT_MAX_MS,
  approvalPayloadsEqual,
  consumedApprovalStatus,
  isApprovalDecision,
  type ApprovalDecision,
} from './approval-continuation.js';
import {
  estimatePreRunComplexity,
  getCurrentLLMExecutionContext,
  withLLMExecutionContext,
} from './model-execution-context.js';
import type { AgentConfig, TaskInput, TaskResult, ToolContext } from './types.js';

const APPROVAL_RECOVERY_SWEEP_MS = 60_000;
const APPROVAL_RECOVERY_BATCH = 200;
let approvalRecoveryLoopStarted = false;

/**
 * Recover only approval waits that are older than the maximum live in-process
 * waiter. This is what makes recovery safe across multiple Cloud Run workers:
 * a newly started worker never races a still-live five-minute approval poll in
 * another process. Resolved rows are not replayed here; the task is merely put
 * back on the durable queue, and the exact decision is consumed by the claiming
 * execution before any side effect can happen.
 */
async function recoverResolvedApprovalWaits(): Promise<number> {
  const cutoff = new Date(Date.now() - APPROVAL_RECOVERY_STALE_MS);
  const candidates = await db
    .select({ taskId: tasksTable.id })
    .from(tasksTable)
    .innerJoin(
      approvals,
      and(
        eq(approvals.taskId, tasksTable.id),
        eq(approvals.kind, 'approval'),
        inArray(approvals.status, ['approved', 'rejected']),
      ),
    )
    .where(and(
      eq(tasksTable.status, 'awaiting_approval'),
      lt(tasksTable.updatedAt, cutoff),
    ))
    .limit(APPROVAL_RECOVERY_BATCH);

  const taskIds = [...new Set(candidates.map((row) => row.taskId))];
  let recovered = 0;
  for (const taskId of taskIds) {
    const rows = await db
      .update(tasksTable)
      .set({ status: 'pending', leasedAt: null, updatedAt: new Date() })
      .where(and(
        eq(tasksTable.id, taskId),
        eq(tasksTable.status, 'awaiting_approval'),
        lt(tasksTable.updatedAt, cutoff),
      ))
      .returning({ id: tasksTable.id });
    recovered += rows.length;
  }
  return recovered;
}

function ensureApprovalRecoveryLoop(): void {
  if (approvalRecoveryLoopStarted) return;
  approvalRecoveryLoopStarted = true;

  const sweep = async () => {
    try {
      const recovered = await recoverResolvedApprovalWaits();
      if (recovered > 0) {
        console.log(`[approvals] Re-queued ${recovered} resolved stale approval wait(s) for durable continuation.`);
      }
    } catch (err) {
      console.warn('[approvals] Durable approval recovery sweep failed:', err instanceof Error ? err.message : err);
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), APPROVAL_RECOVERY_SWEEP_MS);
  timer.unref?.();
}

/**
 * Production wrapper around the governed BaseAgent. Besides task-local LLM
 * attribution, it owns durable approval continuation semantics so a process
 * restart cannot lose a human decision or silently replay an approved side
 * effect.
 */
export class BaseAgent extends CoreBaseAgent {
  constructor(config: AgentConfig) {
    super(config);

    // BaseAgent's governed execution loop owns the LLM calls. Wrap the client
    // once so those existing calls inherit the task-local AsyncLocalStorage
    // context without rewriting the mature task loop or using mutable globals.
    const complete = this.llm.complete.bind(this.llm);
    this.llm.complete = (messages, tools, execution) =>
      complete(messages, tools, execution ?? getCurrentLLMExecutionContext());

    ensureApprovalRecoveryLoop();
  }

  private normalizedApprovalArgs(toolName: string, args: unknown): Record<string, unknown> {
    if (!this.config.tools.includes(toolName)) {
      throw new Error(`Approval refused: tool ${toolName} is not allowed for agent ${this.id}`);
    }
    const tool = getToolRegistry(process.env.WORKSPACE_ROOT ?? process.cwd()).get(toolName);
    if (!tool || !tool.requiresApproval) {
      throw new Error(`Approval refused: ${toolName} is not a registered approval-gated tool`);
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      throw new Error(`Approval refused: invalid normalized args for ${toolName}: ${parsed.error.message}`);
    }
    if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      throw new Error(`Approval refused: ${toolName} did not normalize to an object payload`);
    }
    return parsed.data as Record<string, unknown>;
  }

  private async consumeDecision(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    const [consumed] = await db
      .update(approvals)
      .set({ status: consumedApprovalStatus(decision) })
      .where(and(
        eq(approvals.id, approvalId),
        eq(approvals.kind, 'approval'),
        eq(approvals.status, decision),
      ))
      .returning({ id: approvals.id });
    return Boolean(consumed);
  }

  private async resolvedDecisionForExactPayload(
    taskId: string,
    toolName: string,
    normalizedArgs: Record<string, unknown>,
  ): Promise<{ id: string; status: ApprovalDecision } | null> {
    const rows = await db
      .select()
      .from(approvals)
      .where(and(
        eq(approvals.taskId, taskId),
        eq(approvals.agentId, this.id),
        eq(approvals.toolName, toolName),
        eq(approvals.kind, 'approval'),
        inArray(approvals.status, ['approved', 'rejected']),
      ))
      .orderBy(desc(approvals.reviewedAt), desc(approvals.createdAt))
      .limit(20);

    for (const row of rows) {
      if (!isApprovalDecision(row.status)) continue;
      if (!approvalPayloadsEqual(row.toolArgs, normalizedArgs)) continue;
      return { id: row.id, status: row.status };
    }
    return null;
  }

  private async pendingApprovalForExactPayload(
    taskId: string,
    toolName: string,
    normalizedArgs: Record<string, unknown>,
  ): Promise<string | null> {
    const rows = await db
      .select({ id: approvals.id, toolArgs: approvals.toolArgs })
      .from(approvals)
      .where(and(
        eq(approvals.taskId, taskId),
        eq(approvals.agentId, this.id),
        eq(approvals.toolName, toolName),
        eq(approvals.kind, 'approval'),
        eq(approvals.status, 'pending'),
      ))
      .orderBy(desc(approvals.createdAt))
      .limit(20);
    return rows.find((row) => approvalPayloadsEqual(row.toolArgs, normalizedArgs))?.id ?? null;
  }

  private async buildRecoveredToolContext(taskId: string): Promise<ToolContext> {
    const [task] = await db
      .select({ goalId: tasksTable.goalId })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    const goalId = task?.goalId ?? undefined;

    return {
      agentId: this.id,
      taskId,
      goalId,
      workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd(),
      requestApproval: (toolName, args, reason) =>
        this.requestHumanApproval(taskId, toolName, args, reason),
      delegateToRole: (targetRole, input) => this.delegateToRole(targetRole, {
        title: input.title,
        description: input.description,
        parentTaskId: input.parentTaskId ?? taskId,
        goalId,
        context: input.context,
      }),
      delegateToAgent: (targetAgentId, input) => this.delegate(targetAgentId, {
        title: input.title,
        description: input.description,
        parentTaskId: input.parentTaskId ?? taskId,
        goalId: input.goalId ?? goalId,
        context: input.context,
      }),
    };
  }

  /**
   * Execute a decision that survived a worker/process restart. The approval is
   * consumed with compare-and-set BEFORE a side effect, making it one-shot. If
   * the process crashes after that point, automatic recovery cannot replay the
   * action; a fresh human approval is required.
   */
  private async consumeRecoveredContinuation(taskId: string): Promise<string | null> {
    const rows = await db
      .select()
      .from(approvals)
      .where(and(
        eq(approvals.taskId, taskId),
        eq(approvals.agentId, this.id),
        eq(approvals.kind, 'approval'),
        inArray(approvals.status, ['approved', 'rejected']),
      ))
      .orderBy(desc(approvals.reviewedAt), desc(approvals.createdAt))
      .limit(20);

    const row = rows.find((candidate) => isApprovalDecision(candidate.status));
    if (!row || !isApprovalDecision(row.status)) return null;

    const registry = getToolRegistry(process.env.WORKSPACE_ROOT ?? process.cwd());
    const tool = registry.get(row.toolName);
    if (!tool || !tool.requiresApproval || !this.config.tools.includes(row.toolName)) {
      await db.update(approvals).set({
        status: 'stale',
        reviewerNote: 'Not executed after recovery: tool is no longer an allowed approval-gated tool for this agent.',
      }).where(and(eq(approvals.id, row.id), eq(approvals.status, row.status)));
      return `A previously resolved approval for ${row.toolName} could not be resumed because the tool policy changed. Treat it as stale and request fresh approval if the action is still necessary.`;
    }

    const parsed = tool.schema.safeParse(row.toolArgs);
    if (!parsed.success || !approvalPayloadsEqual(parsed.success ? parsed.data : null, row.toolArgs)) {
      await db.update(approvals).set({
        status: 'stale',
        reviewerNote: 'Not executed after recovery: approved payload is not the current normalized tool payload.',
      }).where(and(eq(approvals.id, row.id), eq(approvals.status, row.status)));
      return `A previously resolved approval for ${row.toolName} no longer matches the tool's normalized schema. It was not executed; fresh approval is required.`;
    }

    const consumed = await this.consumeDecision(row.id, row.status);
    if (!consumed) return null;

    if (row.status === 'rejected') {
      await this.logger.info(`Recovered human rejection consumed for ${row.toolName}; continuing with alternatives.`, taskId);
      return `Human rejected the exact gated action ${row.toolName} with args ${JSON.stringify(row.toolArgs)}. Do not repeat that exact action automatically. Continue the task using a safe alternative or request a materially different approval if needed.`;
    }

    const toolContext = await this.buildRecoveredToolContext(taskId);
    await this.logger.acting(`Executing recovered one-shot approval: ${row.toolName}`, taskId);
    try {
      const output = await tool.execute(parsed.data, toolContext);
      const serialized = JSON.stringify(output);
      return `Human previously approved exactly one ${row.toolName} action with normalized args ${JSON.stringify(row.toolArgs)}. APEX consumed that approval before execution and has now executed it once. Verified tool result: ${serialized.slice(0, 8000)}. Continue from this result. Do not repeat the same gated action unless a new approval is obtained.`;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `Human previously approved exactly one ${row.toolName} action with normalized args ${JSON.stringify(row.toolArgs)}. APEX consumed the one-shot approval before execution, but the tool failed: ${detail}. Do not replay it automatically; diagnose the failure and request fresh approval before any retry that could have side effects.`;
    }
  }

  /**
   * Override only the persistence/wait semantics. Core ToolRegistry still owns
   * the approval gate; this method independently re-parses through that tool's
   * Zod schema so the row binds to the exact normalized payload Core will
   * execute, never the raw LLM argument object.
   */
  override async requestHumanApproval(
    taskId: string,
    toolName: string,
    args: unknown,
    reason: string,
  ): Promise<boolean> {
    const normalizedArgs = this.normalizedApprovalArgs(toolName, args);

    // Restart path: a stale waiter may have been re-queued before the reasoning
    // loop reaches the same call. Only an exact normalized-payload match can
    // consume that prior decision; different args always require new approval.
    const resolved = await this.resolvedDecisionForExactPayload(taskId, toolName, normalizedArgs);
    if (resolved) {
      const consumed = await this.consumeDecision(resolved.id, resolved.status);
      if (consumed) {
        await this.taskQueue.markInProgress(taskId);
        return resolved.status === 'approved';
      }
    }

    let approvalId = await this.pendingApprovalForExactPayload(taskId, toolName, normalizedArgs);
    if (!approvalId) {
      approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        taskId,
        agentId: this.id,
        toolName,
        toolArgs: normalizedArgs,
        reason,
        status: 'pending',
        kind: 'approval',
        createdAt: new Date(),
      });
    }

    await this.taskQueue.awaitApproval(taskId);
    emitApexEvent({ type: 'approval:requested', approvalId, agentId: this.id, toolName, reason });

    const deadline = Date.now() + APPROVAL_WAIT_MAX_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const [row] = await db
        .select({ status: approvals.status, toolArgs: approvals.toolArgs })
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .limit(1);
      if (!row || !isApprovalDecision(row.status)) continue;
      if (!approvalPayloadsEqual(row.toolArgs, normalizedArgs)) {
        throw new Error(`Approval payload integrity failure for ${approvalId}; normalized args changed while waiting`);
      }
      const consumed = await this.consumeDecision(approvalId, row.status);
      if (!consumed) continue;
      await this.taskQueue.markInProgress(taskId);
      return row.status === 'approved';
    }

    // Preserve the historical five-minute live-wait behavior, but consume the
    // timeout as a one-shot rejection so it can never be re-used after restart.
    const [timedOut] = await db
      .update(approvals)
      .set({
        status: 'consumed_rejected',
        reviewedAt: new Date(),
        reviewerNote: `Auto-rejected after ${APPROVAL_WAIT_MAX_MS / 60_000} minutes with no human decision.`,
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')))
      .returning({ id: approvals.id });

    if (!timedOut) {
      // Decision may have landed exactly at the timeout boundary. Consume it if
      // possible rather than incorrectly treating a real approval as timeout.
      const [finalRow] = await db
        .select({ status: approvals.status, toolArgs: approvals.toolArgs })
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .limit(1);
      if (finalRow && isApprovalDecision(finalRow.status) && approvalPayloadsEqual(finalRow.toolArgs, normalizedArgs)) {
        const consumed = await this.consumeDecision(approvalId, finalRow.status);
        if (consumed) {
          await this.taskQueue.markInProgress(taskId);
          return finalRow.status === 'approved';
        }
      }
      throw new Error(`Approval ${approvalId} changed state at timeout and could not be consumed safely`);
    }

    await this.taskQueue.markInProgress(taskId);
    return false;
  }

  protected override async executeTask(
    taskId: string,
    title: string,
    description: string,
    context: Record<string, unknown>,
  ): Promise<TaskResult> {
    return withLLMExecutionContext(
      {
        taskId,
        agentId: this.id,
        role: this.role,
        complexityHint: estimatePreRunComplexity(`${title}\n${description}`, context),
      },
      async () => {
        const continuation = await this.consumeRecoveredContinuation(taskId);
        const resumedDescription = continuation
          ? `${description}\n\n## Durable approval continuation\n${continuation}`
          : description;
        return super.executeTask(taskId, title, resumedDescription, context);
      },
    );
  }
}
