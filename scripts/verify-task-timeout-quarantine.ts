import fs from 'node:fs';
import path from 'node:path';
import { checkTaskOwnershipTransitions } from './verify-task-ownership-transitions.js';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const queue = fs.readFileSync(path.join(root, 'packages/core/src/task-queue.ts'), 'utf8');
const agent = fs.readFileSync(path.join(root, 'packages/core/src/base-agent.ts'), 'utf8');

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) failures++;
}

console.log('── Hard timeout quarantine ──');
check('BaseAgent still reports the hard timeout through TaskQueue.fail',
  agent.includes("msg.includes('hard')") &&
  agent.includes("msg.includes('wall-clock timeout')") &&
  agent.includes('await this.taskQueue.fail(task.id, msg)'));
check('TaskQueue recognizes hard wall-clock timeout failures',
  queue.includes("error.includes('Task exceeded hard')") && queue.includes('wall-clock timeout'));
check('hard timeout moves an in-progress task to blocked quarantine',
  queue.includes('TIMEOUT_QUARANTINE_PREFIX') &&
  queue.includes("status: 'blocked'") &&
  queue.includes("eq(tasks.status, 'in_progress')"));
check('quarantined timeout clears automatic retry scheduling',
  queue.includes('nextRetryAt: null') && queue.includes('Quarantined after hard task timeout:'));
check('late detached failure cannot turn quarantine back into retryable work',
  queue.includes('if (isTimeoutQuarantine(task)) return'));
check('late execution cannot resurrect cancelled/terminal task as complete',
  queue.includes('completion rejected because it is no longer owned by this execution state'));
check('same original execution may close a timeout quarantine if it truly completes',
  queue.includes("eq(tasks.status, 'blocked')") &&
  queue.includes('sql`${tasks.errorMessage} LIKE'));
check('late failure does not overwrite independently terminalized task',
  queue.includes("new Set(['done', 'failed', 'cancelled'])") &&
  queue.includes('TERMINAL_TASK_STATUSES.has(task.status)'));

// The quarantine only holds if the other lifecycle transitions cannot undo it.
// (Wrapped in a promise chain rather than top-level await: this script is
// transformed to CJS, which does not support top-level await.)
void checkTaskOwnershipTransitions().then((ownershipFailures) => {
  failures += ownershipFailures;

  if (failures > 0) {
    console.error(`\n❌ Timeout quarantine guard failed: ${failures} invariant(s) missing`);
    process.exit(1);
  }

  console.log('\n✅ Timeout quarantine source invariants verified');
});
