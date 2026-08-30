import fs from 'node:fs';
import path from 'node:path';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const scheduler = read('packages/background-jobs/src/job-scheduler.ts');
const executor = read('packages/background-jobs/src/job-executor.ts');
const queue = read('packages/core/src/task-queue.ts');

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) failures++;
}

console.log('── Durable scheduled-work ownership ──');
check('scheduler no longer uses process-local runningJobs ownership', !scheduler.includes('runningJobs'));
check('scheduler exposes a finite runOnce wake primitive', scheduler.includes('async runOnce(): Promise<number>'));
check('scheduler claims active jobs by durable running status',
  scheduler.includes("eq(scheduledJobs.status, 'active')") &&
  scheduler.includes(".set({ status: 'running', updatedAt: now })"));
check('scheduler recovers stale durable claims',
  scheduler.includes('recoverStaleClaims') &&
  scheduler.includes("eq(scheduledJobs.status, 'running')") &&
  scheduler.includes("status: 'active'"));
check('scheduler does not advance nextRunAt in the claim mutation', (() => {
  const start = scheduler.indexOf('private async claim(');
  const end = scheduler.indexOf('/** Find, claim, and execute all due jobs.', start);
  if (start < 0 || end < 0) return false;
  return !scheduler.slice(start, end).includes('nextRunAt:');
})());
check('scheduler awaits all executions claimed by a cycle', scheduler.includes('await Promise.allSettled(executions)'));

console.log('\n── Scheduled executor recovery ──');
check('executor requires a durable running claim', executor.includes("job.status !== 'running'"));
check('timeout aborts cooperative work before recording retry', (() => {
  const timeout = executor.indexOf('const timeoutPromise');
  const reject = executor.indexOf('reject(new JobTimeoutError', timeout);
  const abort = executor.indexOf('abortController.abort()', timeout);
  return timeout >= 0 && abort > timeout && reject > abort;
})());
check('retryable failures release the claim back to active',
  executor.includes("status: 'active'") && executor.includes('nextRunAt: nextRetry'));

console.log('\n── Durable task queue ──');
check('production explicitly disables ephemeral queue fallback',
  queue.includes("if (process.env.NODE_ENV === 'production') return false"));
check('ephemeral fallback is opt-in only', queue.includes('APEX_ALLOW_EPHEMERAL_QUEUE_FALLBACK'));
check('DB failures fail closed unless local fallback was explicitly enabled',
  queue.includes('durable Postgres operation failed; refusing process-local fallback'));
check('task claim repeats pending predicate in the outer UPDATE', (() => {
  const dequeue = queue.indexOf('async dequeue()');
  const returning = queue.indexOf('.returning();', dequeue);
  if (dequeue < 0 || returning < 0) return false;
  const claim = queue.slice(dequeue, returning);
  return claim.includes("eq(tasks.status, 'pending')") &&
    claim.includes('eq(tasks.assignedAgentId, this.agentId)') &&
    claim.includes('or(isNull(tasks.nextRetryAt), lte(tasks.nextRetryAt, now))');
})());

if (failures > 0) {
  console.error(`\n❌ Durable autonomy guard failed: ${failures} invariant(s) missing`);
  process.exit(1);
}

console.log('\n✅ Durable autonomy source invariants verified');
