/** Deterministic Phase-4 guard: executor dispatch wiring.
 *
 * Static by design (no gcloud, no DB, no bucket): asserts the claim-by-id
 * lease exists on TaskQueue, the runtime='job' exclusion is present in the
 * dequeue path, and the executor package exports its entrypoint + dispatch
 * functions. CI catches a refactor that silently unhooks the sandbox.
 *
 * Usage: pnpm --filter @workspace/executor exec tsx scripts/verify-executor-dispatch.ts
 */
import { readFile } from 'fs/promises';
import { TaskQueue } from '../packages/core/src/task-queue.js';
import { dispatchDueExecutorTasks, startExecutorDispatchLoop, getExecutorJobStatus, executorDispatchConfig } from '../packages/executor/src/index.js';
import { ExecutorAgent, executorTools, executorMaxTurns } from '../packages/executor/src/main.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label} ${detail !== undefined ? JSON.stringify(detail) : ''}`);
  if (!ok) failures++;
};

async function main() {
  console.log('── TaskQueue claim-by-id lease ──');
  const queue = new TaskQueue('apex-executor-001');
  check('claimById is a function', typeof queue.claimById === 'function');

  const source = await readFile(new URL('../packages/core/src/task-queue.ts', import.meta.url), 'utf8');
  check('dequeue excludes runtime=job tasks', source.includes(`context}->>'runtime' IS DISTINCT FROM 'job'`));
  check('claimById present in source', source.includes('async claimById(taskId'));

  const apiSource = await readFile(new URL('../packages/api-server/src/index.ts', import.meta.url), 'utf8');
  const bootstrapSource = await readFile(new URL('../packages/api-server/src/runtime-bootstrap.ts', import.meta.url), 'utf8');
  const bootstrapJobsSource = await readFile(new URL('../packages/api-server/src/bootstrap-jobs.ts', import.meta.url), 'utf8');
  check('the shared runtime bootstrap starts the dispatch loop (both entrypoints get it)', bootstrapSource.includes('startExecutorDispatchLoop'));
  check(
    'api-server no longer duplicates dispatch-loop startup outside the shared bootstrap',
    !apiSource.includes('startExecutorDispatchLoop'),
  );
  check(
    'lease recovery (shared by both entrypoints via bootstrap-jobs.ts) excludes runtime=job',
    bootstrapJobsSource.includes(`context}->>'runtime' IS DISTINCT FROM 'job'`),
  );

  console.log('\n── executor package surface ──');
  check('dispatchDueExecutorTasks exported', typeof dispatchDueExecutorTasks === 'function');
  check('startExecutorDispatchLoop exported', typeof startExecutorDispatchLoop === 'function');
  check('getExecutorJobStatus exported', typeof getExecutorJobStatus === 'function');
  check('executorDispatchConfig exported', typeof executorDispatchConfig === 'function');
  check('ExecutorAgent constructible', typeof ExecutorAgent === 'function');
  check('executorTools returns an allowlist', Array.isArray(executorTools()) && executorTools().length >= 20);
  check('executorMaxTurns bounded', executorMaxTurns() >= 1);

  const mainSource = await readFile(new URL('../packages/executor/src/main.ts', import.meta.url), 'utf8');
  check('main.ts calls claimById before executing', mainSource.includes('claimById(taskId)'));
  check('main.ts pulls the workspace', mainSource.includes('pullWorkspace'));
  check('main.ts pushes the workspace', mainSource.includes('pushWorkspace'));
  check('main.ts respects EXECUTOR_ALLOW_RUNSHELL', mainSource.includes('EXECUTOR_ALLOW_RUNSHELL'));

  const dispatchSource = await readFile(new URL('../packages/executor/src/dispatch.ts', import.meta.url), 'utf8');
  check('dispatch fails closed without APEX_EXECUTOR_JOB', dispatchSource.includes('APEX_EXECUTOR_JOB'));
  check('dispatch is a no-op when unconfigured', dispatchSource.includes('no-op loop'));

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});