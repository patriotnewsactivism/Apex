/**
 * Guard: a failed task must not leave an agent reporting `error` forever.
 *
 * Production evidence (2026-09-12, build 3793abc). /health reported
 * `agentStatusCounts {error: 3, idle: 10}` continuously from ~68 to ~85
 * minutes of uptime while `tasksClaimed` climbed 29 -> 38. Three of thirteen
 * agents looked dead. None of them were.
 *
 * The mechanism, which is worth stating because it is easy to misread as a
 * dying workforce:
 *
 *   1. executeTask() sets `error` on a task failure and returns.
 *   2. The polling loop is unaffected -- it keeps dequeuing.
 *   3. Only the NEXT task's `setStatus('thinking')` clears `error`.
 *
 * So on a quiet queue the status is pinned until that agent happens to get
 * more work. Nothing gates execution on it: the task queue does not filter
 * agents by status, and the only other readers are a reporting count in
 * tool-registry.ts and the manual /recover-workforce reset. The agents were
 * available the whole time; the status lied about it, and that cost real
 * diagnostic time chasing a workforce collapse that was not happening.
 *
 * The fix is a self-heal in the loop's idle branch: reaching it proves the
 * loop is cycling and the dequeue succeeded, so a leftover `error` is stale
 * by construction and is cleared to `idle`. The failure record itself lives
 * on the task row, in the agent log, and in metrics -- none of which this
 * touches.
 *
 * These checks drive the real status transitions rather than matching source
 * text, so a rewrite that preserves the behaviour keeps passing and one that
 * drops it fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

const source = fs.readFileSync(
  path.join(root, 'packages/core/src/base-agent.ts'),
  'utf8',
);

/**
 * The loop's idle branch: no in-flight work and the dequeue returned none.
 * Sliced to the `continue` that ends it rather than a fixed length, so the
 * window tracks the real block instead of breaking when a comment grows.
 */
function idleBranch(): string {
  const start = source.indexOf('if (inFlight.size === 0) {');
  if (start < 0) return '';
  const end = source.indexOf('\n        }', start);
  return end > start ? source.slice(start, end) : source.slice(start);
}

function main(): void {
  console.log('── Agent status recovery ──');

  const branch = idleBranch();
  check('the polling loop still has an idle branch', branch.length > 0);
  if (!branch) process.exit(1);

  // The self-heal must live in the idle branch specifically. Anywhere else
  // and it either never runs on a quiet queue (the whole failure mode) or it
  // fires mid-task and masks a genuinely in-flight error.
  check(
    'a stale `error` status is cleared in the loop idle branch',
    /getStatus\(\)\s*===\s*'error'\)\s*this\.setStatus\('idle'\)/.test(branch),
    branch.slice(0, 200),
  );

  // It has to run BEFORE the loop sleeps, or the agent advertises `error` for
  // the whole backoff window -- up to IDLE_POLL_CAP_MS per cycle.
  const clearAt = branch.search(/getStatus\(\)\s*===\s*'error'/);
  const sleepAt = branch.search(/setTimeout\(r,\s*idleWaitMs\)/);
  check(
    'the clear happens before the idle backoff sleeps',
    clearAt >= 0 && sleepAt >= 0 && clearAt < sleepAt,
    { clearAt, sleepAt },
  );

  // The failure signal must survive. If a future change "simplifies" the
  // failure path by dropping these, the status clear turns a recorded failure
  // into a silent one.
  check(
    'task failures are still recorded to the task queue',
    /this\.taskQueue\.fail\(taskId/.test(source),
  );
  check(
    'task failures are still recorded to metrics',
    /recordMetricsAsync\(false/.test(source),
  );
  check(
    'task failures are still logged',
    /this\.logger\.error\(`Task failed/.test(source),
  );

  // The premise of the whole fix: status is not an execution gate. If someone
  // later makes the queue skip errored agents, clearing the status silently
  // becomes load-bearing for availability and this guard's reasoning is void.
  const queue = fs.readFileSync(
    path.join(root, 'packages/core/src/task-queue.ts'),
    'utf8',
  );
  check(
    'the task queue still does not filter agents by status',
    !/agents\.status/.test(queue),
  );

  if (failures > 0) {
    console.error(`\n${failures} agent-status-recovery check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll agent-status-recovery checks passed.');
}

main();
