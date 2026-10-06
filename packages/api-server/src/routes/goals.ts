import { Router } from 'express';
import { z } from 'zod';
import { db, goals, tasks } from '@workspace/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ApexCEO } from '@workspace/agents';

const submitGoalSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10),
  priority: z.number().int().min(1).max(10).optional().default(5),
  projectId: z.string().min(2).max(60).optional(), // scopes this goal to a project in the registry (GET /api/projects)
});

/**
 * Terminal goal statuses. Mirrors the tasks terminal-immutability fix
 * (guarded PATCH amendment 092a1729): a completed or cancelled goal is
 * immutable and any status-changing write to it is rejected with 409.
 */
const TERMINAL_GOAL_STATUSES = ['completed', 'cancelled'] as const;
const PATCHABLE_GOAL_STATUSES = ['active', 'paused', 'cancelled'] as const;

export function createGoalsRouter(ceo: ApexCEO) {
  const router = Router();

  // GET /api/goals — list all goals
  router.get('/', async (_req, res) => {
    try {
      const allGoals = await db.select().from(goals).orderBy(desc(goals.createdAt));
      res.json({ goals: allGoals });
    } catch (err) {
      res.json({ goals: [] });
    }
  });

  // GET /api/goals/:id — get goal by id
  router.get('/:id', async (req, res) => {
    const [goal] = await db.select().from(goals).where(eq(goals.id, req.params.id)).limit(1);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    return res.json({ goal });
  });

  // POST /api/goals — submit new goal
  router.post('/', async (req, res) => {
    try {
      const parsed = submitGoalSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }

      const { title, description, priority, projectId } = parsed.data;
      const goalId = await ceo.submitGoal(title, description, priority, projectId);
      return res.status(201).json({ goalId, message: 'Goal submitted to APEX CEO' });
    } catch (err) {
      console.error('[goals] POST / error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /api/goals/:id — update status (terminal-safe, attributed)
  router.patch('/:id', async (req, res) => {
    const schema = z.object({ status: z.enum(PATCHABLE_GOAL_STATUSES) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid status' });

    const [existing] = await db.select().from(goals).where(eq(goals.id, req.params.id)).limit(1);
    if (!existing) return res.status(404).json({ error: 'Goal not found' });

    // Mirrored terminal immutability: a completed/cancelled goal cannot be
    // re-opened or re-cancelled. Reject with 409.
    if (TERMINAL_GOAL_STATUSES.includes(existing.status as (typeof TERMINAL_GOAL_STATUSES)[number])) {
      return res.status(409).json({
        error: 'Goal is terminal and cannot be modified',
        status: existing.status,
        id: existing.id,
      });
    }

    const set: Record<string, unknown> = { status: parsed.data.status };
    if (parsed.data.status === 'cancelled') set.completedAt = new Date();

    const updated = await db
      .update(goals)
      .set(set)
      .where(
        and(
          eq(goals.id, req.params.id),
          inArray(goals.status, ['active', 'paused']),
        ),
      )
      .returning();

    if (updated.length === 0) {
      return res.status(409).json({
        error: 'Goal is terminal and cannot be modified',
        id: req.params.id,
      });
    }

    // ── Goal-close cascade (goal-close leak fix) ──────────────────────────
    // When a goal is cancelled, every non-terminal task under it is cancelled
    // too, so cancelled goals stop leaving orphaned open tasks in the backlog.
    // Terminal tasks (done/failed/cancelled) are untouched — terminal immutability
    // is preserved, mirroring the guarded tasks PATCH. Cancellation is attributed
    // to the cascade itself for auditability (cancelled_by/cancel_reason/cancelled_at).
    // Paused/active goals do NOT cascade: the tasks status enum has no 'paused'
    // value, and auto-activating tasks would override an executor's explicit state —
    // so non-cancel transitions report tasksUpdated: 0 by design (documented).
    let tasksUpdated = 0;
    if (parsed.data.status === 'cancelled') {
      const now = new Date();
      const cascaded = await db
        .update(tasks)
        .set({
          status: 'cancelled',
          cancelledBy: 'goal-cascade',
          cancelReason: `Goal cancelled: ${existing.title}`,
          cancelledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.goalId, req.params.id),
            inArray(tasks.status, ['pending', 'in_progress', 'blocked', 'awaiting_approval']),
          ),
        )
        .returning();
      tasksUpdated = cascaded.length;
    }

    return res.json({ updated: true, id: updated[0].id, status: updated[0].status, tasksUpdated });
  });

  return router;
}