// ─── Guard: a dead agent loop must be visible and must be restarted ──────────
//
// Before this guard, `packages/api-server/src/index.ts` started each of the 13
// agents as `agent.start().catch((err) => console.error(...))`. The polling
// loop body catches its own errors, but the pre-loop setup (`logger.info`,
// `setStatus` — both DB-backed) can reject on a boot-time database blip. When
// it did, that agent never polled again, nothing restarted it, and `/health`
// still reported `agents: 13` because that number is the size of the
// constructed workforce map, not a liveness measurement. A silently shrinking
// workforce is the failure this service is least able to notice.
//
// Behavioural half: drives the real liveness registry in
// packages/core/src/runtime-health.ts.
// Source half: asserts the supervisor exists, is bounded, backs off with
// jitter, and that /health actually publishes the liveness view.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_STALL_THRESHOLD_MS,
  getWorkforceLiveness,
  recordAgentLoopAbandoned,
  recordAgentLoopCrash,
  recordAgentLoopRestart,
  recordAgentLoopStart,
  recordAgentLoopTick,
  resetWorkforceLiveness,
  __getAgentLoopsForTest,
} from '../packages/core/src/runtime-health.js';
import { superviseAgentLoop } from '../packages/core/src/agent-supervisor.js';

// CI invokes this through `pnpm --filter <pkg> exec`, so cwd is a package
// directory, not the repo root. Resolve from this file instead of cwd.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

export async function checkAgentLoopSupervision(): Promise<number> {
  failures = 0;

  console.log('── Agent loop liveness registry (behaviour) ──');
  resetWorkforceLiveness();

  check('an unregistered workforce reports nothing alive', getWorkforceLiveness().supervised === 0);

  recordAgentLoopStart('ceo');
  recordAgentLoopStart('cto');
  recordAgentLoopTick('ceo');
  let live = getWorkforceLiveness();
  check(
    'ticking loops are counted alive',
    live.supervised === 2 && live.alive === 2 && live.stalled.length === 0,
    live,
  );

  // Silence beyond the stall threshold is what distinguishes a dead loop from
  // slow work: the idle ladder caps at 60s and a task is hard-capped at 10 min.
  __getAgentLoopsForTest().get('cto')!.lastTickAt =
    Date.now() - (AGENT_STALL_THRESHOLD_MS + 60_000);
  live = getWorkforceLiveness();
  check(
    'a loop silent past the stall threshold is reported stalled, not alive',
    live.alive === 1 && live.stalled.length === 1 && live.stalled[0]?.agentId === 'cto',
    live,
  );
  check(
    'stall threshold is longer than the 10-minute task hard timeout',
    AGENT_STALL_THRESHOLD_MS > 10 * 60 * 1000,
    AGENT_STALL_THRESHOLD_MS,
  );

  recordAgentLoopCrash('cto', new Error('boom'));
  recordAgentLoopRestart('cto');
  live = getWorkforceLiveness();
  check(
    'a restart is counted and clears the stall',
    live.totalRestarts === 1 && live.alive === 2 && live.stalled.length === 0,
    live,
  );
  recordAgentLoopAbandoned('cto');
  live = getWorkforceLiveness();
  check(
    'an abandoned agent is reported separately and never counted alive',
    live.abandoned.length === 1 &&
      live.abandoned[0]?.agentId === 'cto' &&
      live.abandoned[0]?.lastCrashMessage === 'boom' &&
      live.alive === 1,
    live,
  );
  resetWorkforceLiveness();

  console.log('── Supervisor restart behaviour ──');
  resetWorkforceLiveness();

  // A loop that keeps crashing must be restarted a bounded number of times and
  // then abandoned — never retried forever.
  let starts = 0;
  const alwaysCrashes = {
    id: 'flaky',
    async start(): Promise<void> {
      starts++;
      throw new Error(`crash #${starts}`);
    },
    stop(): void {},
  };
  const flaky = superviseAgentLoop(alwaysCrashes, {
    maxRestarts: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    onEvent: () => {},
  });
  await waitFor(() => getWorkforceLiveness().abandoned.length === 1, 4000);
  flaky.stop();
  live = getWorkforceLiveness();
  check(
    'a permanently crashing loop is restarted a bounded number of times, then abandoned',
    starts === 3 && live.abandoned[0]?.agentId === 'flaky' && live.totalRestarts === 2,
    { starts, live },
  );

  // A loop that crashes once must actually come back.
  resetWorkforceLiveness();
  let attempts = 0;
  let recovered = false;
  const flakyOnce = {
    id: 'recovers',
    async start(): Promise<void> {
      attempts++;
      if (attempts === 1) throw new Error('transient DB blip at boot');
      recovered = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    stop(): void {},
  };
  const recoverer = superviseAgentLoop(flakyOnce, {
    maxRestarts: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    onEvent: () => {},
  });
  await waitFor(() => recovered, 4000);
  recoverer.stop();
  live = getWorkforceLiveness();
  check(
    'a loop that crashes once is restarted and recovers',
    recovered && attempts === 2 && live.abandoned.length === 0 && live.totalRestarts === 1,
    { attempts, live },
  );

  // stop() must win any pending restart, or shutdown races a resurrection.
  resetWorkforceLiveness();
  let stoppedStarts = 0;
  const stopRacer = {
    id: 'stop-racer',
    async start(): Promise<void> {
      stoppedStarts++;
      throw new Error('always');
    },
    stop(): void {},
  };
  const racer = superviseAgentLoop(stopRacer, {
    maxRestarts: 5,
    baseDelayMs: 200,
    maxDelayMs: 200,
    onEvent: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  racer.stop();
  await new Promise((resolve) => setTimeout(resolve, 600));
  check(
    'stop() cancels a pending restart instead of resurrecting the loop',
    stoppedStarts === 1,
    stoppedStarts,
  );
  resetWorkforceLiveness();

  console.log('── Supervisor and health surfacing (source) ──');
  const server = fs.readFileSync(path.join(root, 'packages/api-server/src/index.ts'), 'utf8');
  const workerRuntime = fs.readFileSync(path.join(root, 'packages/api-server/src/worker.ts'), 'utf8');
  const agent = fs.readFileSync(path.join(root, 'packages/core/src/base-agent.ts'), 'utf8');

  check(
    'the HTTP control plane supervises its agents instead of fire-and-forget',
    server.includes('superviseAgentLoop(') && !/agent\.start\(\)\.catch\(/.test(server),
  );
  check(
    'the browser-independent worker runtime uses the same supervisor',
    workerRuntime.includes('superviseAgentLoop(') && !/agent\.start\(\)\.catch\(/.test(workerRuntime),
  );
  check(
    'both entrypoints stop supervision on shutdown',
    server.includes('for (const supervisor of supervisors) supervisor.stop()') &&
      workerRuntime.includes('for (const supervisor of supervisors) supervisor.stop()'),
  );
  check(
    '/health publishes real workforce liveness, not just the constructed count',
    server.includes('workforce: getWorkforceLiveness()'),
  );
  check(
    'the agent loop emits a heartbeat every cycle',
    agent.includes('recordAgentLoopTick(this.config.id)') &&
      agent.includes('recordAgentLoopStart(this.config.id)'),
  );

  console.log(
    failures === 0
      ? '✅ ALL AGENT LOOP SUPERVISION GUARDS PASSED'
      : `❌ ${failures} CHECK(S) FAILED`,
  );
  return failures;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Standalone: `tsx scripts/verify-agent-loop-supervision.ts`
if (process.argv[1] && process.argv[1].endsWith('verify-agent-loop-supervision.ts')) {
  void checkAgentLoopSupervision().then((f) => process.exit(f === 0 ? 0 : 1));
}
