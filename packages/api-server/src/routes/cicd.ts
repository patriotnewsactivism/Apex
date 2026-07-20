import { Router } from 'express';
import {
  db,
  pipelineRuns,
  testResults,
  lintResults,
  deployments,
} from '@workspace/db';
import { TestRunner, LinterRunner, BuildManager, DeploymentManager } from '@workspace/cicd-automation';
import { eq, desc } from 'drizzle-orm';
import crypto from 'crypto';

// ─── CI/CD API Routes ─────────────────────────────────────────────────────────
//
// Pipeline management endpoints for tests, builds, linting, and deployment operations.
// Protected by requireAdminAuth (mounted under /api in main server).

export function createCicdRouter(): Router {
  const router = Router();

  // GET /api/cicd/status — get current pipeline, test, lint, & deployment status summary
  router.get('/status', async (_req, res) => {
    try {
      const [latestRun] = await db
        .select()
        .from(pipelineRuns)
        .orderBy(desc(pipelineRuns.startedAt))
        .limit(1);

      const [latestTest] = await db
        .select()
        .from(testResults)
        .orderBy(desc(testResults.recordedAt))
        .limit(1);

      const [latestLint] = await db
        .select()
        .from(lintResults)
        .orderBy(desc(lintResults.recordedAt))
        .limit(1);

      const activeDeployments = await db
        .select()
        .from(deployments)
        .orderBy(desc(deployments.deployedAt))
        .limit(5);

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

  // POST /api/cicd/test — trigger an automated test/typecheck run
  router.post('/test', async (_req, res) => {
    try {
      const runner = new TestRunner();
      const report = await runner.runTests();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/cicd/lint — trigger a linter run
  router.post('/lint', async (_req, res) => {
    try {
      const runner = new LinterRunner();
      const report = await runner.runLint();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/cicd/build — trigger a project build
  router.post('/build', async (_req, res) => {
    try {
      const manager = new BuildManager();
      const result = await manager.buildProject();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/cicd/deploy — trigger a deployment
  router.post('/deploy', async (req, res) => {
    try {
      const { environment, platform } = req.body as { environment?: 'staging' | 'production'; platform?: 'railway' | 'vercel' | 'local' };
      const manager = new DeploymentManager();
      const result = await manager.deploy({
        environment: environment ?? 'production',
        platform: platform ?? 'railway',
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/cicd/rollback — rollback a deployment
  router.post('/rollback', async (req, res) => {
    try {
      const { deploymentId } = req.body as { deploymentId: string };
      if (!deploymentId) {
        res.status(400).json({ error: 'deploymentId is required' });
        return;
      }
      const manager = new DeploymentManager();
      const result = await manager.rollback(deploymentId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/cicd/history — pipeline execution history
  router.get('/history', async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '20'), 10);
      const runs = await db
        .select()
        .from(pipelineRuns)
        .orderBy(desc(pipelineRuns.startedAt))
        .limit(limit);
      res.json(runs);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
