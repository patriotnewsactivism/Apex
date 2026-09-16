// ─── Apex CI/CD Worker — poll loop entrypoint ───────────────────────────────
//
// The standalone process implementing the worker side of convex/cicd.ts's
// contract (see @workspace/convex-backend). Convex holds the `externalJobs`
// queue; this process claims jobs, actually executes them (real filesystem,
// real git, real shell, a real headless browser — none of which a Convex
// function can do), and reports the result back.
//
// Usage:
//   pnpm --filter @workspace/apex-cicd-worker start   # long-running poll loop
//   pnpm --filter @workspace/apex-cicd-worker start -- --once   # claim+execute+report ONE job, then exit (verification helper)
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

// .env.local (git-ignored, real secrets) takes priority; .env is a
// non-secret fallback. dotenv never overwrites a var already set in
// process.env, so loading both in this order is safe.
loadEnv({ path: resolve(process.cwd(), '.env.local') });
loadEnv({ path: resolve(process.cwd(), '.env') });

import { ConvexHttpClient } from 'convex/browser';
import { api } from '@workspace/convex-backend/api';
import type { Doc, Id } from '@workspace/convex-backend/dataModel';
import { jobHandlers } from './handlers/index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var: ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

const CONVEX_URL = requireEnv('CONVEX_URL');
const WORKER_SECRET = requireEnv('CICD_WORKER_SECRET');
const POLL_INTERVAL_MS = Number(process.env.CICD_WORKER_POLL_INTERVAL_MS ?? 2000);

const client = new ConvexHttpClient(CONVEX_URL);

let shuttingDown = false;
let currentJobId: Id<'externalJobs'> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Claim at most one job, execute it, and report the result. Returns true if a job was claimed (whether it succeeded or failed), false if the queue was empty. */
async function runOneCycle(): Promise<boolean> {
  let job: Doc<'externalJobs'> | null;
  try {
    job = await client.mutation(api.cicd.claimNextJob, { workerSecret: WORKER_SECRET });
  } catch (err) {
    console.error('[cicd-worker] claimNextJob failed:', err instanceof Error ? err.message : err);
    return false;
  }

  if (!job) return false;

  currentJobId = job._id;
  console.log(`[cicd-worker] claimed job ${job._id} (${job.jobType})`);

  try {
    const handler = jobHandlers[job.jobType];
    if (!handler) {
      throw new Error(`No handler registered for jobType '${job.jobType}'`);
    }
    const result = await handler(job.payload);
    await client.mutation(api.cicd.reportJobResult, {
      workerSecret: WORKER_SECRET,
      jobId: job._id,
      success: true,
      result,
    });
    console.log(`[cicd-worker] job ${job._id} (${job.jobType}) succeeded`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cicd-worker] job ${job._id} (${job.jobType}) failed:`, message);
    try {
      await client.mutation(api.cicd.reportJobResult, {
        workerSecret: WORKER_SECRET,
        jobId: job._id,
        success: false,
        error: message,
      });
    } catch (reportErr) {
      // The job execution already failed; if we can't even report that back,
      // log loudly (the Convex-side timeout sweep will eventually mark this
      // job failed on its own) but don't crash the whole poll loop over it.
      console.error(`[cicd-worker] failed to report failure for job ${job._id}:`, reportErr);
    }
  } finally {
    currentJobId = null;
  }

  return true;
}

async function pollLoop(): Promise<void> {
  console.log(`[cicd-worker] starting poll loop against ${CONVEX_URL} (interval ${POLL_INTERVAL_MS}ms)...`);
  while (!shuttingDown) {
    const claimed = await runOneCycle();
    if (shuttingDown) break;
    if (!claimed) {
      await sleep(POLL_INTERVAL_MS);
    }
    // If a job WAS claimed, loop immediately to check for another one queued
    // up behind it instead of sleeping first.
  }
  console.log('[cicd-worker] poll loop stopped.');
}

let shutdownRequested = false;
async function shutdown(signal: string): Promise<void> {
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log(`[cicd-worker] received ${signal}, finishing in-flight job (if any) then exiting...`);
  shuttingDown = true;
  while (currentJobId) {
    await sleep(250);
  }
  console.log('[cicd-worker] shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const once = process.argv.includes('--once');

if (once) {
  runOneCycle()
    .then((claimed) => {
      console.log(claimed ? '[cicd-worker] --once: one job processed, exiting.' : '[cicd-worker] --once: no job was queued, exiting.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[cicd-worker] --once: fatal error:', err);
      process.exit(1);
    });
} else {
  pollLoop().catch((err) => {
    console.error('[cicd-worker] fatal error in poll loop:', err);
    process.exit(1);
  });
}
