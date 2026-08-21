import { cronJobs } from 'convex/server';

// ─── Crons ───────────────────────────────────────────────────────────────────
//
// The Convex backend is an unfinished migration and is not APEX production.
// Production autonomy is owned by the Lightsail process and the Postgres
// JobScheduler. Registering the same scheduler here caused split-brain work,
// and the agent watchdog could restart thirteen 2-second polling chains.
// Keep this file deliberately empty until Convex becomes the selected system
// of record, passes its experimental CI job, and has a measured cost budget.
// A future cutover must replace the Postgres scheduler rather than run beside
// it. agentLoop also fails closed behind APEX_CONVEX_AUTONOMY_ENABLED so
// ticks left in the scheduler from an older deploy terminate safely.

const crons = cronJobs();

export default crons;
