import { Router } from 'express';
import { z } from 'zod';
import { db, projects, goals } from '@workspace/db';
import { desc, eq } from 'drizzle-orm';

// ─── Projects Registry ─────────────────────────────────────────────────────
//
// Added 2026-07-18 as part of the Apex reframe: Apex is the autonomous
// operating system for ALL of Don's ventures (BuildMyBot is the flagship
// app it runs, not what Apex *is*). This is the first concrete piece of
// that registry — every project Apex can operate on lives here, and goals
// can now be scoped to one via project_id.

const createProjectSchema = z.object({
  id: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, 'lowercase-kebab-case id'),
  name: z.string().min(1).max(120),
  repository: z.string().max(200).optional(),
  purpose: z.string().min(1),
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional().default('normal'),
  autonomyLevel: z.enum(['manual', 'assisted', 'supervisor', 'full_autonomous', 'experimental']).optional().default('supervisor'),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  repository: z.string().max(200).nullable().optional(),
  purpose: z.string().min(1).optional(),
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  autonomyLevel: z.enum(['manual', 'assisted', 'supervisor', 'full_autonomous', 'experimental']).optional(),
});

export function createProjectsRouter() {
  const router = Router();

  // GET /api/projects — the registry
  router.get('/', async (_req, res) => {
    const allProjects = await db.select().from(projects).orderBy(desc(projects.createdAt));
    res.json({ projects: allProjects });
  });

  // GET /api/projects/:id — single project + its goals (the seed of a
  // per-project "status()" view for the future Command Center UI)
  router.get('/:id', async (req, res) => {
    const [project] = await db.select().from(projects).where(eq(projects.id, req.params.id)).limit(1);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const projectGoals = await db.select().from(goals).where(eq(goals.projectId, req.params.id)).orderBy(desc(goals.createdAt));
    return res.json({ project, goals: projectGoals });
  });

  // POST /api/projects — register a new project
  router.post('/', async (req, res) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { id, name, repository, purpose, priority, autonomyLevel } = parsed.data;
    try {
      await db.insert(projects).values({ id, name, repository, purpose, priority, autonomyLevel });
    } catch (err) {
      return res.status(409).json({ error: 'Project id already exists or insert failed', detail: err instanceof Error ? err.message : String(err) });
    }
    return res.status(201).json({ created: true, id });
  });

  // PATCH /api/projects/:id — update fields, including the autonomy dial
  // (Don's "Human Override Center" concept: Manual/Assisted/Supervisor/
  // Full Autonomous/Experimental, settable per project)
  router.patch('/:id', async (req, res) => {
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    if (Object.keys(parsed.data).length === 0) return res.status(400).json({ error: 'No fields to update' });

    await db.update(projects).set({ ...parsed.data, updatedAt: new Date() }).where(eq(projects.id, req.params.id));
    return res.json({ updated: true });
  });

  return router;
}
