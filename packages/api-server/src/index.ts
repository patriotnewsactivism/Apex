// APEX API Server — force rebuild 2026-07-30 to clear stale Docker cache
import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statfsSync } from 'fs';

config({ path: resolve(process.cwd(), '.env') });

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { db, componentHealth, healthMetrics, migrate } from '@workspace/db';
import { ApexCEO } from '@workspace/agents';
import { createSettingsRouter } from './routes/settings.js';
import { HealthMonitor } from '@workspace/health-monitor';
import { capacityPauseRemainingMs, getConfiguredProviders, getDegradedToolCallingReport, getToolRegistry, getSharedAlertManager, emitApexEvent, getTokenLedgerSnapshot, getDequeueHealth, isTaskQueueBroken, getBuildInfo, getProviderRoster, getProviderBackpressureSnapshot, resetTokenLedger, getWorkforceLiveness, getWorkerHeartbeatSummary, getAutonomyCounters } from '@workspace/core';
import { bootstrapApexRuntime } from './runtime-bootstrap.js';
import { setupWebSocket, getConnectedClientCount } from './websocket.js';
import { setupLiveVoice } from './live-voice.js';
import { createGoalsRouter } from './routes/goals.js';
import { createChatRouter } from './routes/chat.js';
import { createTranscribeRouter } from './routes/transcribe.js';
import { createProjectsRouter } from './routes/projects.js';
import { createTasksRouter } from './routes/tasks.js';
import { createAgentsRouter } from './routes/agents.js';
import { createLogsRouter } from './routes/logs.js';
import { createApprovalsRouter, sweepStaleEscalations } from './routes/approvals.js';
import { createMemoryRouter } from './routes/memory.js';
import { createToolsRouter } from './routes/tools.js';
import { createAuthRouter } from './routes/auth.js';
import { createHealthRouter } from './routes/health.js';
import { createDiagnosticsRouter } from './routes/diagnostics.js';
import { createJobsRouter } from './routes/jobs.js';
import { createLearningRouter } from './routes/learning.js';
import { createSuggestionsRouter } from './routes/suggestions.js';
import { createVapiWebhookRouter } from './routes/vapi.js';
import { createResendWebhookRouter } from './routes/resend-webhook.js';
import { createCicdRouter } from './routes/cicd.js';
import { createMultiappRouter } from './routes/multiapp.js';
import { createPredictiveRouter } from './routes/predictive.js';
import { createLeadsRouter } from './routes/leads.js';
import { createCampaignsRouter } from './routes/campaigns.js';
import { createArtifactsRouter } from './routes/artifacts.js';
import { createAutonomyRouter } from './routes/autonomy.js';
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

// seedDefaultJobs() and recoverStaleLeasedTasks() were moved to
// ./bootstrap-jobs.js (Phase 5 shared bootstrap) so worker.ts can use them
// too — see runtime-bootstrap.ts, which both entrypoints now call.
async function main() {
  console.log('🚀 APEX starting up...');

  try {
    await migrate();
    console.log('✅ Database initialized');
  } catch (err) {
    console.warn('⚠️  Database migration skipped or deferred:', err instanceof Error ? err.message : String(err));
  }

  let mode = process.env.APEX_APPROVAL_MODE ?? 'normal';
  if (mode === 'off') {
    console.warn('⚠️  APEX_APPROVAL_MODE=off is not allowed; reverting to normal (per-role default gating).');
    mode = 'normal';
  }
  const approvalRequired = mode === 'strict' ? true : undefined;

  // Shared bootstrap (Phase 5): settings/provider-roster/token-ledger init,
  // lease-expiry recovery, campaign-tool registration, workforce creation,
  // default job seeding, the scheduler, campaign runner, executor dispatch
  // loop, durable worker heartbeat, and supervised agent loops — everything
  // the dedicated `start:worker` runtime (ADR-011) also needs and, before
  // this, did not get. See runtime-bootstrap.ts.
  const bootstrap = await bootstrapApexRuntime({ kind: 'http', approvalRequired });
  const { workforce } = bootstrap;
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
  // `verify` stashes the exact request bytes on req.rawBody for every request.
  // Cheap (one Buffer, discarded per-request), and it's the only way the
  // Resend webhook below can verify a Svix HMAC signature — that signature is
  // computed over the exact bytes Resend sent, and re-serializing req.body
  // with JSON.stringify is NOT guaranteed to reproduce them byte-for-byte
  // (key order, whitespace). Every other route ignores req.rawBody entirely.
  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));

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
  app.get('/health', async (_req, res) => {
    const queue = getDequeueHealth();
    const broken = isTaskQueueBroken();
    const agentStatusCounts = [...workforce.values()].reduce<
      Record<string, number>
    >((counts, agent) => {
      const status = agent.getStatus();
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {});
    const tokenLedger = getTokenLedgerSnapshot();
    const workforceParkedMs = capacityPauseRemainingMs();
    const providerBackpressure = getProviderBackpressureSnapshot();
    const pausedProviders = [...new Set([
      ...tokenLedger.providers
        .filter((provider) => provider.capReached || !provider.pacing.allowed)
        .map((provider) => provider.provider),
      ...providerBackpressure.pausedProviders,
    ])];
    const hardCapped =
      tokenLedger.totalCapReached ||
      tokenLedger.providers.some((provider) => provider.capReached);
    // `aggregatePaused` is the SAME expression llmCapacityAvailableNow() uses
    // to return false (`!ledger.pacing.total.allowed`), and that function gates
    // task claiming for every agent in the process. So this condition does not
    // mean "throttled" -- it means the entire workforce has stopped.
    const aggregatePaused = !tokenLedger.pacing.total.allowed;
    // These two conditions used to collapse into one "paced" string, and that
    // cost a full day of production ambiguity on 2026-09-08: at 15:19 /health
    // read `paced` while claiming ran at ~15 tasks/min (two Nemotron providers
    // resting -- benign), and at 21:46 it read `paced` with tasksClaimed frozen
    // at 2083 for 64 minutes (the workspace allowance exhausted -- total
    // stall). Identical payloads, opposite meanings, and the stall was
    // invisible: status ok, verdict ok, zero failures, poll loop healthy at
    // ~13 polls/min. It self-cleared at the 00:00 UTC reset, when state flipped
    // to `available` and 12 idle agents became 11 thinking within seconds.
    //
    // verify-capacity-latch-release.ts already named this gap in 2026-09-04:
    // "nothing outside the process could tell a parked workforce from an idle
    // one". It fixed the base-agent latch; this fixes the reporting.
    const capacityState = hardCapped
      ? "capped"
      : aggregatePaused
        ? "workforce_paused"
        : pausedProviders.length > 0
          ? "paced"
          : "available";
    const resumeCandidates = [
      tokenLedger.pacing.nextResumeAt,
      providerBackpressure.nextResumeAt,
    ].filter((value): value is string => Boolean(value));
    const nextResumeAt = resumeCandidates.length
      ? resumeCandidates.sort((a, b) => Date.parse(a) - Date.parse(b))[0]
      : null;
    // Durable, cross-process worker health (Phase 5). This process answering
    // HTTP proves nothing about whether a separately deployed `start:worker`
    // process (ADR-011 Path B) is alive — that is exactly the gap this table
    // closes. A broken/absent read degrades this section to 'unknown' rather
    // than failing the whole health check: process.memoryUsage() and the
    // in-process workforce block above remain valid even if Postgres itself
    // is the thing that is down.
    const heartbeats = await getWorkerHeartbeatSummary();
    const noHealthyWorkers = heartbeats.totalWorkerCount > 0 && heartbeats.healthyWorkerCount === 0;
    res.status(broken ? 503 : 200).json({
      status: broken ? 'degraded' : 'ok',
      agents: workforce.size,
      agentStatusCounts,
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
      // Non-secret capacity state makes a healthy HTTP listener distinguishable
      // from a workforce intentionally parked by quota pacing. Detailed usage
      // and provider roster remain behind admin auth at GET /api/tokens.
      llmCapacity: {
        state: capacityState,
        pacingEnabled: tokenLedger.pacing.enabled,
        pausedProviders,
        nextResumeAt,
        // A parked workforce and an idle one both show 13 idle agents. This
        // reports the base-agent shared latch (capacityPauseRemainingMs) only
        // -- it stays null when the workspace-wide allowance is what stopped
        // the workforce. For that case read `state: workforce_paused` above.
        workforceParkedUntil: workforceParkedMs > 0
          ? new Date(Date.now() + workforceParkedMs).toISOString()
          : null,
      },
      // Cloud Run kills and restarts a container that exceeds its memory
      // limit, which looks identical from outside to a crash: same revision,
      // uptime back to zero, no error anywhere. Reporting the numbers here is
      // what makes the difference visible — RSS that plateaus means the box is
      // simply sized too small, RSS that climbs forever means a leak.
      // Constructed-agent count is not liveness. An agent whose loop died
      // pre-fix stayed in `agents` forever while running nothing. This block
      // reports which loops are actually cycling, how often the supervisor had
      // to restart them, and which ones it gave up on.
      workforce: getWorkforceLiveness(),
      // Cross-process worker health (Phase 5) — deliberately separate from
      // the `workforce` block above, which is only ever THIS process's
      // in-memory view. A web server being healthy must not imply that
      // autonomous workers are healthy: read this before trusting that any
      // background progress is actually happening.
      workerHeartbeats: {
        ...heartbeats,
        status: heartbeats.error
          ? 'unknown'
          : heartbeats.totalWorkerCount === 0
            ? 'no_workers_registered'
            : noHealthyWorkers
              ? 'unhealthy'
              : 'healthy',
      },
      autonomy: getAutonomyCounters(),
      memory: (() => {
        const usage = process.memoryUsage();
        const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
        return {
          rssMb: mb(usage.rss),
          heapUsedMb: mb(usage.heapUsed),
          heapTotalMb: mb(usage.heapTotal),
          externalMb: mb(usage.external),
          wsClients: getConnectedClientCount(),
          // On Cloud Run /tmp is a tmpfs: bytes written there are charged
          // against the container's memory limit but appear nowhere in
          // process.memoryUsage(). A container can therefore be OOM-killed
          // while rss sits flat at 150MB, which is exactly what happened on
          // 2026-09-04 and exactly what the heap numbers alone could not
          // explain. Report it so the next occurrence is one curl away.
          tmpUsedMb: (() => {
            try {
              const stat = statfsSync('/tmp');
              return mb((stat.blocks - stat.bfree) * stat.bsize);
            } catch {
              return null;
            }
          })(),
        };
      })(),
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

  // scheduler/campaignRunner/executorDispatch already started by
  // bootstrapApexRuntime() above — destructured from `bootstrap`.

  // Login is the front door — not behind requireAdminAuth.
  app.use('/api/auth', createAuthRouter());

  // Vapi webhook — receives call results from Vapi's server (server-to-server,
  // no Bearer token available). Must be mounted BEFORE requireAdminAuth.
  app.use('/api/vapi', createVapiWebhookRouter());

  // Resend webhook — receives delivery/open/click/bounce/complaint events for
  // outbound sales email (server-to-server, verified via Svix signature
  // instead of a Bearer token). Must be mounted BEFORE requireAdminAuth.
  app.use('/api/resend', createResendWebhookRouter());

  // Everything else under /api is locked down behind a bearer token.
  app.use('/api', requireAdminAuth);

  // API Routes
  app.use('/api/goals', createGoalsRouter(ceo));
  app.use('/api/chat', createChatRouter(ceo));
  app.use('/api/transcribe', createTranscribeRouter());
  app.use('/api/projects', createProjectsRouter());
  app.use('/api/tasks', createTasksRouter());
  app.use('/api/agents', createAgentsRouter(workforce));
  app.use('/api/logs', createLogsRouter());
  app.use('/api/diagnostics', createDiagnosticsRouter(workforce));
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
  app.use('/api/campaigns', createCampaignsRouter());
  app.use('/api/artifacts', createArtifactsRouter());
  app.use('/api/autonomy', createAutonomyRouter());

  // Token spend observability (token-ledger.ts). Before this, "are we about to
  // run out of tokens?" could only be answered by reading provider error logs
  // after the fact. Behind requireAdminAuth like every other /api route.
  app.get('/api/tokens', (_req, res) => {
    // Spend alone answers "what did we use?" but not "what COULD we have
    // used?" — the roster is what makes an unfilled free slot visible here
    // rather than only in a failed task's error_message.
    res.json({ ...getTokenLedgerSnapshot(), roster: getProviderRoster() });
  });

  /**
   * POST /api/tokens/reset — clear today's spend and start the day over.
   *
   * resetTokenLedger() already existed but was reachable from nowhere, so a day
   * spent against a broken provider could only be written off by waiting for
   * the UTC rollover. Zeroing llm_token_usage_daily by hand does not work: the
   * counters live in this process and are reconciled with GREATEST(), so the
   * running total is simply written back. The reset has to happen in here.
   *
   * Behind requireAdminAuth with every other /api route.
   */
  app.post('/api/tokens/reset', async (_req, res) => {
    const before = getTokenLedgerSnapshot();
    try {
      await resetTokenLedger();
      const after = getTokenLedgerSnapshot();
      console.log(
        `[tokens] Ledger reset by operator — cleared ${before.totalTokens} tokens across ${before.providers.length} provider(s).`,
      );
      res.json({ ok: true, clearedTokens: before.totalTokens, before, after });
    } catch (err) {
      console.error('[tokens] Ledger reset failed:', err);
      res.status(500).json({ error: 'Token ledger reset failed' });
    }
  });

  // Both native RFC 6455 endpoints share one authenticated upgrade router.
  // Registering separate `WebSocketServer({ server, path })` instances installs
  // overlapping upgrade listeners and can corrupt the first frame after a 101.
  setupWebSocket(server);
  setupLiveVoice(server, ceo);

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
  // Escalations nobody answers are noise, and noise is what made the queue
  // unusable in the first place. Hourly is plenty for a 7-day window; the
  // sweep never touches a gated approval, only escalate_to_human rows.
  // (Lease-expiry recovery and executor dispatch are now recurring inside
  // bootstrapApexRuntime() so the standalone worker runtime gets them too —
  // see runtime-bootstrap.ts.)
  const escalationSweepInterval = setInterval(() => {
    sweepStaleEscalations().catch((err) =>
      console.warn('⚠️  Escalation sweep failed:', err instanceof Error ? err.message : String(err)),
    );
  }, 60 * 60 * 1000);
  setTimeout(() => {
    sweepStaleEscalations().catch(() => {});
  }, 30_000);
  // Run an immediate initial health check after 5s
  setTimeout(runHealthPoll, 5_000);

  console.log(`🤖 Autonomous agent loops running (${workforce.size} agents, staggered, supervised)`);

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received. Shutting down APEX...`);
    clearInterval(healthInterval);
    clearInterval(escalationSweepInterval);
    bootstrap.shutdown(signal).finally(() => {
      server.close(() => {
        console.log('✅ APEX shut down gracefully');
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
