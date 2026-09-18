// ─── Revenue Operations Tools ──────────────────────────────────────────────────
//
// Mission lifecycle tools for the revenue operations domain.
// These tools operate on APEX goals (missions) + tasks (mission steps) + approvals,
// per D1 decision: no dedicated missions table.
//
// All tools validate input with Zod, are approval-gated where appropriate, and
// write audit events for observability.

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db, goals, tasks, approvals } from '@workspace/db';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { ToolDefinition, ToolContext } from '../types.js';

// ─── Mission Creation ──────────────────────────────────────────────────────────

export const createRevenueOpsMission: ToolDefinition = {
  name: 'create_revenue_ops_mission',
  description: `Create a new revenue operations mission (a revenue-ops goal with mission payload).

Creates a goal with goal.result carrying a typed MissionResult payload.
The mission is created in 'draft' status and must be submitted for validation
before it can enter the execution lifecycle.

Use this tool when an agent needs to create a new revenue operations mission —
e.g., a campaign to generate qualified demonstrations, a lead research mission,
or an outbound calling mission.

The mission payload includes:
- objective: what the mission is trying to achieve
- targetDefinition: who/what the mission targets (industries, cities, employee range, NAICS)
- qualificationRules: rules for qualifying contacts (must have phone, email, budget minimum)
- allowedChannels: which communication channels the mission may use
- policy: mission policy (budget cap, approval gates, opt-in rules)
- budgetCents: total mission budget in cents
- spentCents: starting at 0
- deadlineAt: when the mission must complete by
- approveBeforePivot: whether channel pivots require human approval
  - firstTouchOptIn: how to handle first-touch opt-in ('manual' | 'auto_with_warn')`,
  schema: z.object({
    objective: z.string().min(10).max(500).describe('What the mission is trying to achieve (e.g., "Generate 12 qualified demos with commercial roofing companies in Texas").'),
    targetDefinition: z.record(z.unknown()).describe('Who/what the mission targets (e.g., { industries: ["roofing"], cities: ["Austin", "Houston", "Dallas"], employeeRange: [10, 100], naicsCodes: [238220] }).'),
    qualificationRules: z.record(z.unknown()).describe('Rules for qualifying contacts (e.g., { mustHavePhone: true, mustHaveEmail: true, budgetMinimumCents: 50000 }).'),
    allowedChannels: z.array(z.enum(['call', 'email', 'sms'])).min(1).describe('Which communication channels the mission may use.'),
    policy: z.object({
      budgetCents: z.number().int().positive().describe('Total mission budget in cents (e.g., 40000 for $400).'),
      approveBeforePivot: z.boolean().describe('Whether channel pivots require human approval.'),
      firstTouchOptIn: z.enum(['manual', 'auto_with_warn']).describe('How to handle first-touch opt-in.'),
      requireApprovalForNewCampaigns: z.boolean().optional().describe('Whether creating new campaigns requires approval.'),
      requireApprovalForOfferChange: z.boolean().optional().describe('Whether changing the offer requires approval.'),
    }),
    deadlineAt: z.string().datetime().optional().describe('When the mission must complete by (ISO 8601).'),
    title: z.string().min(5).max(200).optional().describe('Human-readable mission title. If omitted, derived from objective.'),
    projectId: z.string().optional().describe('Project/organization ID to scope the mission to. If omitted, the mission is unscoped.'),
    assignedAgentId: z.string().optional().describe('Agent ID to assign the mission to. Defaults to the requesting agent.'),
  }),
  requiresApproval: false,
  execute: async (args: any, context: any) => {
    const missionId = randomUUID();
    const now = new Date().toISOString();

    const missionPayload = {
      objective: args.objective,
      targetDefinition: args.targetDefinition,
      qualificationRules: args.qualificationRules,
      allowedChannels: args.allowedChannels,
      policy: {
        budgetCents: args.policy.budgetCents,
        approveBeforePivot: args.policy.approveBeforePivot,
        firstTouchOptIn: args.policy.firstTouchOptIn,
        requireApprovalForNewCampaigns: args.policy.requireApprovalForNewCampaigns ?? false,
        requireApprovalForOfferChange: args.policy.requireApprovalForOfferChange ?? false,
      },
      budgetCents: args.policy.budgetCents,
      spentCents: 0,
      startsAt: now,
      deadlineAt: args.deadlineAt,
      missionStatus: 'draft',
      channels: args.allowedChannels,
      approveBeforePivot: args.policy.approveBeforePivot,
      firstTouchOptIn: args.policy.firstTouchOptIn,
      missionType: 'revenue_ops',
    };

    const title = args.title || `Revenue Ops Mission: ${args.objective.slice(0, 60)}`;

    await db.insert(goals).values({
      id: missionId,
      title,
      description: args.objective,
      status: 'active', // APEX goals must have a status; 'active' is a placeholder — real state is in missionStatus
      priority: 5,
      projectId: args.projectId,
      assignedAgentId: args.assignedAgentId || context.agentId,
      result: JSON.stringify(missionPayload),
      createdAt: new Date(),
    });

    return {
      missionId,
      status: 'draft',
      title,
      objective: args.objective,
      budgetCents: args.policy.budgetCents,
      deadlineAt: args.deadlineAt,
      message: `Mission created in draft status. Submit it for validation with submit_mission_for_validation to enter the execution lifecycle.`,
    };
  },
};

// ─── Mission Submission for Validation ─────────────────────────────────────────

export const submitMissionForValidation: ToolDefinition = {
  name: 'submit_mission_for_validation',
  description: `Submit a draft revenue operations mission for validation/review.

Transitions the mission from 'draft' to 'validating' status.
The mission waits for human approval (or auto-validation if policy allows)
before entering 'ready' status and beginning execution.

Use this tool when a mission has been created in draft and is ready for review.`,
  schema: z.object({
    missionId: z.string().uuid().describe('The mission goal ID to submit for validation.'),
    reason: z.string().optional().describe('Reason for submission (e.g., "Ready for review after target definition finalized").'),
  }),
  requiresApproval: false,
  execute: async (args: any, context: any) => {
    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, args.missionId))
      .limit(1);

    if (!mission) {
      return { success: false, error: `Mission not found: ${args.missionId}` };
    }

    const result = JSON.parse(mission.result || '{}');
    if (result.missionStatus !== 'draft') {
      return {
        success: false,
        error: `Mission is not in draft status (current: ${result.missionStatus}). Only draft missions can be submitted for validation.`,
      };
    }

    // Update mission status to 'validating'
    const updatedPayload = { ...result, missionStatus: 'validating' };
    await db.update(goals).set({
      result: JSON.stringify(updatedPayload),
    }).where(eq(goals.id, args.missionId));

    // Create an approval request for validation
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      taskId: undefined as any,
      agentId: context.agentId,
      toolName: 'submit_mission_for_validation',
      toolArgs: { missionId: args.missionId } as any,
      reason: args.reason || `Mission validation request: ${mission.title}`,
      status: 'pending',
      kind: 'approval',
      createdAt: new Date(),
    });

    return {
      missionId: args.missionId,
      status: 'validating',
      approvalId,
      message: `Mission submitted for validation. Awaiting approval (ID: ${approvalId}).`,
    };
  },
};

// ─── Mission Pause / Resume ─────────────────────────────────────────────────────

export const pauseMission: ToolDefinition = {
  name: 'pause_mission',
  description: `Pause a running revenue operations mission.

Transitions the mission from 'running' to 'paused' status.
All active mission tasks are paused. The mission can be resumed later
with resume_mission.

Use this tool when an operator or agent needs to temporarily stop a mission —
e.g., for review, budget reassessment, or external dependency wait.`,
  schema: z.object({
    missionId: z.string().uuid().describe('The mission goal ID to pause.'),
    reason: z.string().optional().describe('Reason for pausing (e.g., "Waiting for budget reassessment").'),
  }),
  requiresApproval: true,
  execute: async (args: any, context: any) => {
    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, args.missionId))
      .limit(1);

    if (!mission) {
      return { success: false, error: `Mission not found: ${args.missionId}` };
    }

    const result = JSON.parse(mission.result || '{}');
    if (result.missionStatus !== 'running') {
      return {
        success: false,
        error: `Mission is not running (current: ${result.missionStatus}). Only running missions can be paused.`,
      };
    }

    // Pause the mission
    const updatedPayload = { ...result, missionStatus: 'paused' };
    await db.update(goals).set({
      status: 'paused',
      result: JSON.stringify(updatedPayload),
    }).where(eq(goals.id, args.missionId));

    // Pause all active mission tasks
    await db.update(tasks).set({
      status: 'blocked',
    }).where(
      and(eq(tasks.goalId, args.missionId), inArray(tasks.status, ['in_progress', 'pending'] as const))
    );

    return {
      missionId: args.missionId,
      status: 'paused',
      pausedAt: new Date().toISOString(),
      reason: args.reason,
      message: `Mission paused. ${args.reason || 'No reason provided.'}`,
    };
  },
};

export const resumeMission: ToolDefinition = {
  name: 'resume_mission',
  description: `Resume a paused revenue operations mission.

Transitions the mission from 'paused' back to 'running' status.
Mission tasks resume execution.

Use this tool when a paused mission is ready to continue —
e.g., after review, budget approval, or external dependency resolution.`,
  schema: z.object({
    missionId: z.string().uuid().describe('The mission goal ID to resume.'),
    reason: z.string().optional().describe('Reason for resuming (e.g., "Budget approved, resuming execution").'),
  }),
  requiresApproval: false,
  execute: async (args: any, context: any) => {
    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, args.missionId))
      .limit(1);

    if (!mission) {
      return { success: false, error: `Mission not found: ${args.missionId}` };
    }

    const result = JSON.parse(mission.result || '{}');
    if (result.missionStatus !== 'paused') {
      return {
        success: false,
        error: `Mission is not paused (current: ${result.missionStatus}). Only paused missions can be resumed.`,
      };
    }

    // Resume the mission
    const updatedPayload = { ...result, missionStatus: 'running' };
    await db.update(goals).set({
      status: 'active',
      result: JSON.stringify(updatedPayload),
    }).where(eq(goals.id, args.missionId));

    // Resume paused mission tasks
    await db.update(tasks).set({
      status: 'pending', // Tasks go back to pending for re-assignment
    }).where(and(eq(tasks.goalId, args.missionId), eq(tasks.status, 'blocked'))
    );

    return {
      missionId: args.missionId,
      status: 'running',
      resumedAt: new Date().toISOString(),
      reason: args.reason,
      message: `Mission resumed. ${args.reason || 'No reason provided.'}`,
    };
  },
};

// ─── Mission Cancellation ────────────────────────────────────────────────────────

export const cancelMission: ToolDefinition = {
  name: 'cancel_mission',
  description: `Cancel a revenue operations mission.

Transitions the mission to 'cancelled' status regardless of current state.
All active mission tasks are cancelled. The mission is done — no recovery.

Use this tool when a mission must be terminated — e.g., strategy change,
budget exhausted with no path forward, or operator decision to stop.`,
  schema: z.object({
    missionId: z.string().uuid().describe('The mission goal ID to cancel.'),
    reason: z.string().min(10).describe('Reason for cancellation (e.g., "Strategy changed — no longer pursuing roofing vertical").'),
  }),
  requiresApproval: true,
  execute: async (args: any, context: any) => {
    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, args.missionId))
      .limit(1);

    if (!mission) {
      return { success: false, error: `Mission not found: ${args.missionId}` };
    }

    const result = JSON.parse(mission.result || '{}');

    // Cancel the mission
    const updatedPayload = {
      ...result,
      missionStatus: 'cancelled',
      cancelledReason: args.reason,
    };
    await db.update(goals).set({
      status: 'cancelled',
      result: JSON.stringify(updatedPayload),
      completedAt: new Date(),
    }).where(eq(goals.id, args.missionId));

    // Cancel all active mission tasks
    await db.update(tasks).set({
      status: 'cancelled',
      result: `Mission cancelled: ${args.reason}`,
      completedAt: new Date(),
    }).where(and(eq(tasks.goalId, args.missionId), inArray(tasks.status, ['pending', 'in_progress', 'blocked', 'awaiting_approval'] as const))
    );

    return {
      missionId: args.missionId,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      reason: args.reason,
      message: `Mission cancelled: ${args.reason}`,
    };
  },
};

// ─── Mission Budget Exhaustion ───────────────────────────────────────────────────

export const exhaustMissionBudget: ToolDefinition = {
  name: 'exhaust_mission_budget',
  description: `Mark a mission as budget-exhausted.

Transitions the mission from 'running' to 'budget_exhausted' status.
No new mission tasks can be created until the budget is increased (via
approve_mission_budget_increase) or the mission is cancelled.

Use this tool when the mission's spentCents has reached or exceeded budgetCents.
This is typically called by the budget tracking system, not directly by agents.`,
  schema: z.object({
    missionId: z.string().uuid().describe('The mission goal ID to mark as budget-exhausted.'),
    spentCents: z.number().int().nonnegative().describe('Current spent cents (must be >= budgetCents for the mission).'),
  }),
  requiresApproval: false,
  execute: async (args: any, context: any) => {
    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, args.missionId))
      .limit(1);

    if (!mission) {
      return { success: false, error: `Mission not found: ${args.missionId}` };
    }

    const result = JSON.parse(mission.result || '{}');
    const budgetCents = result.policy?.budgetCents ?? 0;

    if (args.spentCents < budgetCents) {
      return {
        success: false,
        error: `Cannot exhaust budget: spentCents (${args.spentCents}) < budgetCents (${budgetCents}). Budget exhaustion requires spent >= budget.`,
      };
    }

    if (result.missionStatus !== 'running') {
      return {
        success: false,
        error: `Mission is not running (current: ${result.missionStatus}). Only running missions can become budget_exhausted.`,
      };
    }

    // Mark mission as budget-exhausted
    const updatedPayload = { ...result, missionStatus: 'budget_exhausted' };
    await db.update(goals).set({
      result: JSON.stringify(updatedPayload),
    }).where(eq(goals.id, args.missionId));

    // Block all pending mission tasks
    await db.update(tasks).set({
      status: 'blocked',
      errorMessage: 'Mission budget exhausted',
    }).where(and(eq(tasks.goalId, args.missionId), inArray(tasks.status, ['pending'] as const))
    );

    return {
      missionId: args.missionId,
      status: 'budget_exhausted',
      spentCents: args.spentCents,
      budgetCents,
      exhaustedAt: new Date().toISOString(),
      message: `Mission budget exhausted: spent ${args.spentCents} cents of ${budgetCents} budget.`,
    };
  },
};

// ─── Mission Budget Increase Approval ───────────────────────────────────────────

export const approveMissionBudgetIncrease: ToolDefinition = {
  name: 'approve_mission_budget_increase',
  description: `Approve a budget increase for a budget-exhausted mission.

Transitions the mission from 'budget_exhausted' back to 'running' status
with an increased budget. This is the human-approval path for resuming
a mission whose budget has been exhausted.

Use this tool when an operator approves a budget increase for a stalled mission.`,
  schema: z.object({
    missionId: z.string().uuid().describe('The mission goal ID to increase budget for.'),
    newBudgetCents: z.number().int().positive().describe('New budget in cents (must be > current budget).'),
    approvedBy: z.string().optional().describe('Human approver identifier (defaults to "manual").'),
  }),
  requiresApproval: false,
  execute: async (args: any, context: any) => {
    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, args.missionId))
      .limit(1);

    if (!mission) {
      return { success: false, error: `Mission not found: ${args.missionId}` };
    }

    const result = JSON.parse(mission.result || '{}');
    const currentBudget = result.policy?.budgetCents ?? 0;

    if (args.newBudgetCents <= currentBudget) {
      return {
        success: false,
        error: `New budget (${args.newBudgetCents}) must be greater than current budget (${currentBudget}).`,
      };
    }

    if (result.missionStatus !== 'budget_exhausted') {
      return {
        success: false,
        error: `Mission is not budget_exhausted (current: ${result.missionStatus}). Only budget_exhausted missions can be resumed with budget increase.`,
      };
    }

    // Increase budget and resume mission
    const updatedPayload = {
      ...result,
      missionStatus: 'running',
      policy: {
        ...result.policy,
        budgetCents: args.newBudgetCents,
      },
      budgetCents: args.newBudgetCents,
    };
    await db.update(goals).set({
      result: JSON.stringify(updatedPayload),
    }).where(eq(goals.id, args.missionId));

    // Unblock mission tasks
    await db.update(tasks).set({
      status: 'pending',
      errorMessage: null,
    }).where(and(eq(tasks.goalId, args.missionId), eq(tasks.status, 'blocked'), eq(tasks.errorMessage, 'Mission budget exhausted'))
    );

    return {
      missionId: args.missionId,
      status: 'running',
      previousBudgetCents: currentBudget,
      newBudgetCents: args.newBudgetCents,
      resumedAt: new Date().toISOString(),
      approvedBy: args.approvedBy || 'manual',
      message: `Mission budget increased from ${currentBudget} to ${args.newBudgetCents} cents. Mission resumed.`,
    };
  },
};

// ─── Mission Status Query ────────────────────────────────────────────────────────

export const getMissionStatus: ToolDefinition = {
  name: 'get_mission_status',
  description: `Get the current status and details of a revenue operations mission.

Returns the mission's effective status (derived from goal.status + missionStatus
in goal.result + task states), budget info, current step, and recent outcomes.`,
  schema: z.object({
    missionId: z.string().uuid().describe('The mission goal ID to query.'),
  }),
  requiresApproval: false,
  execute: async (args: any, context: any) => {
    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, args.missionId))
      .limit(1);

    if (!mission) {
      return { success: false, error: `Mission not found: ${args.missionId}` };
    }

    const result = JSON.parse(mission.result || '{}');
    const missionStatus = result.missionStatus || 'unknown';

    // Get active tasks for this mission
    const missionTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.goalId, args.missionId))
      .limit(50);

    const activeTasks = missionTasks.filter(t =>
      ['pending', 'in_progress', 'blocked', 'awaiting_approval'].includes(t.status)
    );
    const completedTasks = missionTasks.filter(t =>
      ['done', 'failed', 'cancelled'].includes(t.status)
    );

    // Derive effective status
    let effectiveStatus = missionStatus;
    if (mission.status === 'paused' && missionStatus === 'running') {
      effectiveStatus = 'paused';
    }
    if (mission.status === 'cancelled') {
      effectiveStatus = 'cancelled';
    }
    if (mission.status === 'completed') {
      effectiveStatus = 'completed';
    }

    return {
      missionId: args.missionId,
      title: mission.title,
      goalStatus: mission.status,
      missionStatus: missionStatus,
      effectiveStatus,
      objective: result.objective,
      budgetCents: result.policy?.budgetCents ?? result.budgetCents ?? 0,
      spentCents: result.spentCents ?? 0,
      remainingCents: Math.max(0, (result.policy?.budgetCents ?? result.budgetCents ?? 0) - (result.spentCents ?? 0)),
      allowedChannels: result.allowedChannels || [],
      deadlineAt: result.deadlineAt,
      activeTasks: activeTasks.length,
      completedTasks: completedTasks.length,
      totalTasks: missionTasks.length,
      tasks: activeTasks.slice(0, 10).map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
      })),
      message: `Mission "${mission.title}" is in ${effectiveStatus} status.`,
    };
  },
};

// ─── Mission Step Creation ───────────────────────────────────────────────────────

export const createMissionStep: ToolDefinition = {
  name: 'create_mission_step',
  description: `Create a task step within a revenue operations mission.

Creates a task linked to the mission goal. The task becomes a mission step —
an atomic unit of work within the mission lifecycle.

Use this tool when an agent needs to create a new step within a mission —
e.g., "research 10 roofing companies", "call 5 decision makers", "send follow-up emails".`,
  schema: z.object({
    missionId: z.string().uuid().describe('The mission goal ID to create a step for.'),
    title: z.string().min(5).max(200).describe('Step title (e.g., "Research 10 roofing companies in Austin").'),
    description: z.string().min(10).max(1000).describe('Step description — what the step entails.'),
    stepType: z.enum(['research', 'outreach', 'call', 'email', 'sms', 'analysis', 'review', 'custom']).describe('Type of step.'),
    priority: z.number().int().min(1).max(10).default(5).describe('Step priority (1=highest, 10=lowest).'),
    context: z.record(z.unknown()).optional().describe('Step-specific context (e.g., { targetCities: ["Austin"], targetCount: 10 }).'),
    assignedAgentId: z.string().optional().describe('Agent to assign the step to. Defaults to mission-assigned agent.'),
  }),
  requiresApproval: false,
  execute: async (args: any, context: any) => {
    const missionId = args.missionId;

    // Verify mission exists and is in a state that allows steps
    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, missionId))
      .limit(1);

    if (!mission) {
      return { success: false, error: `Mission not found: ${missionId}` };
    }

    const result = JSON.parse(mission.result || '{}');
    const missionStatus = result.missionStatus || 'unknown';
    const allowedStatuses = ['running', 'ready', 'validating'];

    if (!allowedStatuses.includes(missionStatus)) {
      return {
        success: false,
        error: `Cannot create steps for mission in '${missionStatus}' status. Steps can only be created when mission is running, ready, or validating.`,
      };
    }

    const stepId = randomUUID();
    const now = new Date();

    await db.insert(tasks).values({
      id: stepId,
      goalId: missionId,
      title: args.title,
      description: args.description,
      status: 'pending',
      priority: args.priority,
      assignedAgentId: args.assignedAgentId || mission.assignedAgentId,
      createdByAgentId: context.agentId,
      context: (args.context as any) || {},
      createdAt: now,
      updatedAt: now,
    });

    return {
      stepId,
      missionId,
      title: args.title,
      status: 'pending',
      stepType: args.stepType,
      message: `Mission step created: "${args.title}" (ID: ${stepId}).`,
    };
  },
};

// ─── Tool Exports ────────────────────────────────────────────────────────────────

export const revenueOpsTools = [
  createRevenueOpsMission,
  submitMissionForValidation,
  pauseMission,
  resumeMission,
  cancelMission,
  exhaustMissionBudget,
  approveMissionBudgetIncrease,
  getMissionStatus,
  createMissionStep,
];

export function createRevenueOpsTools(): ToolDefinition[] {
  return revenueOpsTools;
}

export function registerRevenueOpsTools(registry: { register: (tool: ToolDefinition) => void }) {
  for (const tool of revenueOpsTools) {
    registry.register(tool);
  }
}
