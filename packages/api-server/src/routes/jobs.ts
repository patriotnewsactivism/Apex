import { Router } from 'express';
import { db, scheduledJobs, jobExecutionLog } from '@workspace/db';
import { eq, desc } from 'drizzle-orm';
import crypto from 'crypto';

// ─── Job Management API Routes ────────────────────────────────────────────────
//
// CRUD for scheduled background jobs + execution history. All routes are
// behind requireAdminAuth (mounted under /api in the main server).

export function createJobsRouter(): Router {
  const router = Router();

  // GET /api/jobs — list all scheduled jobs
  router.get('/', async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '50'), 10);
      const status = req.query.status as string | undefined;

      let rows;
      if (status) {
        rows = await db.select().from(scheduledJobs)
          .where(eq(scheduledJobs.status, status))
          .orderBy(desc(scheduledJobs.createdAt))
          .limit(limit);
      } else {
        rows = await db.select().from(scheduledJobs)
          .orderBy(desc(scheduledJobs.createdAt))
          .limit(limit);
      }
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/jobs — create a new scheduled job
  router.post('/', async (req, res) => {
    try {
      const { name, jobType, cronExpression, scheduledAt, targetAgentId, payload, priority } = req.body;

      if (!name || !jobType) {
        res.status(400).json({ error: 'name and jobType are required' });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date();

      await db.insert(scheduledJobs).values({
        id,
        name,
        jobType,
        cronExpression: cronExpression ?? null,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        enabled: true,
        targetAgentId: targetAgentId ?? null,
        payload: payload ?? null,
        priority: priority ?? 5,
        status: 'active',
        retryCount: 0,
        maxRetries: 3,
        nextRunAt: scheduledAt ? new Date(scheduledAt) : now,
        createdAt: now,
        updatedAt: now,
      });

      const [created] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).limit(1);
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/jobs/:id/toggle — enable/disable a job
  router.post('/:id/toggle', async (req, res) => {
    try {
      const [existing] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, req.params.id)).limit(1);
      if (!existing) {
        res.status(404).json({ error: `Job ${req.params.id} not found` });
        return;
      }

      const newEnabled = !existing.enabled;
      await db.update(scheduledJobs).set({
        enabled: newEnabled,
        status: newEnabled ? 'active' : 'paused',
        updatedAt: new Date(),
      }).where(eq(scheduledJobs.id, req.params.id));

      const [updated] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, req.params.id)).limit(1);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/jobs/:id — remove a job
  router.delete('/:id', async (req, res) => {
    try {
      const [existing] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, req.params.id)).limit(1);
      if (!existing) {
        res.status(404).json({ error: `Job ${req.params.id} not found` });
        return;
      }

      // Delete execution logs first, then the job
      await db.delete(jobExecutionLog).where(eq(jobExecutionLog.jobId, req.params.id));
      await db.delete(scheduledJobs).where(eq(scheduledJobs.id, req.params.id));

      res.json({ deleted: true, jobId: req.params.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/jobs/:id/history — execution history for a job
  router.get('/:id/history', async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '50'), 10);
      const rows = await db.select().from(jobExecutionLog)
        .where(eq(jobExecutionLog.jobId, req.params.id))
        .orderBy(desc(jobExecutionLog.startedAt))
        .limit(limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
