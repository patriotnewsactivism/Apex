import 'dotenv/config';

import { createWorkforce, initializeWorkforce } from '@workspace/agents';
import { JobScheduler } from '@workspace/background-jobs';
import { db, agents } from '@workspace/db';

// ─── APEX Autonomous Worker Runtime ──────────────────────────────────────────
//
// This entrypoint is deliberately separate from the HTTP control plane. It is
// intended for a Cloud Run execution primitive that keeps CPU available for
// background work without depending on a dashboard/browser request.
//
// IMPORTANT:
// - It does NOT run migrations or schema-management operations.
// - It fails closed if the durable Postgres state is unavailable.
// - It uses the exact same workforce and JobScheduler implementation as the
//   control plane, so task/job ownership remains in Postgres rather than here.
// - Selecting/provisioning the production Cloud Run primitive is an explicit
//   infrastructure decision; this file does not guess project/region/resource
//   identifiers or create any GCP resource.

async function assertDurableDatabaseReady(): Promise<void> {
  try {
    // Cheap read-only probe against an existing authoritative table. Do not use
    // migrate() here: runtime DB credentials are not management-plane authority.
    await db.select({ id: agents.id }).from(agents).limit(1);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Durable database readiness check failed: ${detail}`);
  }
}

async function main(): Promise<void> {
  await assertDurableDatabaseReady();

  const workforce = createWorkforce();
  await initializeWorkforce(workforce);

  const scheduler = new JobScheduler();
  scheduler.start();

  const workerLoops = [...workforce.values()].map((agent) =>
    agent.start().catch((err) => {
      const detail = err instanceof Error ? err.stack ?? err.message : String(err);
      console.error(`[worker] Agent loop ${agent.id} exited unexpectedly: ${detail}`);
      throw err;
    }),
  );

  console.log(
    `[worker] APEX autonomous worker started with ${workforce.size} agents; durable state is Postgres-backed`,
  );

  let shuttingDown = false;
  let releaseShutdown: (() => void) | undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    releaseShutdown = resolve;
  });

  const requestShutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received; stopping scheduler and agent claim loops`);
    scheduler.stop();
    for (const agent of workforce.values()) agent.stop();
    releaseShutdown?.();
  };

  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
  process.once('SIGINT', () => requestShutdown('SIGINT'));

  await shutdownRequested;

  // Do not call process.exit() here. Allow already-started work and database /
  // provider I/O to settle naturally within the platform's termination grace
  // period. Durable task/job claims remain recoverable if the platform later
  // terminates the process before a cooperative operation settles.
  await Promise.allSettled(workerLoops);
  console.log('[worker] Autonomous worker stopped');
}

main().catch((err) => {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[worker] Fatal startup/runtime error: ${detail}`);
  process.exitCode = 1;
});
