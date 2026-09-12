// ─── Shared runtime-critical bootstrap (Phase 5 of the autonomous-OS upgrade) ─
//
// Before this, the HTTP control plane (index.ts) and the dedicated
// `start:worker` runtime (worker.ts, ADR-011) independently assembled the
// "same" governed workforce. In practice they diverged: worker.ts built the
// workforce and scheduler directly and skipped everything index.ts did
// around them — loadSettingsIntoEnv (so a key saved through the dashboard's
// Settings panel was invisible to a standalone worker), the daily token
// ledger's durable hydration, lease-expiry crash recovery, seeding the
// default recurring jobs, CampaignRunner, and the sandbox-executor dispatch
// loop. A standalone worker process was therefore never actually equivalent
// to the control plane for autonomous execution — it was a strictly smaller
// runtime wearing the same name.
//
// This module is that shared routine. Both entrypoints call it for every
// piece of initialization that autonomous execution itself depends on;
// index.ts layers HTTP-only concerns (Express app, routes, the browser
// health-poll loop, WebSocket, dashboard static serving) on top afterward.

import {
  getToolRegistry,
  superviseAgentLoop,
  initializeTokenLedgerPersistence,
  initializeRequestLedgerPersistence,
  logProviderRoster,
  startWorkerHeartbeat,
  type AgentSupervisorHandle,
  type BaseAgent,
  type WorkerHeartbeatHandle,
} from '@workspace/core';
import { createWorkforce, initializeWorkforce } from '@workspace/agents';
import { JobScheduler, CampaignRunner, createCampaignTools } from '@workspace/background-jobs';
import { startExecutorDispatchLoop, executorDispatchConfig } from '@workspace/executor';
import { loadSettingsIntoEnv } from './settingsLoader.js';
import { seedDefaultJobs, recoverStaleLeasedTasks } from './bootstrap-jobs.js';

export interface RuntimeBootstrapOptions {
  /** 'http' — the control-plane process (may also run agent loops).
   *  'worker' — the dedicated start:worker runtime (ADR-011 Path B). Only
   *  used to label this process's row in worker_heartbeats; the actual
   *  initialization is identical either way, which is the whole point. */
  kind: 'http' | 'worker';
  /** Skip seeding the default recurring jobs. Exists for tests only — every
   *  real runtime should seed them. */
  skipJobSeeding?: boolean;
  logPrefix?: string;
  /** Forwarded to createWorkforce({ approvalRequired }) — APEX_APPROVAL_MODE
   *  is resolved by the caller since only the HTTP entrypoint currently
   *  exposes it as an operator-facing setting; the worker runtime inherits
   *  whatever the caller passes (default: per-role gating, same as before). */
  approvalRequired?: boolean;
}

export interface RuntimeBootstrapResult {
  workforce: Map<string, BaseAgent>;
  scheduler: JobScheduler;
  campaignRunner: CampaignRunner;
  supervisors: AgentSupervisorHandle[];
  executorDispatch: { stop(): void };
  heartbeat: WorkerHeartbeatHandle;
  /** Stops every background loop this runtime started and waits for
   *  supervised agent loops to settle. Does not touch an HTTP listener —
   *  callers that own one close it themselves after calling this. */
  shutdown(signal: string): Promise<void>;
}

export async function bootstrapApexRuntime(options: RuntimeBootstrapOptions): Promise<RuntimeBootstrapResult> {
  const log = (msg: string) => console.log(`${options.logPrefix ?? `[${options.kind}]`} ${msg}`);
  const warn = (msg: string) => console.warn(`${options.logPrefix ?? `[${options.kind}]`} ${msg}`);

  // Apply DB-persisted integration API keys into process.env BEFORE the
  // workforce (and its LLM clients) are created, so a key saved via the
  // dashboard's Settings panel is live from the very first LLM call — in
  // EVERY runtime, not only the one that happens to serve the dashboard.
  await loadSettingsIntoEnv();
  logProviderRoster();

  const durableTokenLedger = await initializeTokenLedgerPersistence();
  log(
    durableTokenLedger
      ? '✅ Daily token ledger hydrated from Postgres'
      : '⚠️  Daily token ledger is memory-only; restart-safe budget accounting unavailable',
  );

  // The request ledger must hydrate for the same reason the token one does,
  // and more urgently: Cloud Run replaces the container on every deploy, so a
  // memory-only request budget would hand the workforce a fresh full allowance
  // after each one. On a day with three deploys that is three days of spend
  // authorized against a one-day provider quota.
  const durableRequestLedger = await initializeRequestLedgerPersistence();
  log(
    durableRequestLedger
      ? '✅ Daily request ledger hydrated from Postgres'
      : '⚠️  Daily request ledger is memory-only; a restart will reset today\'s request budget',
  );

  // Lease-expiry crash recovery must run here, not only behind the HTTP
  // process: a standalone worker is exactly the runtime most likely to be
  // replaced/restarted by the platform, so it above all must reclaim tasks a
  // prior instance of itself abandoned. Recurring, not just at boot — a task
  // wedged mid-run has no path back to 'pending' otherwise short of a full
  // process restart of THIS runtime specifically.
  await recoverStaleLeasedTasks();
  const leaseRecoveryInterval = setInterval(() => {
    recoverStaleLeasedTasks().catch((err) => warn(`⚠️  Periodic lease recovery failed: ${err instanceof Error ? err.message : String(err)}`));
  }, 5 * 60 * 1000);
  leaseRecoveryInterval.unref?.();

  // Campaign tools live in background-jobs (they need the runner's
  // createCampaign), so they are registered here rather than inside
  // getToolRegistry(). Registered BEFORE the workforce is built so every
  // agent sees them on its first turn, in every runtime.
  for (const tool of createCampaignTools()) {
    getToolRegistry().register(tool);
  }

  const workforce = createWorkforce({ approvalRequired: options.approvalRequired });
  try {
    await initializeWorkforce(workforce);
    log(`✅ Workforce initialized (${workforce.size} agents)`);
  } catch (err) {
    warn(`⚠️  Workforce DB state sync skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!options.skipJobSeeding) {
    await seedDefaultJobs();
  }

  const scheduler = new JobScheduler();
  scheduler.start();

  // Lead campaign runner. Separate from JobScheduler on purpose: this is a
  // tight territory-working loop with its own lease semantics, not a cron
  // job. Previously started only by the HTTP process — a standalone worker
  // never advanced an in-flight lead campaign at all.
  const campaignRunner = new CampaignRunner();
  campaignRunner.start();

  // Sandbox-executor dispatch loop (Phase 4 of the durable-artifact/executor
  // work, ADR-013). No-op cycle when APEX_EXECUTOR_JOB is unset. Previously
  // started only by the HTTP process — a standalone worker could claim
  // ordinary tasks but never actually dispatch a runtime='job' task to the
  // Cloud Run Jobs sandbox.
  const executorDispatch = startExecutorDispatchLoop({ intervalMs: 30_000 });
  const executorConfig = executorDispatchConfig();
  log(
    executorConfig.configured
      ? `✅ Executor dispatch loop started (job '${process.env.APEX_EXECUTOR_JOB}')`
      : `ℹ️  Executor dispatch disabled: ${executorConfig.reason}`,
  );

  // Durable cross-process heartbeat (Phase 5): the only way /health can tell
  // "a web server answered" apart from "an autonomous worker is actually
  // alive" is a row this specific process keeps writing.
  const heartbeat = startWorkerHeartbeat(options.kind);

  // Supervised, not fire-and-forget: see agent-supervisor.ts for the full
  // rationale. Staggered so agents do not all hit the first LLM provider in
  // the same event-loop tick.
  const supervisors: AgentSupervisorHandle[] = [];
  let agentIdx = 0;
  for (const agent of workforce.values()) {
    supervisors.push(
      superviseAgentLoop(agent, {
        startDelayMs: 500 + agentIdx * 300 + Math.floor(Math.random() * 500),
      }),
    );
    agentIdx++;
  }

  async function shutdown(signal: string): Promise<void> {
    log(`${signal} received; stopping scheduler, campaign runner, executor dispatch, heartbeat, and agent claim loops`);
    clearInterval(leaseRecoveryInterval);
    for (const supervisor of supervisors) supervisor.stop();
    executorDispatch.stop();
    campaignRunner.stop();
    scheduler.stop();
    heartbeat.stop();
    // Allow already-started work and database/provider I/O to settle
    // naturally within the platform's termination grace period rather than
    // calling process.exit() here. Durable task/job claims remain
    // recoverable if the platform later terminates the process before a
    // cooperative operation settles.
    await Promise.allSettled(supervisors.map((supervisor) => supervisor.settled()));
  }

  return { workforce, scheduler, campaignRunner, supervisors, executorDispatch, heartbeat, shutdown };
}
