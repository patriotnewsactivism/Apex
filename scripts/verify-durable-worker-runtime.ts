import fs from 'node:fs';
import path from 'node:path';
import { checkAgentLoopSupervision } from './verify-agent-loop-supervision.js';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const worker = fs.readFileSync(path.join(root, 'packages/api-server/src/worker.ts'), 'utf8');
// Phase 5 of the autonomous-OS upgrade extracted the workforce/scheduler/
// supervisor wiring both entrypoints need into one shared routine (see its
// doc comment for why: worker.ts previously built these directly and silently
// diverged from index.ts, skipping settings load, lease recovery, job
// seeding, the campaign runner, and executor dispatch entirely). worker.ts
// now only has to call it; the invariants that used to be checked inline here
// are checked against the shared module instead.
const bootstrap = fs.readFileSync(path.join(root, 'packages/api-server/src/runtime-bootstrap.ts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/api-server/package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const adr = fs.readFileSync(path.join(root, 'docs/ARCHITECTURE_DECISIONS.md'), 'utf8');

// Source guards should inspect executable source, not fail because a safety
// comment explicitly names the operation it forbids (for example,
// "Do not call migrate() here"). This deliberately strips comments only for
// the negative management-operation check below; the other assertions still
// inspect the original source text.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const executableWorker = stripComments(worker);

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) failures++;
}

console.log('── Dedicated autonomous worker ──');
check('worker has an explicit production command', pkg.scripts?.['start:worker'] === 'tsx src/worker.ts');
check('worker uses the shared runtime bootstrap', worker.includes('bootstrapApexRuntime('));
check('the shared bootstrap uses the governed workforce factory', bootstrap.includes('createWorkforce('));
check('the shared bootstrap initializes the governed workforce', bootstrap.includes('initializeWorkforce(workforce)'));
check('the shared bootstrap starts the governed JobScheduler', bootstrap.includes('new JobScheduler()') && bootstrap.includes('scheduler.start()'));
check('worker performs a durable DB probe before bootstrapping the workforce', (() => {
  const probe = worker.indexOf('await assertDurableDatabaseReady()');
  const bootstrapCall = worker.indexOf('bootstrapApexRuntime(');
  return probe >= 0 && bootstrapCall > probe;
})());
check('worker does not invoke migration management code',
  !executableWorker.includes('migrate(') && !executableWorker.includes('runMigrations('));
check('the shared bootstrap does not invoke migration management code either',
  !stripComments(bootstrap).includes('migrate(') && !stripComments(bootstrap).includes('runMigrations('));
check('worker handles Cloud Run termination signals',
  worker.includes("process.once('SIGTERM'") && worker.includes("process.once('SIGINT'"));
// Agent loops are now stopped through their supervisor handle (which calls
// agent.stop() and cancels any pending restart), not by touching each agent
// directly — a direct agent.stop() would race a queued supervisor restart.
check('the shared bootstrap stops scheduler and agent claim loops on shutdown',
  bootstrap.includes('scheduler.stop()') &&
  bootstrap.includes('for (const supervisor of supervisors) supervisor.stop()'));
check('worker routes its shutdown signal through the shared bootstrap', worker.includes('bootstrap.shutdown('));
check('worker does not force successful process exit during shutdown', !executableWorker.includes('process.exit(0)'));

console.log('\n── Architecture guard ──');
check('ADR explicitly rejects browser/request/timer authority',
  adr.includes('Browser-independent autonomy requires a durable Cloud Run execution source'));
check('ADR documents the dedicated worker command',
  adr.includes('pnpm --filter @workspace/api-server run start:worker'));
check('ADR forbids guessed resource provisioning',
  adr.includes('does **not** guess or silently create a GCP resource'));
check('ADR requires a no-browser acceptance test', adr.includes('no-browser acceptance test'));

// Durable no-browser autonomy only holds if the worker's agent loops actually
// stay alive. (Promise chain rather than top-level await: this script is
// transformed to CJS, which does not support top-level await.)
void checkAgentLoopSupervision().then((supervisionFailures) => {
  failures += supervisionFailures;

  if (failures > 0) {
    console.error(`\n❌ Durable worker runtime guard failed: ${failures} invariant(s) missing`);
    process.exit(1);
  }

  console.log('\n✅ Durable worker runtime source invariants verified');
});
