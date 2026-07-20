import { Router } from 'express';
import { z } from 'zod';
import { db, goals } from '@workspace/db';
import { desc, eq } from 'drizzle-orm';
import type { ApexCEO } from '@workspace/agents';

const submitGoalSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10),
  priority: z.number().int().min(1).max(10).optional().default(5),
  projectId: z.string().min(2).max(60).optional(), // scopes this goal to a project in the registry (GET /api/projects)
});

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

  // PATCH /api/goals/:id — update status
  router.patch('/:id', async (req, res) => {
    const schema = z.object({ status: z.enum(['active', 'paused', 'cancelled']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid status' });
    
    await db.update(goals).set({ status: parsed.data.status }).where(eq(goals.id, req.params.id));
    return res.json({ updated: true });
  });

  return router;
}
