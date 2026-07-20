import { Router } from 'express';
import type { HealthMonitor } from '@workspace/health-monitor';
import type { AlertManager } from '@workspace/health-monitor';
import { db, componentHealth, healthMetrics } from '@workspace/db';
import { desc } from 'drizzle-orm';

// ─── Health API Routes ────────────────────────────────────────────────────────
//
// These routes expose the HealthMonitor + AlertManager state to external
// consumers (dashboard, monitoring tools, Railway health checks). All routes
// are behind requireAdminAuth (mounted under /api in the main server).
//
// The HealthMonitor and AlertManager instances are injected by the caller
// (api-server/src/index.ts) so they share state with the 60s polling loop
// and the agent tools.

export function createHealthRouter(monitor: HealthMonitor, alertManager: AlertManager): Router {
  const router = Router();

  // GET /api/health — full live health report
  router.get('/', async (_req, res) => {
    try {
      const report = await monitor.runAll();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/health/components — per-component status from DB
  router.get('/components', async (_req, res) => {
    try {
      const components = await db.select().from(componentHealth);
      res.json(components);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/health/history — recent health metrics (time-series)
  router.get('/history', async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '100'), 10);
      const component = req.query.component as string | undefined;

      let query = db.select().from(healthMetrics).orderBy(desc(healthMetrics.checkedAt)).limit(limit);
      if (component) {
        const { eq } = await import('drizzle-orm');
        query = db.select().from(healthMetrics)
          .where(eq(healthMetrics.component, component))
          .orderBy(desc(healthMetrics.checkedAt))
          .limit(limit);
      }
      const rows = await query;
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/health/alerts — active alerts
  router.get('/alerts', (_req, res) => {
    try {
      const alerts = alertManager.getActiveAlerts();
      const summary = alertManager.getSummary();
      res.json({ alerts, summary });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/health/alerts/:id/acknowledge — acknowledge an alert
  router.post('/alerts/:id/acknowledge', (req, res) => {
    try {
      const acknowledged = alertManager.acknowledge(req.params.id);
      if (!acknowledged) {
        res.status(404).json({ error: `Alert ${req.params.id} not found` });
        return;
      }
      res.json({ acknowledged: true, alertId: req.params.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
