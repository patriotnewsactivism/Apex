// ─── Runtime health: build provenance + task-queue liveness ──────────────────
//
// Written 2026-08-19 after a night of chasing a dequeue() failure that cost one
// full CodeBuild + Lightsail deploy per hypothesis. Two questions had no cheap
// answer and both should be a single curl:
//
//   1. "Is the code I just built actually the code that's running?"
//      With a mutable `:latest` tag and a service that reports ACTIVE either
//      way, the only honest signals are the build SHA baked into the image and
//      the process start time. Guessing from log tails is how an hour goes.
//
//   2. "Is the task queue actually draining, or failing identically forever?"
//      dequeue() failures were logged and nothing else. A queue that throws on
//      100% of calls looked exactly like an idle-but-healthy system from the
//      outside: /health said ok, agents polled, nothing ran. Health checks that
//      only prove the HTTP listener is up cannot catch that, and a deploy
//      verified only against such a check is not verified.

export interface DequeueHealth {
  attempts: number;
  successes: number;
  /** Tasks actually returned. Zero with a healthy queue just means idle. */
  tasksClaimed: number;
  failures: number;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  /** Message of the deepest cause, not the "Failed query: ..." wrapper. */
  lastFailureMessage: string | null;
  lastFailureAgentId: string | null;
  lastSuccessAt: string | null;
}

const state: DequeueHealth = {
  attempts: 0,
  successes: 0,
  tasksClaimed: 0,
  failures: 0,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastFailureMessage: null,
  lastFailureAgentId: null,
  lastSuccessAt: null,
};

export function recordDequeueAttempt(): void {
  state.attempts += 1;
}

export function recordDequeueSuccess(claimed: boolean): void {
  state.successes += 1;
  if (claimed) state.tasksClaimed += 1;
  state.consecutiveFailures = 0;
  state.lastSuccessAt = new Date().toISOString();
}

export function recordDequeueFailure(agentId: string, err: unknown): void {
  state.failures += 1;
  state.consecutiveFailures += 1;
  state.lastFailureAt = new Date().toISOString();
  state.lastFailureAgentId = agentId;
  state.lastFailureMessage = deepestMessage(err);
}

/** Unwrap the driver's `.cause` chain. Drizzle/postgres-js put the real reason
 *  there; the outer message is only "Failed query: <SQL>", which is what made
 *  the original failure unreadable for as long as it went unnoticed. */
function deepestMessage(err: unknown): string {
  let current = err;
  let message = typeof err === 'string' ? err : 'unknown error';
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const e = current as { message?: unknown; cause?: unknown };
    if (typeof e.message === 'string' && e.message.length > 0) message = e.message;
    current = e.cause;
  }
  return message.slice(0, 500);
}

export function getDequeueHealth(): DequeueHealth {
  return { ...state };
}

/** True when the queue is provably broken: every recent attempt threw.
 *  Deliberately requires several failures so one dropped connection during a
 *  DB failover doesn't mark the service unhealthy and trigger a rollback. */
export function isTaskQueueBroken(): boolean {
  return state.consecutiveFailures >= 5;
}

const startedAt = new Date();

export interface BuildInfo {
  /** Commit the image was built from. 'unknown' when the build did not pass
   *  APEX_BUILD_SHA — see docs/deploy-provenance.md for the buildspec line. */
  sha: string;
  builtAt: string | null;
  startedAt: string;
  uptimeSeconds: number;
}

export function getBuildInfo(): BuildInfo {
  return {
    sha: process.env.APEX_BUILD_SHA || 'unknown',
    builtAt: process.env.APEX_BUILD_TIME || null,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
  };
}

// ─── Agent loop liveness ─────────────────────────────────────────────────────
//
// `/health` reported `agents: workforce.size` — the number of agents that were
// *constructed*, not the number whose polling loop is actually alive. An agent
// whose start() promise rejected (the loop body catches everything, but the
// pre-loop setup — logger.info/setStatus — touches the DB and can throw on a
// boot-time blip) was logged once by the caller and then never restarted, and
// nothing anywhere reflected the loss. The workforce silently shrinks and the
// service still answers `status: ok` with 13 idle agents.
//
// Every poll cycle records a tick here. A loop that stops ticking is visible,
// and the supervisor that restarts it reports its restarts here too.

/** Generous: the idle poll ladder caps at 60s and a task may hold the loop for
 *  the 10-minute hard timeout, so only a much longer silence is evidence of a
 *  dead loop rather than slow work. */
export const AGENT_STALL_THRESHOLD_MS = 15 * 60 * 1000;

interface AgentLoopState {
  lastTickAt: number;
  startedAt: number;
  restarts: number;
  lastCrashMessage: string | null;
  lastCrashAt: string | null;
  supervisorGaveUp: boolean;
  /** True between a crash and the next successful loop entry. No loop exists
   *  during this window, so the agent must not be counted alive merely because
   *  its last tick is recent. */
  down: boolean;
}

const agentLoops = new Map<string, AgentLoopState>();

function loopState(agentId: string): AgentLoopState {
  let entry = agentLoops.get(agentId);
  if (!entry) {
    entry = {
      lastTickAt: Date.now(),
      startedAt: Date.now(),
      restarts: 0,
      lastCrashMessage: null,
      lastCrashAt: null,
      supervisorGaveUp: false,
      down: false,
    };
    agentLoops.set(agentId, entry);
  }
  return entry;
}

/** Called once per polling cycle by the agent loop. */
export function recordAgentLoopTick(agentId: string): void {
  loopState(agentId).lastTickAt = Date.now();
}

export function recordAgentLoopStart(agentId: string): void {
  const entry = loopState(agentId);
  entry.startedAt = Date.now();
  entry.lastTickAt = Date.now();
  entry.down = false;
}

export function recordAgentLoopCrash(agentId: string, err: unknown): void {
  const entry = loopState(agentId);
  entry.lastCrashMessage = deepestMessage(err);
  entry.lastCrashAt = new Date().toISOString();
  entry.down = true;
}

/** A restart has been *attempted*. The agent stays `down` until its loop
 *  actually enters again via recordAgentLoopStart. */
export function recordAgentLoopRestart(agentId: string): void {
  const entry = loopState(agentId);
  entry.restarts += 1;
  entry.lastTickAt = Date.now();
}

/** The supervisor exhausted its bounded restart budget: this agent is down and
 *  will not come back without operator action. Bounded on purpose — an agent
 *  that crashes instantly forever must not become an infinite restart loop. */
export function recordAgentLoopAbandoned(agentId: string): void {
  loopState(agentId).supervisorGaveUp = true;
}

export interface WorkforceLivenessEntry {
  agentId: string;
  secondsSinceTick: number;
  restarts: number;
  lastCrashAt: string | null;
  lastCrashMessage: string | null;
  abandoned: boolean;
  /** Crashed and not yet back in its loop (waiting out restart backoff). */
  down: boolean;
}

export interface WorkforceLiveness {
  supervised: number;
  alive: number;
  /** Crashed loops inside their restart backoff window. Not alive. */
  restarting: WorkforceLivenessEntry[];
  stalled: WorkforceLivenessEntry[];
  abandoned: WorkforceLivenessEntry[];
  totalRestarts: number;
}

export function getWorkforceLiveness(): WorkforceLiveness {
  const now = Date.now();
  const stalled: WorkforceLivenessEntry[] = [];
  const abandoned: WorkforceLivenessEntry[] = [];
  const restarting: WorkforceLivenessEntry[] = [];
  let alive = 0;
  let totalRestarts = 0;

  for (const [agentId, entry] of agentLoops) {
    totalRestarts += entry.restarts;
    const secondsSinceTick = Math.round((now - entry.lastTickAt) / 1000);
    const record: WorkforceLivenessEntry = {
      agentId,
      secondsSinceTick,
      restarts: entry.restarts,
      lastCrashAt: entry.lastCrashAt,
      lastCrashMessage: entry.lastCrashMessage,
      abandoned: entry.supervisorGaveUp,
      down: entry.down,
    };
    if (entry.supervisorGaveUp) {
      abandoned.push(record);
      continue;
    }
    // A crashed loop has no loop. Counting it alive for the whole backoff
    // window (up to 5 min) would hide exactly what this view exists to show.
    if (entry.down) {
      restarting.push(record);
      continue;
    }
    if (now - entry.lastTickAt > AGENT_STALL_THRESHOLD_MS) {
      stalled.push(record);
      continue;
    }
    alive += 1;
  }

  return { supervised: agentLoops.size, alive, restarting, stalled, abandoned, totalRestarts };
}

/** Test-only reset. */
export function resetWorkforceLiveness(): void {
  agentLoops.clear();
}

/** Test-only: lets the deterministic guard simulate elapsed silence without
 *  actually waiting out AGENT_STALL_THRESHOLD_MS. Not used at runtime. */
export function __getAgentLoopsForTest(): Map<string, { lastTickAt: number; down: boolean }> {
  return agentLoops;
}
