import { Router } from 'express';
import { db, applications, applicationTasks } from '@workspace/db';
import { ApplicationManager, OrchestrationEngine, KnowledgeBridge } from '@workspace/multiapp';
import { eq, desc } from 'drizzle-orm';

// ─── MultiApp API Routes ───────────────────────────────────────────────────────
//
// Endpoints for portfolio repository registration, cross-app task delegation, and shared insights.

export function createMultiappRouter(): Router {
  const router = Router();

  // GET /api/applications — list registered portfolio applications
  router.get('/applications', async (_req, res) => {
    try {
      const manager = new ApplicationManager();
      const apps = await manager.getApplications();
      res.json(apps);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/applications — register a new portfolio application
  router.post('/applications', async (req, res) => {
    try {
      const { id, name, repoUrl } = req.body as { id: string; name: string; repoUrl: string };
      if (!id || !name || !repoUrl) {
        res.status(400).json({ error: 'id, name, and repoUrl are required' });
        return;
      }

      const manager = new ApplicationManager();
      const success = await manager.registerApplication(id, name, repoUrl);
      res.json({ success, id, name, repoUrl });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/applications/:id/health — check health of specific application
  router.get('/applications/:id/health', async (req, res) => {
    try {
      const manager = new ApplicationManager();
      const health = await manager.checkHealth(req.params.id);
      res.json(health);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/applications/:id/delegate — delegate a task to an application
  router.post('/applications/:id/delegate', async (req, res) => {
    try {
      const { taskName } = req.body as { taskName: string };
      if (!taskName) {
        res.status(400).json({ error: 'taskName is required' });
        return;
      }

      const engine = new OrchestrationEngine();
      const result = await engine.delegateToApplication(req.params.id, taskName);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/applications/shared-insights — read-only global cross-app learnings
  router.get('/applications/shared-insights', async (req, res) => {
    try {
      const bridge = new KnowledgeBridge();
      const insights = await bridge.getSharedInsights();
      res.json(insights);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
