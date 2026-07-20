import { Router } from 'express';
import { db, predictiveForecasts, riskAssessments } from '@workspace/db';
import { Forecaster, RiskDetector } from '@workspace/predictive';
import { desc } from 'drizzle-orm';

// ─── Predictive API Routes ───────────────────────────────────────────────────
//
// Endpoints for predictive task completion forecasting and automated risk assessment.

export function createPredictiveRouter(): Router {
  const router = Router();

  // GET /api/predictive/tasks-forecast — get latest task completion velocity forecast
  router.get('/tasks-forecast', async (req, res) => {
    try {
      const metric = (req.query.metric as string) ?? 'task_completion_rate';
      const forecaster = new Forecaster();
      const forecast = await forecaster.forecastTasks(metric);
      res.json(forecast);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/predictive/risks — get recent portfolio risk assessments
  router.get('/risks', async (req, res) => {
    try {
      const target = (req.query.target as string) ?? 'global';
      const detector = new RiskDetector();
      const assessment = await detector.riskAssessment(target);

      const recentRisks = await db
        .select()
        .from(riskAssessments)
        .orderBy(desc(riskAssessments.createdAt))
        .limit(10);

      res.json({
        latestAssessment: assessment,
        riskHistory: recentRisks,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
