import { Router } from 'express';
import {
  db,
  pipelineRuns,
  testResults,
  lintResults,
  deployments,
} from '@workspace/db';
import { TestRunner, LinterRunner, BuildManager, DeploymentManager } from '@workspace/cicd-automation';
import { desc } from 'drizzle-orm';

// ─── CI/CD API Routes ────────────────────────────────────────────────────────
// Pipeline management endpoints for tests, builds, linting, and deployment.
// Protected by requireAdminAuth (mounted under /api in main server).

export function createCicdRouter(): Router {
  const router = Router();

  router.get('/status', async (_req, res) => {
    try {
      const [latestRun] = await db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1);
      const [latestTest] = await db.select().from(testResults).orderBy(desc(testResults.recordedAt)).limit(1);
      const [latestLint] = await db.select().from(lintResults).orderBy(desc(lintResults.recordedAt)).limit(1);
      const activeDeployments = await db.select().from(deployments).orderBy(desc(deployments.deployedAt)).limit(5);
      res.json({
        latestRun: latestRun ?? null,
        latestTest: latestTest ?? null,
        latestLint: latestLint ?? null,
        deployments: activeDeployments,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/test', async (_req, res) => {
    try {
      const runner = new TestRunner();
      res.json(await runner.runTests());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/lint', async (_req, res) => {
    try {
      const runner = new LinterRunner();
      res.json(await runner.runLint());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/build', async (_req, res) => {
    try {
      const manager = new BuildManager();
      res.json(await manager.buildProject());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // APEX itself has one production deployment platform: the existing Cloud Run
  // service. `expectSha` lets an approved operator require exact provenance.
  router.post('/deploy', async (req, res) => {
    try {
      const { environment, platform, expectSha } = req.body as {
        environment?: 'staging' | 'production';
        platform?: 'cloud-run' | 'local';
        expectSha?: string;
      };
      const manager = new DeploymentManager();
      const result = await manager.deploy({
        environment: environment ?? 'production',
        platform: platform ?? 'cloud-run',
        expectSha,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/rollback', async (req, res) => {
    try {
      const { deploymentId } = req.body as { deploymentId: string };
      if (!deploymentId) {
        res.status(400).json({ error: 'deploymentId is required' });
        return;
      }
      const manager = new DeploymentManager();
      res.json(await manager.rollback(deploymentId));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/history', async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '20'), 10);
      const runs = await db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(limit);
      res.json(runs);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
