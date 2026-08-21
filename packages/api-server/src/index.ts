// APEX API Server — force rebuild 2026-07-30 to clear stale Docker cache
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
import { getConfiguredProviders, getDegradedToolCallingReport, getToolRegistry, getSharedAlertManager, emitApexEvent, getTokenLedgerSnapshot, initializeTokenLedgerPersistence, getDequeueHealth, isTaskQueueBroken, getBuildInfo } from '@workspace/core';
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
import { createSuggestionsRouter } from './routes/suggestions.js';
import { createVapiWebhookRouter } from './routes/vapi.js';
import { createCicdRouter } from './routes/cicd.js';
import { createMultiappRouter } from './routes/multiapp.js';
import { createPredictiveRouter } from './routes/predictive.js';
import { createLeadsRouter } from './routes/leads.js';
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

// Seed the default recurring system jobs — the baseline work schedule that
// scheduling/HR owns. On conflict (job already exists), revive ONLY jobs
// currently stuck in 'failed' status: a transient outage (LLM exhaustion, DB
// blip) must never permanently silence autonomous work. Jobs an operator
// disabled via /api/jobs/:id/toggle stay disabled (enabled=false is untouched;
// only status='failed' rows are reset to 'active'). The CEO can further
// create/adjust crons at runtime via the schedule_task tool.
async function seedDefaultJobs(): Promise<void> {
  try {
    const { db, scheduledJobs } = await import('@workspace/db');
    const { CronParser } = await import('@workspace/background-jobs');
    const { eq } = await import('drizzle-orm');

    const now = new Date();
    const defaults = [
      {
        id: 'system-ceo-goal-review',
        name: 'CEO autonomous goal review',
        jobType: 'goal_review',
        cronExpression: '*/15 * * * *', // every 15 min — the autonomous spark
        targetAgentId: 'apex-ceo-001' as string | null,
        priority: 4,
        payload: {} as Record<string, unknown>,
      },
      {
        id: 'system-lead-gen-sweep',
        name: 'Lead generation research sweep',
        jobType: 'task_delegation',
        cronExpression: '0 */2 * * *', // every 2 h
        targetAgentId: 'apex-lead-research-001' as string | null,
        priority: 3,
        payload: {
          title: 'Lead generation sweep',
          description:
            'AUTONOMOUS LEAD-GEN SWEEP — run a research session now. Call listResearchedLeads first to see what is already in the pipeline and avoid duplicates. Then pick an industry/region you have NOT recently covered (rotate through the full target list in your system prompt). Use searchBusinessDirectory and webSearch to find 20-50 real qualifying businesses, then save them in one batch with saveResearchedLeadsBatch. Quality over quantity, but aim high.',
        },
      },
      {
        id: 'system-daily-report',
        name: 'Daily activity report',
        jobType: 'report_generation',
        cronExpression: '0 9 * * *', // daily at 09:00
        targetAgentId: null as string | null,
        priority: 7,
        payload: {} as Record<string, unknown>,
      },
      {
        id: 'system-daily-maintenance',
        name: 'Daily cleanup (logs, expired memories)',
        jobType: 'maintenance',
        cronExpression: '0 3 * * *', // daily at 03:00
        targetAgentId: null as string | null,
        priority: 8,
        payload: {} as Record<string, unknown>,
      },
      {
        id: 'system-learning-analysis',
        name: 'Autonomous learning analysis',
        jobType: 'learning_analysis',
        cronExpression: '0 */6 * * *', // every 6 h
        targetAgentId: null as string | null,
        priority: 6,
        payload: {} as Record<string, unknown>,
      },
      // ── Closed-loop autonomy roster ──────────────────────────────────────
      // Delegation used to be one-way: a manager handed work down and its own
      // task finished immediately, so nothing ever read the outcome back. This
      // is the return leg — it routes finished sub-work to whoever delegated it.
      {
        id: 'system-delegation-followup',
        name: 'Delegation results follow-up',
        jobType: 'delegation_followup',
        cronExpression: '*/5 * * * *', // every 5 min — keeps the feedback tight
        targetAgentId: null as string | null,
        priority: 3,
        payload: { maxPerRun: 8 } as Record<string, unknown>,
      },
      // Goals only ever left 'active' when a human clicked. This drives each
      // one to a real conclusion: decompose it, close it, or change approach.
      {
        id: 'system-goal-progress',
        name: 'Goal progress & close-out review',
        jobType: 'goal_progress',
        cronExpression: '*/30 * * * *', // every 30 min
        targetAgentId: 'apex-ceo-001' as string | null,
        priority: 4,
        payload: { maxPerRun: 4, minAgeMinutes: 20 } as Record<string, unknown>,
      },
      // Failed tasks used to be terminal and unseen. Cluster them and put the
      // recurring ones in front of the CEO.
      {
        id: 'system-failure-review',
        name: 'Failure triage review',
        jobType: 'failure_review',
        cronExpression: '15 */2 * * *', // every 2 h, offset off the hour
        targetAgentId: 'apex-ceo-001' as string | null,
        priority: 5,
        payload: { windowHours: 24, minClusterSize: 2 } as Record<string, unknown>,
      },
      // The COO and CTO had no heartbeat of their own — whole branches sat idle
      // between CEO reviews. These give each branch manager its own cadence.
      // Provider outages are transient; the work they killed should not be.
      // Runs often enough that a recovered chain resumes business work within
      // minutes rather than waiting for the next sparse business cron.
      {
        id: 'system-stalled-work-recovery',
        name: 'Recover work killed by LLM provider outages',
        jobType: 'stalled_work_recovery',
        cronExpression: '*/10 * * * *', // every 10 min
        targetAgentId: null as string | null,
        priority: 2,
        payload: { windowHours: 24, maxPerRun: 15, maxRequeues: 3 } as Record<string, unknown>,
      },
      {
        id: 'system-coo-branch-review',
        name: 'COO operations branch review',
        jobType: 'branch_review',
        cronExpression: '0 * * * *', // hourly
        targetAgentId: 'apex-coo-001' as string | null,
        priority: 4,
        payload: {
          subordinates: ['apex-lead-research-001', 'apex-sales-001', 'apex-marketing-001', 'apex-success-001'],
          includeBuildMyBot2: true,
          focus:
            'You run BuildMyBot.App day-to-day operations. Priorities in order: (1) BuildMyBot2 health — if snapshot.buildmybot2 shows open critical errors, flagged/escalated shifts, or leads stalling without a reply, act: read buildmybot_status, then send a corrective briefing with buildmybot_send_briefing or file a real ticket with buildmybot_dispatch_engineering. (2) Pipeline — leads researched but never worked are wasted spend; make sure the Lead Researcher is covering new industries/regions rather than re-covering the same ones, and that Sales is actually reviewing what was found. (3) Content and support cadence. Be honest about what is genuinely not wired yet (real outbound email/SMS and payments are not) — never report outreach that did not happen.',
        } as Record<string, unknown>,
      },
      {
        id: 'system-cto-branch-review',
        name: 'CTO engineering branch review',
        jobType: 'branch_review',
        cronExpression: '30 */2 * * *', // every 2 h, offset off the COO review
        targetAgentId: 'apex-cto-001' as string | null,
        priority: 4,
        payload: {
          subordinates: [
            'apex-lead-dev-001',
            'apex-frontend-001',
            'apex-backend-001',
            'apex-devops-001',
            'apex-qa-001',
          ],
          focus:
            'You run engineering for Apex itself and for buildmybot2. Priorities in order: (1) Stability over features — if a component is degraded or a deploy is unhealthy, that outranks all new work; call health_check and act on what it says. (2) Repeated task failures in your branch are engineering defects until proven otherwise — diagnose the real root cause rather than re-running the same work. (3) Ship real changes through PRs, never direct pushes; deploys stay approval-gated. (4) If a capability is missing because a credential or integration is not provisioned (for example GITHUB_TOKEN for the PR loop), escalate_to_human with exactly what is needed instead of repeatedly attempting work that cannot succeed.',
        } as Record<string, unknown>,
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
          payload: def.payload,
          priority: def.priority,
          status: 'active',
          retryCount: 0,
          maxRetries: 3,
          nextRunAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: scheduledJobs.id,
          set: {
            enabled: true,
            status: 'active',
            retryCount: 0,
            error: null,
            nextRunAt,
            updatedAt: now,
          },
          where: eq(scheduledJobs.status, 'failed'),
        });
    }
    console.log(
      '✅ Seeded default system jobs (goal review, lead-gen sweep, daily report, maintenance, learning, delegation follow-up, goal progress, failure triage, COO/CTO branch reviews)',
    );
  } catch (err) {
    console.warn('⚠️  Default job seeding skipped:', err instanceof Error ? err.message : String(err));
  }
}

async function recoverStaleLeasedTasks(): Promise<void> {
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
        .where(and(
          eq(tasks.id, task.id),
          eq(tasks.status, 'in_progress'),
          or(isNull(tasks.leasedAt), lt(tasks.leasedAt, staleThreshold))
        ));
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
        .where(and(
          eq(tasks.id, task.id),
          eq(tasks.status, 'in_progress'),
          or(isNull(tasks.leasedAt), lt(tasks.leasedAt, staleThreshold))
        ));
      recovered++;
    }
  }
  console.log(`✅ Lease-expiry recovery: ${recovered} task(s) requeued, ${exhausted} task(s) failed (max retries)`);
} catch (err) {
  console.warn('⚠️  Crash recovery skipped:', err instanceof Error ? err.message : String(err));
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

  const durableTokenLedger = await initializeTokenLedgerPersistence();
  console.log(
    durableTokenLedger
      ? '✅ Daily token ledger hydrated from Postgres'
      : '⚠️  Daily token ledger is memory-only; restart-safe budget accounting unavailable',
  );

  // Lease-expiry crash recovery: only recover tasks whose lease has expired (>10 min)
  // or whose leased_at is NULL (tasks left in_progress before leased_at was added).
  // Increments retryCount and applies backoff, or marks failed if maxRetries exceeded.
  // The old naive reset (`SET status='pending' WHERE status='in_progress'`) blindly
  // requeued tasks without incrementing retryCount, allowing crash-looping tasks to
  // ignore maxRetries and spin forever.
await recoverStaleLeasedTasks();

  let mode = process.env.APEX_APPROVAL_MODE ?? 'normal';
  if (mode === 'off') {
    console.warn('⚠️  APEX_APPROVAL_MODE=off is not allowed; reverting to normal (per-role default gating).');
    mode = 'normal';
  }
  const approvalRequired = mode === 'strict' ? true : undefined;
  const workforce = createWorkforce({ approvalRequired });
  try {
    await initializeWorkforce(workforce);
    console.log(`✅ Workforce initialized (${workforce.size} agents)`);
  } catch (err) {
    console.warn('⚠️  Workforce DB state sync skipped:', err instanceof Error ? err.message : String(err));
  }
  console.log(`   Approval mode: ${mode === 'strict' ? 'STRICT (all agents gated)' : 'PER-ROLE DEFAULT (dev/infra gated, business/orchestration autonomous)'}`);

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

  // Health check.
  //
  // This used to return a flat {status:'ok'} that proved only that Express was
  // listening. On 2026-08-19 every agent's dequeue() was throwing on 100% of
  // calls for hours while this endpoint reported 'ok' — so a deploy "verified"
  // against it was not verified at all. It now reports:
  //   · build provenance (which commit is actually running, and for how long),
  //     so "did my fix reach production?" is one curl instead of a redeploy;
  //   · task-queue liveness, so a queue failing identically forever is visible
  //     from outside the box.
  // A provably broken queue returns HTTP 503, which makes the automated deploy
  // verifier in @workspace/cicd-automation reject such a release instead of
  // reporting a healthy deploy of a service that cannot do any work.
  app.get('/health', (_req, res) => {
    const queue = getDequeueHealth();
    const broken = isTaskQueueBroken();
    res.status(broken ? 503 : 200).json({
      status: broken ? 'degraded' : 'ok',
      agents: workforce.size,
      build: getBuildInfo(),
      taskQueue: {
        ...queue,
        // Named so the failure mode is unmissable in a log tail or a curl.
        verdict: broken
          ? `BROKEN — ${queue.consecutiveFailures} consecutive dequeue failures: ${queue.lastFailureMessage}`
          : queue.failures > 0
            ? 'recovered — dequeue is succeeding now, but has failed before (see counters)'
            : 'ok',
      },
      timestamp: Date.now(),
    });
  });

  // Health Monitor & Alert Manager setup
  const healthMonitor = new HealthMonitor({
    getConfiguredProviders,
    getDegradedToolCalling: () => getDegradedToolCallingReport(),
    getRegisteredToolCount: () => getToolRegistry().getLLMToolSchemas().length,
    wsChecker: () => ({ serverRunning: server.listening, connectedClients: getConnectedClientCount() }),
  });
  const alertManager = getSharedAlertManager();

  // Background Job Scheduler setup
  const scheduler = new JobScheduler();

  // Login is the front door — not behind requireAdminAuth.
  app.use('/api/auth', createAuthRouter());

  // Vapi webhook — receives call results from Vapi's server (server-to-server,
  // no Bearer token available). Must be mounted BEFORE requireAdminAuth.
  app.use('/api/vapi', createVapiWebhookRouter());

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
  app.use('/api/learning', createLearningRouter(workforce));
  app.use('/api/suggestions', createSuggestionsRouter());
  app.use('/api/cicd', createCicdRouter());
  app.use('/api/applications', createMultiappRouter());
  app.use('/api/predictive', createPredictiveRouter());
  app.use('/api/settings', createSettingsRouter());
  app.use('/api/leads', createLeadsRouter());

  // Token spend observability (token-ledger.ts). Before this, "are we about to
  // run out of tokens?" could only be answered by reading provider error logs
  // after the fact. Behind requireAdminAuth like every other /api route.
  app.get('/api/tokens', (_req, res) => {
    res.json(getTokenLedgerSnapshot());
  });

  // WebSocket
  setupWebSocket(server);

  // Serve dashboard static files if built
  const primaryDist = resolve(__dirname, '../../dashboard/dist');
  const fallbackDist = resolve(process.cwd(), 'packages/dashboard/dist');
  const dashboardDist = existsSync(primaryDist) ? primaryDist : existsSync(fallbackDist) ? fallbackDist : null;

  if (dashboardDist) {
    app.use(express.static(dashboardDist, {
      setHeaders: (res, path) => {
        if (path.endsWith('.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json');
        }
        if (path.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));
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
  // Recurring safety net (2026-08-19): the original lease-expiry recovery
  // only ran once at boot, so a task wedged mid-run had no path back to
  // 'pending' short of a full process restart. Every 5 minutes is cheap
  // (one SELECT when nothing is stale) and bounds the worst case to ~15
  // minutes total (10 min stale threshold + up to 5 min until next sweep).
  const leaseRecoveryInterval = setInterval(() => {
    recoverStaleLeasedTasks().catch((err) => console.warn('⚠️  Periodic lease recovery failed:', err instanceof Error ? err.message : String(err)));
  }, 5 * 60 * 1000);
  // Run an immediate initial health check after 5s
  setTimeout(runHealthPoll, 5_000);

  // Stagger agent startup to avoid all 13 agents hitting the first LLM provider
  // simultaneously on deploy. Each agent waits a random 1-5s before starting its
  // loop, spreading the initial burst of LLM calls across a wider window.
  console.log('🤖 Starting autonomous agent loops (staggered)...');
  let agentIdx = 0;
  for (const agent of workforce.values()) {
    const delay = 500 + (agentIdx * 300) + Math.floor(Math.random() * 500);
    setTimeout(() => {
      agent.start().catch((err: Error) => {
        console.error(`Agent ${agent.id} crashed:`, err.message);
      });
    }, delay);
    agentIdx++;
  }

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received. Shutting down APEX...`);
    clearInterval(healthInterval);
    clearInterval(leaseRecoveryInterval);
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
