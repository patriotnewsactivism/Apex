import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

// ─── Crons ───────────────────────────────────────────────────────────────────
//
// Deliberately just ONE entry per coarse recurring concern — sub-minute
// cadence (the old 2s idle poll, 2s→30s error backoff) lives in agentLoop's
// recursive ctx.scheduler.runAfter self-chaining, not here. crons.interval is
// reserved for genuinely coarse, low-count dispatch, matching the old
// JobScheduler's 60s poll and the old health-monitor's 60s setInterval.

const crons = cronJobs();

// Re-kicks any agent's tick chain that went silent (an uncaught error killed
// it before it could reschedule itself) — a safety net, not the primary
// driver. A healthy chain touches its heartbeat every ~0-2s via tick itself,
// so a 30s staleness threshold checked every 60s never flags a live chain.
crons.interval('agent-loop-watchdog', { seconds: 60 }, internal.agentLoop.resurrectStaleChains, {});

// Ports packages/background-jobs/src/job-scheduler.ts's 60s poll loop.
// Finds every enabled/active/due row in scheduledJobs and fires each as an
// independent scheduler.runAfter(0, ...) call (see convex/scheduledJobs.ts's
// dispatchDueJobs) so one slow job never blocks the others due this tick.
crons.interval('scheduled-jobs-dispatch', { seconds: 60 }, internal.scheduledJobs.dispatchDueJobs, {});

// M5: catches an externalJobs row the CI/CD worker never claimed, or claimed
// and then died mid-execution without ever calling reportJobResult back —
// without this, the waiting task's tool call would block forever.
crons.interval('external-jobs-timeout-sweep', { seconds: 60 }, internal.cicd.sweepTimedOutJobs, {});

export default crons;
