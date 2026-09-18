// ─── Revenue Operations API Routes ─────────────────────────────────────────────
//
// Mission management API endpoints for the revenue operations domain.
// These endpoints operate on APEX goals (missions) + tasks (mission steps) + approvals,
// per D1 decision: no dedicated missions table.
//
// All endpoints are admin-authenticated (requireAdminAuth middleware applied in index.ts).
// Mission-specific endpoints use the standard APEX auth — no separate auth system.

import { Router } from 'express';
import { db, goals, tasks, approvals } from '@workspace/db';
import { eq, and, desc, sql, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

const router = Router();

// ─── Validation Schemas ──────────────────────────────────────────────────────────

const CreateMissionSchema = z.object({
  objective: z.string().min(10).max(500),
  targetDefinition: z.record(z.unknown()),
  qualificationRules: z.record(z.unknown()),
  allowedChannels: z.array(z.enum(['call', 'email', 'sms'])).min(1),
  policy: z.object({
    budgetCents: z.number().int().positive(),
    approveBeforePivot: z.boolean(),
    firstTouchOptIn: z.enum(['manual', 'auto_with_warn']),
    requireApprovalForNewCampaigns: z.boolean().optional(),
    requireApprovalForOfferChange: z.boolean().optional(),
  }),
  deadlineAt: z.string().datetime().optional(),
  title: z.string().min(5).max(200).optional(),
  projectId: z.string().optional(),
  assignedAgentId: z.string().optional(),
});

const MissionActionSchema = z.object({
  missionId: z.string().uuid(),
  reason: z.string().optional(),
});

const PauseMissionSchema = z.object({
  missionId: z.string().uuid(),
  reason: z.string().optional(),
});

const ResumeMissionSchema = z.object({
  missionId: z.string().uuid(),
  reason: z.string().optional(),
});

const CancelMissionSchema = z.object({
  missionId: z.string().uuid(),
  reason: z.string().min(10),
});

const BudgetExhaustionSchema = z.object({
  missionId: z.string().uuid(),
  spentCents: z.number().int().nonnegative(),
});

const BudgetIncreaseSchema = z.object({
  missionId: z.string().uuid(),
  newBudgetCents: z.number().int().positive(),
  approvedBy: z.string().optional(),
});

// ─── Helper: derive effective mission status ─────────────────────────────────────

function deriveEffectiveStatus(goalStatus: string, missionStatus: string): string {
  if (goalStatus === 'cancelled') return 'cancelled';
  if (goalStatus === 'completed') return 'completed';
  if (goalStatus === 'paused') return 'paused';
  return missionStatus || 'unknown';
}

// ─── Helper: parse mission payload ───────────────────────────────────────────────

function parseMissionPayload(result: string | null): {
  missionStatus: string;
  objective: string;
  targetDefinition: Record<string, unknown>;
  qualificationRules: Record<string, unknown>;
  allowedChannels: string[];
  policy: Record<string, unknown>;
  budgetCents: number;
  spentCents: number;
  deadlineAt?: string;
  startedAt?: string;
  channels: string[];
  approveBeforePivot: boolean;
  firstTouchOptIn: string;
  missionType: string;
} {
  const parsed = result ? JSON.parse(result) : {};
  return {
    missionStatus: parsed.missionStatus || 'unknown',
    objective: parsed.objective || '',
    targetDefinition: parsed.targetDefinition || {},
    qualificationRules: parsed.qualificationRules || {},
    allowedChannels: parsed.allowedChannels || [],
    policy: parsed.policy || {},
    budgetCents: parsed.policy?.budgetCents ?? parsed.budgetCents ?? 0,
    spentCents: parsed.spentCents ?? 0,
    deadlineAt: parsed.deadlineAt,
    startedAt: parsed.startsAt,
    channels: parsed.channels || [],
    approveBeforePivot: parsed.approveBeforePivot ?? false,
    firstTouchOptIn: parsed.firstTouchOptIn || 'manual',
    missionType: parsed.missionType || '',
  };
}

// ─── Helper: mission query filter ─────────────────────────────────────────────────

function missionFilter() {
  // Filter to revenue-ops missions (goals with missionType = 'revenue_ops' in result)
  return sql`${goals.result}::text LIKE '%missionType":"revenue_ops"%'`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────────

/**
 * POST /api/missions
 * Create a new revenue operations mission.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = CreateMissionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: parsed.error.flatten(),
      });
    }

    const args = parsed.data;
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
      status: 'active',
      priority: 5,
      projectId: args.projectId,
      assignedAgentId: args.assignedAgentId,
      result: JSON.stringify(missionPayload),
      createdAt: new Date(),
    });

    return res.status(201).json({
      missionId,
      status: 'draft',
      title,
      objective: args.objective,
      budgetCents: args.policy.budgetCents,
      deadlineAt: args.deadlineAt,
      message: 'Mission created in draft status.',
    });
  } catch (err) {
    console.error('POST /api/missions error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/missions
 * List missions with optional filters.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, projectId, limit = '50', offset = '0' } = req.query;

    const limitNum = Math.min(Math.max(1, parseInt(limit as string) || 50), 200);
    const offsetNum = Math.max(0, parseInt(offset as string) || 0);

    // Build query conditions
    const conditions = [];

    // Filter to revenue-ops missions (goals with missionStatus in result)
    conditions.push(missionFilter());

    if (status && typeof status === 'string') {
      // Map API status to goal.status or missionStatus
      if (['draft', 'validating', 'ready', 'running', 'waiting_approval', 'paused', 'blocked', 'budget_exhausted', 'completed', 'cancelled', 'failed'].includes(status)) {
        // Search by missionStatus in result
        conditions.push(sql`${goals.result}::text LIKE '%missionStatus":"${status}"%'`);
      }
    }

    if (projectId && typeof projectId === 'string') {
      conditions.push(eq(goals.projectId, projectId));
    }

    const whereClause = conditions.length > 1
      ? and(...conditions)
      : conditions[0];

    const missions = await db
      .select()
      .from(goals)
      .where(whereClause)
      .orderBy(desc(goals.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(goals)
      .where(whereClause);

    const total = totalResult[0]?.count ?? 0;

    const enriched = missions.map(m => {
      const payload = parseMissionPayload(m.result);
      return {
        missionId: m.id,
        title: m.title,
        description: m.description,
        goalStatus: m.status,
        missionStatus: payload.missionStatus,
        effectiveStatus: deriveEffectiveStatus(m.status, payload.missionStatus),
        objective: payload.objective,
        budgetCents: payload.budgetCents,
        spentCents: payload.spentCents,
        remainingCents: Math.max(0, payload.budgetCents - payload.spentCents),
        allowedChannels: payload.allowedChannels,
        deadlineAt: payload.deadlineAt,
        projectId: m.projectId,
        assignedAgentId: m.assignedAgentId,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        completedAt: m.completedAt,
      };
    });

    return res.json({
      missions: enriched,
      total,
      limit: limitNum,
      offset: offsetNum,
    });
  } catch (err) {
    console.error('GET /api/missions error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/missions/:missionId
 * Get a single mission with full details.
 */
router.get('/:missionId', async (req: Request, res: Response) => {
  try {
    const { missionId } = req.params;

    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, missionId))
      .limit(1);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const payload = parseMissionPayload(mission.result);

    // Get active tasks
    const missionTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.goalId, missionId))
      .orderBy(desc(tasks.createdAt));

    const activeTasks = missionTasks.filter(t =>
      ['pending', 'in_progress', 'blocked', 'awaiting_approval'].includes(t.status)
    );
    const completedTasks = missionTasks.filter(t =>
      ['done', 'failed', 'cancelled'].includes(t.status)
    );

    // Get pending approvals for this mission
    const missionApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.kind, 'approval'),
          sql`${approvals.tool_args}::text LIKE '%${missionId}%'`
        )
      )
      .orderBy(desc(approvals.createdAt));

    return res.json({
      missionId: mission.id,
      title: mission.title,
      description: mission.description,
      goalStatus: mission.status,
      missionStatus: payload.missionStatus,
      effectiveStatus: deriveEffectiveStatus(mission.status, payload.missionStatus),
      objective: payload.objective,
      targetDefinition: payload.targetDefinition,
      qualificationRules: payload.qualificationRules,
      allowedChannels: payload.allowedChannels,
      policy: payload.policy,
      budgetCents: payload.budgetCents,
      spentCents: payload.spentCents,
      remainingCents: Math.max(0, payload.budgetCents - payload.spentCents),
      deadlineAt: payload.deadlineAt,
      startedAt: payload.startedAt,
      channels: payload.channels,
      approveBeforePivot: payload.approveBeforePivot,
      firstTouchOptIn: payload.firstTouchOptIn,
      projectId: mission.projectId,
      assignedAgentId: mission.assignedAgentId,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
      completedAt: mission.completedAt,
      activeTasks: activeTasks.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        assignedAgentId: t.assignedAgentId,
        context: t.context,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      completedTasks: completedTasks.length,
      totalTasks: missionTasks.length,
      pendingApprovals: missionApprovals.map(a => ({
        id: a.id,
        reason: a.reason,
        status: a.status,
        toolName: a.tool_name,
        createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    console.error('GET /api/missions/:missionId error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * PATCH /api/missions/:missionId
 * Update mission metadata (title, budget, deadline, etc.).
 */
router.patch('/:missionId', async (req: Request, res: Response) => {
  try {
    const { missionId } = req.params;
    const updates = req.body;

    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, missionId))
      .limit(1);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const payload = parseMissionPayload(mission.result);

    // Build update
    const updateFields: Record<string, unknown> = {};
    const resultUpdates: Record<string, unknown> = {};

    if (updates.title !== undefined) {
      updateFields.title = updates.title;
    }
    if (updates.deadlineAt !== undefined) {
      resultUpdates.deadlineAt = updates.deadlineAt;
    }
    if (updates.budgetCents !== undefined) {
      if (updates.budgetCents < payload.spentCents) {
        return res.status(400).json({
          error: 'Budget cannot be reduced below spent amount',
        });
      }
      resultUpdates.policy = { ...payload.policy, budgetCents: updates.budgetCents };
      resultUpdates.budgetCents = updates.budgetCents;
    }
    if (updates.allowedChannels !== undefined) {
      resultUpdates.allowedChannels = updates.allowedChannels;
      resultUpdates.channels = updates.allowedChannels;
    }

    const newResult = {
      ...payload,
      ...resultUpdates,
      missionType: 'revenue_ops',
    };

    await db.update(goals).set({
      ...updateFields,
      result: JSON.stringify(newResult),
      updatedAt: new Date(),
    }).where(eq(goals.id, missionId));

    return res.json({
      missionId,
      message: 'Mission updated successfully.',
      updated: {
        title: updateFields.title,
        deadlineAt: resultUpdates.deadlineAt,
        budgetCents: resultUpdates.budgetCents,
        allowedChannels: resultUpdates.allowedChannels,
      },
    });
  } catch (err) {
    console.error('PATCH /api/missions/:missionId error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/missions/:missionId/submit
 * Submit a draft mission for validation.
 */
router.post('/:missionId/submit', async (req: Request, res: Response) => {
  try {
    const { missionId } = req.params;
    const { reason } = req.body || {};

    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, missionId))
      .limit(1);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const payload = parseMissionPayload(mission.result);
    if (payload.missionStatus !== 'draft') {
      return res.status(400).json({
        error: `Mission is not in draft status (current: ${payload.missionStatus}). Only draft missions can be submitted.`,
      });
    }

    // Update to validating
    const updatedPayload = { ...payload, missionStatus: 'validating' };
    await db.update(goals).set({
      result: JSON.stringify(updatedPayload),
      updatedAt: new Date(),
    }).where(eq(goals.id, missionId));

    // Create approval request
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      task_id: null as any,
      agent_id: 'system', // Submitted by API, not an agent
      tool_name: 'submit_mission_for_validation',
      tool_args: JSON.stringify({ missionId }),
      reason: reason || `Mission validation request: ${mission.title}`,
      status: 'pending',
      kind: 'approval',
      created_at: new Date(),
    });

    return res.status(201).json({
      missionId,
      status: 'validating',
      approvalId,
      message: 'Mission submitted for validation. Awaiting approval.',
    });
  } catch (err) {
    console.error('POST /api/missions/:missionId/submit error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/missions/:missionId/pause
 * Pause a running mission.
 */
router.post('/:missionId/pause', async (req: Request, res: Response) => {
  try {
    const { missionId } = req.params;
    const { reason } = req.body || {};

    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, missionId))
      .limit(1);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const payload = parseMissionPayload(mission.result);
    if (payload.missionStatus !== 'running') {
      return res.status(400).json({
        error: `Mission is not running (current: ${payload.missionStatus}). Only running missions can be paused.`,
      });
    }

    // Pause mission
    const updatedPayload = { ...payload, missionStatus: 'paused' };
    await db.update(goals).set({
      status: 'paused',
      result: JSON.stringify(updatedPayload),
      updatedAt: new Date(),
    }).where(eq(goals.id, missionId));

    // Pause active tasks
    await db.update(tasks).set({
      status: 'blocked',
      updatedAt: new Date(),
    }).where(
      eq(tasks.goalId, missionId),
      inArray(tasks.status, ['in_progress', 'pending'] as const)
    );

    return res.json({
      missionId,
      status: 'paused',
      pausedAt: new Date().toISOString(),
      reason,
      message: 'Mission paused.',
    });
  } catch (err) {
    console.error('POST /api/missions/:missionId/pause error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/missions/:missionId/resume
 * Resume a paused mission.
 */
router.post('/:missionId/resume', async (req: Request, res: Response) => {
  try {
    const { missionId } = req.params;
    const { reason } = req.body || {};

    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, missionId))
      .limit(1);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const payload = parseMissionPayload(mission.result);
    if (payload.missionStatus !== 'paused') {
      return res.status(400).json({
        error: `Mission is not paused (current: ${payload.missionStatus}). Only paused missions can be resumed.`,
      });
    }

    // Resume mission
    const updatedPayload = { ...payload, missionStatus: 'running' };
    await db.update(goals).set({
      status: 'active',
      result: JSON.stringify(updatedPayload),
      updatedAt: new Date(),
    }).where(eq(goals.id, missionId));

    // Resume blocked tasks
    await db.update(tasks).set({
      status: 'pending',
      updatedAt: new Date(),
    }).where(
      eq(tasks.goalId, missionId),
      eq(tasks.status, 'blocked')
    );

    return res.json({
      missionId,
      status: 'running',
      resumedAt: new Date().toISOString(),
      reason,
      message: 'Mission resumed.',
    });
  } catch (err) {
    console.error('POST /api/missions/:missionId/resume error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/missions/:missionId/cancel
 * Cancel a mission.
 */
router.post('/:missionId/cancel', async (req: Request, res: Response) => {
  try {
    const { missionId } = req.params;
    const { reason } = req.body;

    if (!reason || reason.length < 10) {
      return res.status(400).json({
        error: 'Cancellation reason must be at least 10 characters.',
      });
    }

    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, missionId))
      .limit(1);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const payload = parseMissionPayload(mission.result);

    // Cancel mission
    const updatedPayload = { ...payload, missionStatus: 'cancelled', cancelledReason: reason };
    await db.update(goals).set({
      status: 'cancelled',
      result: JSON.stringify(updatedPayload),
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(goals.id, missionId));

    // Cancel active tasks
    await db.update(tasks).set({
      status: 'cancelled',
      result: `Mission cancelled: ${reason}`,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(
      eq(tasks.goalId, missionId),
      inArray(tasks.status, ['pending', 'in_progress', 'blocked', 'awaiting_approval'] as const)
    );

    return res.json({
      missionId,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      reason,
      message: 'Mission cancelled.',
    });
  } catch (err) {
    console.error('POST /api/missions/:missionId/cancel error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/missions/:missionId/budget-exhaust
 * Mark a mission as budget-exhausted.
 */
router.post('/:missionId/budget-exhaust', async (req: Request, res: Response) => {
  try {
    const { missionId } = req.params;
    const { spentCents } = req.body;

    if (spentCents === undefined || typeof spentCents !== 'number') {
      return res.status(400).json({
        error: 'spentCents is required and must be a number.',
      });
    }

    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, missionId))
      .limit(1);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const payload = parseMissionPayload(mission.result);
    if (spentCents < payload.budgetCents) {
      return res.status(400).json({
        error: `Cannot exhaust budget: spentCents (${spentCents}) < budgetCents (${payload.budgetCents}).`,
      });
    }
    if (payload.missionStatus !== 'running') {
      return res.status(400).json({
        error: `Mission is not running (current: ${payload.missionStatus}). Only running missions can become budget_exhausted.`,
      });
    }

    // Mark as budget-exhausted
    const updatedPayload = { ...payload, missionStatus: 'budget_exhausted' };
    await db.update(goals).set({
      result: JSON.stringify(updatedPayload),
      updatedAt: new Date(),
    }).where(eq(goals.id, missionId));

    // Block pending tasks
    await db.update(tasks).set({
      status: 'blocked',
      errorMessage: 'Mission budget exhausted',
      updatedAt: new Date(),
    }).where(
      eq(tasks.goalId, missionId),
      eq(tasks.status, 'pending')
    );

    return res.json({
      missionId,
      status: 'budget_exhausted',
      spentCents,
      budgetCents: payload.budgetCents,
      exhaustedAt: new Date().toISOString(),
      message: 'Mission budget exhausted.',
    });
  } catch (err) {
    console.error('POST /api/missions/:missionId/budget-exhaust error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/missions/:missionId/budget-increase
 * Approve a budget increase for a budget-exhausted mission.
 */
router.post('/:missionId/budget-increase', async (req: Request, res: Response) => {
  try {
    const { missionId } = req.params;
    const { newBudgetCents, approvedBy } = req.body;

    if (newBudgetCents === undefined || typeof newBudgetCents !== 'number') {
      return res.status(400).json({
        error: 'newBudgetCents is required and must be a number.',
      });
    }

    const [mission] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, missionId))
      .limit(1);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const payload = parseMissionPayload(mission.result);
    if (newBudgetCents <= payload.budgetCents) {
      return res.status(400).json({
        error: `New budget (${newBudgetCents}) must be greater than current budget (${payload.budgetCents}).`,
      });
    }
    if (payload.missionStatus !== 'budget_exhausted') {
      return res.status(400).json({
        error: `Mission is not budget_exhausted (current: ${payload.missionStatus}). Only budget_exhausted missions can be resumed with budget increase.`,
      });
    }

    // Increase budget and resume
    const updatedPayload = {
      ...payload,
      missionStatus: 'running',
      policy: { ...payload.policy, budgetCents: newBudgetCents },
      budgetCents: newBudgetCents,
    };
    await db.update(goals).set({
      result: JSON.stringify(updatedPayload),
      updatedAt: new Date(),
    }).where(eq(goals.id, missionId));

    // Unblock tasks
    await db.update(tasks).set({
      status: 'pending',
      errorMessage: null,
      updatedAt: new Date(),
    }).where(
      eq(tasks.goalId, missionId),
      and(
        eq(tasks.status, 'blocked'),
        eq(tasks.errorMessage, 'Mission budget exhausted')
      )
    );

    return res.json({
      missionId,
      status: 'running',
      previousBudgetCents: payload.budgetCents,
      newBudgetCents,
      resumedAt: new Date().toISOString(),
      approvedBy: approvedBy || 'manual',
      message: 'Mission budget increased and mission resumed.',
    });
  } catch (err) {
    console.error('POST /api/missions/:missionId/budget-increase error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/missions/stats
 * Get mission statistics (counts by status, total budget, etc.).
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    // Get all revenue-ops missions
    const missions = await db
      .select()
      .from(goals)
      .where(missionFilter());

    const stats = {
      total: missions.length,
      byStatus: {
        draft: 0,
        validating: 0,
        ready: 0,
        running: 0,
        waiting_approval: 0,
        paused: 0,
        blocked: 0,
        budget_exhausted: 0,
        completed: 0,
        cancelled: 0,
        failed: 0,
      } as Record<string, number>,
      totalBudgetCents: 0,
      totalSpentCents: 0,
      activeMissions: 0,
    };

    for (const m of missions) {
      const payload = parseMissionPayload(m.result);
      const status = payload.missionStatus;
      if (stats.byStatus[status] !== undefined) {
        stats.byStatus[status]++;
      }
      stats.totalBudgetCents += payload.budgetCents;
      stats.totalSpentCents += payload.spentCents;
      if (['running', 'ready', 'validating', 'paused', 'waiting_approval', 'blocked', 'budget_exhausted'].includes(status)) {
        stats.activeMissions++;
      }
    }

    return res.json(stats);
  } catch (err) {
    console.error('GET /api/missions/stats error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

export default router;
