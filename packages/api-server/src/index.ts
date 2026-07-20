import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

config({ path: resolve(process.cwd(), '../../.env') });

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { db, migrate, componentHealth, healthMetrics } from '@workspace/db';
import { createWorkforce, initializeWorkforce, ApexCEO } from '@workspace/agents';
import { HealthMonitor } from '@workspace/health-monitor';
import { JobScheduler } from '@workspace/background-jobs';
import { getConfiguredProviders, getToolRegistry, getSharedAlertManager, emitApexEvent } from '@workspace/core';
import { setupWebSocket, getConnectedClientCount } from './websocket.js';
import { createGoalsRouter } from './routes/goals.js';
import { createProjectsRouter } from './routes/projects.js';
import { createTasksRouter } from './routes/tasks.js';
import { createAgentsRouter } from './routes/agents.js';
import { createLogsRouter } from './routes/logs.js';
import { createApprovalsRouter } from './routes/approvals.js';
import { createMemoryRouter } from './routes/memory.js';
import { createToolsRouter } from './routes/tools.js';
import { createAuthRouter } from './routes/auth.js';
import { createHealthRouter } from './routes/health.js';
import { createJobsRouter } from './routes/jobs.js';
import { createLearningRouter } from './routes/learning.js';
import { createCicdRouter } from './routes/cicd.js';
import { createMultiappRouter } from './routes/multiapp.js';
import { createPredictiveRouter } from './routes/predictive.js';
import { requireAdminAuth } from './middleware/auth.js';

const PORT = parseInt(process.env.PORT ?? '5000', 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log('🚀 APEX starting up...');

  try {
    await migrate();
    console.log('✅ Database initialized');
  } catch (err) {
    console.warn('⚠️  Database migration skipped or deferred:', err instanceof Error ? err.message : String(err));
  }

  const mode = process.env.APEX_APPROVAL_MODE;
  const approvalRequired = mode === 'strict' ? true : mode === 'off' ? false : undefined;
  const workforce = createWorkforce({ approvalRequired });
  await initializeWorkforce(workforce);
  console.log(`✅ Workforce initialized (${workforce.size} agents)`);
  console.log(`   Approval mode: ${mode === 'strict' ? 'STRICT (all agents gated)' : mode === 'off' ? 'FULLY AUTONOMOUS (no gating)' : 'PER-ROLE DEFAULT (dev/infra gated, business/orchestration autonomous)'}`);

  const ceo = workforce.get('apex-ceo-001') as ApexCEO;

  const app = express();
  const server = createServer(app);

  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agents: workforce.size, timestamp: Date.now() });
  });

  // Health Monitor & Alert Manager setup
  const healthMonitor = new HealthMonitor({
    getConfiguredProviders,
    getRegisteredToolCount: () => getToolRegistry().getLLMToolSchemas().length,
    wsChecker: () => ({ serverRunning: server.listening, connectedClients: getConnectedClientCount() }),
  });
  const alertManager = getSharedAlertManager();

  // Background Job Scheduler setup
  const scheduler = new JobScheduler();

  // Login is the front door — not behind requireAdminAuth.
  app.use('/api/auth', createAuthRouter());

  // Everything else under /api is locked down behind a bearer token.
  app.use('/api', requireAdminAuth);

  // API Routes
  app.use('/api/goals', createGoalsRouter(ceo));
  app.use('/api/projects', createProjectsRouter());
  app.use('/api/tasks', createTasksRouter());
  app.use('/api/agents', createAgentsRouter(workforce));
  app.use('/api/logs', createLogsRouter());
  app.use('/api/approvals', createApprovalsRouter());
  app.use('/api/memory', createMemoryRouter());
  app.use('/api/tools', createToolsRouter());
  app.use('/api/health', createHealthRouter(healthMonitor, alertManager));
  app.use('/api/jobs', createJobsRouter());
  app.use('/api/learning', createLearningRouter());
  app.use('/api/cicd', createCicdRouter());
  app.use('/api/applications', createMultiappRouter());
  app.use('/api/predictive', createPredictiveRouter());

  // WebSocket
  setupWebSocket(server);

  // Serve dashboard static files if built
  const primaryDist = resolve(__dirname, '../../dashboard/dist');
  const fallbackDist = resolve(process.cwd(), 'packages/dashboard/dist');
  const dashboardDist = existsSync(primaryDist) ? primaryDist : existsSync(fallbackDist) ? fallbackDist : null;

  if (dashboardDist) {
    app.use(express.static(dashboardDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
        return next();
      }
      res.sendFile(join(dashboardDist, 'index.html'));
    });
    console.log('✅ Dashboard static files served from:', dashboardDist);
  } else {
    console.log('ℹ️  No dashboard build found — API-only mode');
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ APEX running on http://0.0.0.0:${PORT}`);
    console.log(`✅ WebSocket ready at ws://0.0.0.0:${PORT}/ws`);
    console.log(`🤖 Approval mode: ${mode === 'strict' ? 'HUMAN APPROVAL REQUIRED (strict)' : mode === 'off' ? 'FULLY AUTONOMOUS' : 'PER-ROLE DEFAULT'}`);
  });

  // Start background job scheduler
  scheduler.start();

  // 60s Background Health Monitoring Loop
  const runHealthPoll = async () => {
    try {
      const report = await healthMonitor.runAll();

      // Emit health update event
      emitApexEvent({
        type: 'health:updated',
        overall: report.overall,
        checks: report.checks,
        timestamp: report.timestamp,
      });

      // Update component_health and health_metrics in DB
      for (const [compName, check] of Object.entries(report.checks)) {
        await db.insert(componentHealth).values({
          component: compName,
          status: check.status,
          detail: check.detail,
          lastCheckTime: new Date(),
          consecutiveFailures: check.status === 'critical' ? 1 : 0,
        }).onConflictDoUpdate({
          target: componentHealth.component,
          set: {
            status: check.status,
            detail: check.detail,
            lastCheckTime: new Date(),
          },
        }).catch(() => {});

        await db.insert(healthMetrics).values({
          component: compName,
          status: check.status,
          responseTimeMs: check.ms ?? 0,
          detail: check.detail,
          checkedAt: new Date(),
        }).catch(() => {});
      }

      // Evaluate alert rules
      const newAlerts = alertManager.evaluate(report);
      for (const alert of newAlerts) {
        emitApexEvent({
          type: 'health:alert',
          alertId: alert.id,
          severity: alert.severity,
          message: alert.message,
          component: alert.component,
        });
      }
    } catch (err) {
      console.error('[HealthMonitor] Polling cycle failed:', err);
    }
  };

  const healthInterval = setInterval(runHealthPoll, 60_000);
  // Run an immediate initial health check after 5s
  setTimeout(runHealthPoll, 5_000);

  console.log('🤖 Starting autonomous agent loops...');
  for (const agent of workforce.values()) {
    agent.start().catch((err: Error) => {
      console.error(`Agent ${agent.id} crashed:`, err.message);
    });
  }

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received. Shutting down APEX...`);
    clearInterval(healthInterval);
    scheduler.stop();
    for (const agent of workforce.values()) {
      agent.stop();
    }
    server.close(() => {
      console.log('✅ APEX shut down gracefully');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
