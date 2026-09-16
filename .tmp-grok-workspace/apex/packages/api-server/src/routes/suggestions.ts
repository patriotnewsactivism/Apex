import crypto from 'crypto';
import { Router } from 'express';
import { db, goals, opportunities, projects, scheduledJobs } from '@workspace/db';
import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';

// Suggestions are durable opportunity artifacts, not request-time hardcoded
// warnings. The background discovery agent sees prior/dismissed ideas, so the
// dashboard becomes a ranked novelty backlog instead of repeating paraphrases.

export function createSuggestionsRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const [rows, projectRows, backgroundRows] = await Promise.all([
        db.select().from(opportunities)
          .where(eq(opportunities.status, 'proposed'))
          .orderBy(desc(opportunities.valueScore), desc(opportunities.lastSeenAt))
          .limit(60),
        db.select({ id: projects.id, name: projects.name }).from(projects),
        db.select({
          id: scheduledJobs.id,
          name: scheduledJobs.name,
          jobType: scheduledJobs.jobType,
          enabled: scheduledJobs.enabled,
          status: scheduledJobs.status,
          nextRunAt: scheduledJobs.nextRunAt,
        }).from(scheduledJobs).where(or(
          inArray(scheduledJobs.jobType, ['opportunity_discovery', 'workforce_planner', 'prompt_self_improve']),
          like(scheduledJobs.id, 'auto-project-improvement:%'),
        )).orderBy(asc(scheduledJobs.nextRunAt)).limit(80),
      ]);
      const projectNames = new Map(projectRows.map((row) => [row.id, row.name]));
      const suggestions = rows.map((row) => ({
        ...row,
        projectName: row.projectId ? projectNames.get(row.projectId) ?? row.projectId : 'APEX',
      }));
      const coreJobs = backgroundRows.filter((row) => [
        'opportunity_discovery', 'workforce_planner', 'prompt_self_improve',
      ].includes(row.jobType));
      const projectLoops = backgroundRows.filter((row) => row.id.startsWith('auto-project-improvement:'));
      res.json({
        suggestions,
        background: {
          runningWithoutDashboard:
            coreJobs.length === 3 && coreJobs.every((row) => row.enabled && row.status === 'active'),
          coreJobs,
          activeProjectLoops: projectLoops.filter((row) => row.enabled && row.status === 'active').length,
          totalProjectLoops: projectLoops.length,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Repeated clicks update one code-owned job; they cannot create an
  // unbounded queue of discovery tasks.
  router.post('/discover', async (_req, res) => {
    try {
      const [row] = await db.update(scheduledJobs).set({
        enabled: true,
        status: 'active',
        nextRunAt: new Date(),
        retryCount: 0,
        error: null,
        updatedAt: new Date(),
      }).where(eq(scheduledJobs.id, 'system-opportunity-discovery')).returning({ id: scheduledJobs.id });
      if (!row) return res.status(503).json({ error: 'Opportunity discovery job is not seeded yet' });
      return res.json({ success: true, message: 'Novel opportunity discovery queued' });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/:id/dismiss', async (req, res) => {
    try {
      const reason = typeof req.body?.reason === 'string'
        ? req.body.reason.trim().slice(0, 1_000)
        : 'Dismissed from opportunity dashboard';
      const [row] = await db.update(opportunities).set({
        status: 'dismissed',
        dismissalReason: reason,
        updatedAt: new Date(),
      }).where(and(eq(opportunities.id, req.params.id), eq(opportunities.status, 'proposed')))
        .returning({ id: opportunities.id });
      if (!row) return res.status(404).json({ error: 'Active opportunity not found' });
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Goal contents come only from the stored, auditable opportunity. Clients
  // cannot substitute an arbitrary privileged CEO instruction in the body.
  router.post('/:id/implement', async (req, res) => {
    try {
      const [opportunity] = await db.select().from(opportunities)
        .where(eq(opportunities.id, req.params.id)).limit(1);
      if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });
      if (opportunity.goalId) {
        return res.json({ success: true, goalId: opportunity.goalId, idempotent: true });
      }
      if (opportunity.status !== 'proposed') {
        return res.status(409).json({ error: `Opportunity is ${opportunity.status}, not proposed` });
      }

      const goalId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        const [claimed] = await tx.update(opportunities).set({
          status: 'accepted',
          goalId,
          updatedAt: new Date(),
        }).where(and(
          eq(opportunities.id, opportunity.id),
          eq(opportunities.status, 'proposed'),
          sql`${opportunities.goalId} IS NULL`,
        )).returning({ id: opportunities.id });
        if (!claimed) throw new Error('Opportunity was accepted by another request');
        await tx.insert(goals).values({
          id: goalId,
          projectId: opportunity.projectId,
          title: opportunity.goalTitle,
          description: opportunity.goalDescription,
          status: 'active',
          priority: opportunity.goalPriority,
          assignedAgentId: 'apex-ceo-001',
          createdAt: new Date(),
        });
      });
      return res.json({ success: true, goalId, message: 'Opportunity activated as an APEX CEO goal' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(message.includes('another request') ? 409 : 500).json({ error: message });
    }
  });

  return router;
}
