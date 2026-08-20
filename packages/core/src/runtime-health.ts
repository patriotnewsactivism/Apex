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
