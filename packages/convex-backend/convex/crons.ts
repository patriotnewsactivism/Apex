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

export default crons;
