/**
 * 2026-10-22 throughput fixes:
 *  (a) a task that keeps hitting the capacity pause is parked as `blocked`
 *      after APEX_CAPACITY_DEFER_LIMIT (default 20) defers instead of looping
 *      forever, and no claim path hands out work while the pause is active;
 *  (b) operator/Command chat has a reserved lane that is exempt from the
 *      workspace capacity pause, with its own small budget, and only adds the
 *      paid route while the daily spend cap has headroom.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  nextCapacityDeferState,
  capacityDeferLimit,
  CAPACITY_DEFER_LIMIT_DEFAULT,
  CAPACITY_DEFER_BLOCK_PREFIX,
  TaskQueue,
  taskClaimPausedMs,
} from '../packages/core/src/task-queue.js';
import {
  __resetCapacityLatchForTest,
  __setCapacityLatchForTest,
} from '../packages/core/src/base-agent.js';
import {
  tryEnterOperatorLane,
  operatorLaneProviderOrder,
  getOperatorLaneStats,
  __resetOperatorLaneForTest,
} from '../packages/core/src/operator-lane.js';

const root = process.env.GITHUB_WORKSPACE ??
  (fs.existsSync(path.join(process.cwd(), 'packages/core')) ? process.cwd() : path.resolve(process.cwd(), '../..'));
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  console.log(`  ok  ${label}`);
}

async function main() {
  console.log('── (a) capacity defer counter ──');
  delete process.env.APEX_CAPACITY_DEFER_LIMIT;
  check('default limit is 20', capacityDeferLimit() === 20 && CAPACITY_DEFER_LIMIT_DEFAULT === 20);
  process.env.APEX_CAPACITY_DEFER_LIMIT = 'garbage';
  check('invalid env falls back to 20', capacityDeferLimit() === 20);
  delete process.env.APEX_CAPACITY_DEFER_LIMIT;

  let ctx: unknown = { workBundle: { scope: 'x' } };
  let state = nextCapacityDeferState(ctx, 'capacity pause');
  check('first defer counts 1 and preserves context', state.count === 1 && !state.exhausted &&
    (state.context.workBundle as { scope: string }).scope === 'x');
  for (let i = 2; i <= 19; i++) {
    state = nextCapacityDeferState(state.context, 'capacity pause');
  }
  check('19 defers still pending', state.count === 19 && !state.exhausted && state.reason === null);
  state = nextCapacityDeferState(state.context, 'capacity pause until X');
  check('20th defer is exhausted with a block reason', state.count === 20 && state.exhausted &&
    (state.reason ?? '').startsWith(CAPACITY_DEFER_BLOCK_PREFIX));
  check('null/array context handled', nextCapacityDeferState(null, 'e').count === 1 &&
    nextCapacityDeferState([1, 2], 'e').count === 1);

  // In-memory fail() path (no DB in this harness → local fallback).
  process.env.APEX_ALLOW_EPHEMERAL_QUEUE_FALLBACK = 'true';
  const queue = new TaskQueue('verify-agent');
  const mem = (queue as unknown as { memoryQueue: Array<Record<string, unknown>> }).memoryQueue;
  if (Array.isArray(mem)) {
    const task = { id: 'cap-defer-1', status: 'in_progress', context: { capacityDeferCount: 19 }, errorMessage: null, nextRetryAt: null, leasedAt: new Date() };
    mem.push(task);
    const pauseMsg = 'LLM spend is paused until the UTC daily reset';
    await queue.fail('cap-defer-1', pauseMsg);
    check('in-memory fail() blocks after the 20th capacity defer', task.status === 'blocked' &&
      String(task.errorMessage).startsWith(CAPACITY_DEFER_BLOCK_PREFIX) &&
      (task.context as { capacityDeferCount: number }).capacityDeferCount === 20);
    const t2 = { id: 'cap-defer-2', status: 'in_progress', context: null, errorMessage: null, nextRetryAt: null, leasedAt: new Date() };
    mem.push(t2);
    await queue.fail('cap-defer-2', pauseMsg);
    check('in-memory fail() below the limit re-queues as pending with count 1', t2.status === 'pending' &&
      (t2.context as unknown as { capacityDeferCount: number }).capacityDeferCount === 1 && t2.nextRetryAt !== null);
  }
  delete process.env.APEX_ALLOW_EPHEMERAL_QUEUE_FALLBACK;

  console.log('── (a) claims skip during a capacity pause ──');
  __resetCapacityLatchForTest();
  check('no pause → claim gate open', taskClaimPausedMs() === 0);
  __setCapacityLatchForTest(Date.now() + 60_000);
  check('active pause → claim gate closed', taskClaimPausedMs() > 0);
  check('dequeue returns null during pause', (await queue.dequeue()) === null);
  check('claimById returns null during pause', (await queue.claimById('anything')) === null);
  __resetCapacityLatchForTest();

  const qsrc = read('packages/core/src/task-queue.ts');
  check('durable fail() writes blocked + reason on exhaustion',
    qsrc.includes('const defer = nextCapacityDeferState(task.context, error);') &&
    qsrc.includes("reason: 'capacity_defer_limit'"));

  console.log('── (b) operator lane ──');
  __resetOperatorLaneForTest();
  process.env.APEX_OPERATOR_LLM_CONCURRENCY = '2';
  process.env.APEX_OPERATOR_DAILY_REQUESTS = '3';
  const a = tryEnterOperatorLane();
  const b = tryEnterOperatorLane();
  check('lane admits up to its own concurrency', a !== null && b !== null);
  check('lane refuses past its concurrency (falls back to governed path)', tryEnterOperatorLane() === null);
  a!.release(); a!.release();
  check('release is idempotent', getOperatorLaneStats().active === 1);
  const c = tryEnterOperatorLane();
  check('slot reusable after release', c !== null);
  c!.release(); b!.release();
  check('daily budget enforced', tryEnterOperatorLane() === null && getOperatorLaneStats().requestsToday === 3);
  check('budget resets on UTC rollover', tryEnterOperatorLane(Date.now() + 86_400_000) !== null);
  __resetOperatorLaneForTest();
  delete process.env.APEX_OPERATOR_LLM_CONCURRENCY;
  delete process.env.APEX_OPERATOR_DAILY_REQUESTS;

  const base = ['free-a', 'free-b'] as const;
  check('paid route appended only with spend headroom',
    JSON.stringify(operatorLaneProviderOrder<string>(base, ['paid'], true)) === '["free-a","free-b","paid"]');
  check('paid route never added (and removed) when daily cap is spent',
    JSON.stringify(operatorLaneProviderOrder<string>([...base, 'paid'], ['paid'], false)) === '["free-a","free-b"]');

  const llm = read('packages/core/src/llm-client.ts');
  check('LLM client uses the lane for operatorLane calls',
    llm.includes('execution?.operatorLane ? tryEnterOperatorLane() : null') &&
    llm.includes('if (!operatorLane) await acquireLLMConcurrencySlot();'));
  check('lane is exempt from workspace token pacing only; emergency hard cap still applies',
    llm.includes('if (!emergencyWindow.allowed) {') &&
    llm.includes('if (!operatorLane && !totalReservation.allowed)'));
  check('paid route gated by the daily spend ledger', llm.includes('paidSpendAvailable(),'));
  check('Command chat opts into the lane', read('packages/api-server/src/routes/chat.ts').includes('operatorLane: true'));

  console.log('\n✅ capacity defer cap + operator lane verified');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
