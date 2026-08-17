import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

config({ path: resolve(process.cwd(), '.env') });

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { db, migrate, tasks, componentHealth, healthMetrics } from '@workspace/db';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { createWorkforce, initializeWorkforce, ApexCEO } from '@workspace/agents';
import { loadSettingsIntoEnv } from './settingsLoader.js';
import { createSettingsRouter } from './routes/settings.js';
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

process.on('uncaughtException', (err) => {
  console.warn('⚠️  Uncaught exception caught (server protected):', err instanceof Error ? err.message : String(err));
});
process.on('unhandledRejection', (reason) => {
  console.warn('⚠️  Unhandled rejection caught (server protected):', reason instanceof Error ? reason.message : String(reason));
});

// Seed the default recurring system jobs that make APEX self-directing and
// self-improving. Idempotent via onConflictDoNothing: a job is created only if
// its stable id is absent, so a job an operator later disables via
// /api/jobs/:id/toggle stays disabled across reboots (we never re-enable it).
async function seedDefaultJobs(): Promise<void> {
  try {
    const { db, scheduledJobs } = await import('@workspace/db');
    const { CronParser } = await import('@workspace/background-jobs');

    const now = new Date();
    const defaults = [
      {
        id: 'system-ceo-goal-review',
        name: 'CEO autonomous goal review',
        jobType: 'goal_review',
        cronExpression: '*/30 * * * *', // every 30 min
        targetAgentId: 'apex-ceo-001' as string | null,
        priority: 4,
      },
      {
        id: 'system-learning-analysis',
        name: 'Autonomous learning analysis',
        jobType: 'learning_analysis',
        cronExpression: '0 */6 * * *', // every 6 h
        targetAgentId: null as string | null,
        priority: 6,
      },
    ];

    for (const def of defaults) {
      const nextRunAt = CronParser.nextRun(def.cronExpression, now) ?? new Date(now.getTime() + 60_000);
      await db
        .insert(scheduledJobs)
        .values({
          id: def.id,
          name: def.name,
          jobType: def.jobType,
          cronExpression: def.cronExpression,
          enabled: true,
          targetAgentId: def.targetAgentId,
          payload: {},
          priority: def.priority,
          status: 'active',
          retryCount: 0,
          maxRetries: 3,
          nextRunAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
    console.log('✅ Seeded default system jobs (CEO goal review + learning analysis)');
  } catch (err) {
    console.warn('⚠️  Default job seeding skipped:', err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  console.log('🚀 APEX starting up...');

  try {
    await migrate();
    console.log('✅ Database initialized');
  } catch (err) {
    console.warn('⚠️  Database migration skipped or deferred:', err instanceof Error ? err.message : String(err));
  }

  // Apply any DB-persisted integration API keys into process.env BEFORE the
  // workforce (and its LLM clients) are created, so a key saved via the
  // dashboard's Settings panel is live from the very first LLM call.
  await loadSettingsIntoEnv();

  // Lease-expiry crash recovery: only recover tasks whose lease has expired (>10 min)
  // or whose leased_at is NULL (tasks left in_progress before leased_at was added).
  // Increments retryCount and applies backoff, or marks failed if maxRetries exceeded.
  // The old naive reset (`SET status='pending' WHERE status='in_progress'`) blindly
  // requeued tasks without incrementing retryCount, allowing crash-looping tasks to
  // ignore maxRetries and spin forever.
  try {
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const staleTasks = await db
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.status, 'in_progress'),
        or(
          isNull(tasks.leasedAt),
          lt(tasks.leasedAt, staleThreshold),
        ),
      ));

    let recovered = 0;
    let exhausted = 0;
    for (const task of staleTasks) {
      const newRetryCount = task.retryCount + 1;
      if (task.retryCount >= task.maxRetries) {
        await db
          .update(tasks)
          .set({
            status: 'failed',
            errorMessage: 'Process crash: lease expired (max retries exceeded)',
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, 'in_progress')));
        exhausted++;
      } else {
        const retryDelayMs = Math.min(Math.pow(2, newRetryCount) * 1000, 300_000);
        const nextRetryAt = new Date(Date.now() + retryDelayMs);
        await db
          .update(tasks)
          .set({
            status: 'pending',
            retryCount: newRetryCount,
            leasedAt: null,
            nextRetryAt,
            errorMessage: 'Process crash: lease expired',
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, 'in_progress')));
        recovered++;
      }
    }
    console.log(`✅ Lease-expiry recovery: ${recovered} task(s) requeued, ${exhausted} task(s) failed (max retries)`);
  } catch (err) {
    console.warn('⚠️  Crash recovery skipped:', err instanceof Error ? err.message : String(err));
  }

  const mode = process.env.APEX_APPROVAL_MODE;
  const approvalRequired = mode === 'strict' ? true : mode === 'off' ? false : undefined;
  const workforce = createWorkforce({ approvalRequired });
  try {
    await initializeWorkforce(workforce);
    console.log(`✅ Workforce initialized (${workforce.size} agents)`);
  } catch (err) {
    console.warn('⚠️  Workforce DB state sync skipped:', err instanceof Error ? err.message : String(err));
  }
  console.log(`   Approval mode: ${mode === 'strict' ? 'STRICT (all agents gated)' : mode === 'off' ? 'FULLY AUTONOMOUS (no gating)' : 'PER-ROLE DEFAULT (dev/infra gated, business/orchestration autonomous)'}`);

  // buildmybot2 as a registered MANAGED project (2026-07-23): idempotent
  // upsert so the registration survives fresh databases instead of relying
  // on someone remembering to call the register_application tool. This is
  // the registry half of the managed-project interface; the adapter half
  // (repo dispatch / deploy hook / health check) lives in
  // @workspace/core/buildmybot-connector.
  try {
    const { db, projects, applications } = await import('@workspace/db');
    const now = new Date();
    await db
      .insert(projects)
      .values({
        id: 'buildmybot2',
        name: 'BuildMyBot2',
        repository: 'patriotnewsactivism/buildmybot2',
        purpose:
          'Revenue flagship — AI chatbot SaaS at buildmybot.app. Managed project: COO dispatches engineering via buildmybot_dispatch_engineering; deploys via Vercel hook; health target https://www.buildmybot.app/api/health.',
        priority: 'critical',
        status: 'active',
        autonomyLevel: 'supervisor',
      })
      .onConflictDoUpdate({
        target: projects.id,
        set: { repository: 'patriotnewsactivism/buildmybot2', priority: 'critical', status: 'active' },
      });
    await db
      .insert(applications)
      .values({
        id: 'buildmybot2',
        name: 'BuildMyBot2',
        repoUrl: 'https://github.com/patriotnewsactivism/buildmybot2',
        status: 'active',
        healthScore: 1.0,
        lastSyncAt: now,
      })
      .onConflictDoUpdate({
        target: applications.id,
        set: { repoUrl: 'https://github.com/patriotnewsactivism/buildmybot2', lastSyncAt: now },
      });
    console.log('✅ buildmybot2 registered as managed project');
  } catch (err) {
    console.warn('⚠️  buildmybot2 project registration skipped:', err instanceof Error ? err.message : String(err));
  }

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
  app.use('/api/settings', createSettingsRouter());

  // WebSocket
  setupWebSocket(server);

  // Serve dashboard static files if built
  const primaryDist = resolve(__dirname, '../../dashboard/dist');
  const fallbackDist = resolve(process.cwd(), 'packages/dashboard/dist');
  const dashboardDist = existsSync(primaryDist) ? primaryDist : existsSync(fallbackDist) ? fallbackDist : null;

  if (dashboardDist) {
    app.use(express.static(dashboardDist));
    app.use((req, res, next) => {
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

  // Seed default recurring system jobs (CEO goal review + learning analysis),
  // then start the scheduler that fires them.
  await seedDefaultJobs();

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

      // Update component_health and health_metrics in DB (safe against offline DB)
      try {
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
          });

          await db.insert(healthMetrics).values({
            component: compName,
            status: check.status,
            responseTimeMs: check.ms ?? 0,
            detail: check.detail,
            checkedAt: new Date(),
          });
        }
      } catch (err) {
        // DB offline: ignore time-series write failure
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
