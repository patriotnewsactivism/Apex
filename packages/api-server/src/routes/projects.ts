import { Router } from 'express';
import { z } from 'zod';
import { db, projects, goals, tasks } from '@workspace/db';
import { desc, eq, inArray } from 'drizzle-orm';

// ─── Projects Registry ─────────────────────────────────────────────────────
//
// Added 2026-07-18 as part of the Apex reframe: Apex is the autonomous
// operating system for ALL of Don's ventures (BuildMyBot is the flagship
// app it runs, not what Apex *is*). This is the first concrete piece of
// that registry — every project Apex can operate on lives here, and goals
// can now be scoped to one via project_id.
//
// Added 2026-07-18 (part 2): the generic per-project "status()" capability
// -- a single rollup endpoint the future Command Center UI (ARIA) can call
// to get a real health snapshot for ANY project without knowing anything
// about that project's specific stack. This is the first concrete piece of
// the "generic capability interface" (status/analyze/execute/test/deploy/
// report) design -- status() is the one every project can support today
// since it's pure Apex-internal data (goals+tasks), no per-project wiring
// needed. analyze/execute/test/deploy remain future work -- those need
// per-project adapters (repo access, deploy hooks, etc.) that don't exist
// yet for most of the 11 registered ventures.

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

const GOAL_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
const TASK_STATUSES = ['pending', 'in_progress', 'blocked', 'awaiting_approval', 'done', 'failed', 'cancelled'] as const;

function zeroCounts(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((k) => [k, 0]));
}

/** Build the status() rollup for one project's goals+tasks (already-fetched rows). */
function buildStatus(
  project: typeof projects.$inferSelect,
  projectGoals: (typeof goals.$inferSelect)[],
  projectTasks: (typeof tasks.$inferSelect)[],
) {
  const goalCounts = zeroCounts(GOAL_STATUSES);
  for (const g of projectGoals) goalCounts[g.status] = (goalCounts[g.status] ?? 0) + 1;

  const taskCounts = zeroCounts(TASK_STATUSES);
  for (const t of projectTasks) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;

  const agentsInvolved = [...new Set(projectTasks.map((t) => t.assignedAgentId).filter(Boolean))];

  const allTimestamps = [
    ...projectGoals.map((g) => g.createdAt),
    ...projectTasks.map((t) => t.updatedAt),
  ].filter(Boolean) as Date[];
  const lastActivityAt = allTimestamps.length
    ? new Date(Math.max(...allTimestamps.map((d) => d.getTime()))).toISOString()
    : null;

  // A simple, honest health signal: any failed/blocked tasks with no completed
  // counterpart-in-progress is a yellow flag; a project with zero goals/tasks
  // at all is "unmanaged" (registered but Apex hasn't started work on it yet).
  let health: 'unmanaged' | 'healthy' | 'attention_needed' | 'stalled' = 'unmanaged';
  if (projectGoals.length > 0 || projectTasks.length > 0) {
    if (taskCounts.failed > 0 || taskCounts.blocked > 0) health = 'attention_needed';
    else if (taskCounts.awaiting_approval > 0 && taskCounts.in_progress === 0 && taskCounts.pending === 0) health = 'stalled';
    else health = 'healthy';
  }

  return {
    project,
    health,
    goals: { total: projectGoals.length, byStatus: goalCounts },
    tasks: { total: projectTasks.length, byStatus: taskCounts },
    agentsInvolved,
    lastActivityAt,
  };
}

export function createProjectsRouter() {
  const router = Router();

  // GET /api/projects — the registry
  router.get('/', async (_req, res) => {
    const allProjects = await db.select().from(projects).orderBy(desc(projects.createdAt));
    res.json({ projects: allProjects });
  });

  // GET /api/projects/status — bulk status() rollup for EVERY project in one
  // call (avoids the Command Center dashboard doing N+1 requests for all 11
  // ventures). Must be registered before '/:id' so it isn't shadowed.
  router.get('/status', async (_req, res) => {
    const [allProjects, allGoals, allTasks] = await Promise.all([
      db.select().from(projects).orderBy(desc(projects.priority)),
      db.select().from(goals),
      db.select().from(tasks),
    ]);
    const goalsByProject = new Map<string, (typeof goals.$inferSelect)[]>();
    for (const g of allGoals) {
      if (!g.projectId) continue;
      const arr = goalsByProject.get(g.projectId) ?? [];
      arr.push(g);
      goalsByProject.set(g.projectId, arr);
    }
    const goalIdToProject = new Map<string, string>();
    for (const g of allGoals) if (g.projectId) goalIdToProject.set(g.id, g.projectId);
    const tasksByProject = new Map<string, (typeof tasks.$inferSelect)[]>();
    for (const t of allTasks) {
      const pid = t.goalId ? goalIdToProject.get(t.goalId) : undefined;
      if (!pid) continue;
      const arr = tasksByProject.get(pid) ?? [];
      arr.push(t);
      tasksByProject.set(pid, arr);
    }
    const results = allProjects.map((p) =>
      buildStatus(p, goalsByProject.get(p.id) ?? [], tasksByProject.get(p.id) ?? []),
    );
    return res.json({ projects: results });
  });

  // GET /api/projects/:id — single project + its goals (kept for backward compat)
  router.get('/:id', async (req, res) => {
    const [project] = await db.select().from(projects).where(eq(projects.id, req.params.id)).limit(1);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const projectGoals = await db.select().from(goals).where(eq(goals.projectId, req.params.id)).orderBy(desc(goals.createdAt));
    return res.json({ project, goals: projectGoals });
  });

  // GET /api/projects/:id/status — the generic status() capability for one
  // project: goal/task rollups by status, involved agents, last activity,
  // and an honest health signal. This is stack-agnostic -- works identically
  // for a Vite frontend, an Express API, or a static site, because it's
  // built purely from Apex's own goals/tasks data, not the target repo.
  router.get('/:id/status', async (req, res) => {
    const [project] = await db.select().from(projects).where(eq(projects.id, req.params.id)).limit(1);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const projectGoals = await db.select().from(goals).where(eq(goals.projectId, req.params.id));
    const goalIds = projectGoals.map((g) => g.id);
    const projectTasks = goalIds.length
      ? await db.select().from(tasks).where(inArray(tasks.goalId, goalIds))
      : [];

    return res.json(buildStatus(project, projectGoals, projectTasks));
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
