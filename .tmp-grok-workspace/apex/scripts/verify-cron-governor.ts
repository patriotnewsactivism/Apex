/** Deterministic Phase-5 guard: cron governance ceilings + frequency floor.
 *
 * Pure — exercises the exported predicates from CronGovernorJob without a
 * database: the floor detection, the dynamic-job classifier, and the caps.
 *
 * Usage: pnpm --filter @workspace/core exec tsx scripts/verify-cron-governor.ts
 */
import {
  isDynamicJob,
  violatesFrequencyFloor,
  DYNAMIC_JOB_FLOOR_MINUTES,
  DEFAULT_MAX_DYNAMIC_JOBS,
  PER_WORKSTREAM_JOB_CAP,
} from '../packages/background-jobs/src/cron-governor-job.js';
import { getToolRegistry } from '../packages/core/src/tool-registry-with-base44.js';
import { scheduledJobs } from '../lib/db/src/schema.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label} ${detail !== undefined ? JSON.stringify(detail) : ''}`);
  if (!ok) failures++;
};

const now = new Date('2026-09-06T12:00:00Z');

function main(): void {
  console.log('── frequency floor (15 min minimum) ──');
  check('*/5 * * * * violates the floor', violatesFrequencyFloor('*/5 * * * *', now) === true);
  check('*/12 * * * * violates the floor', violatesFrequencyFloor('*/12 * * * *', now) === true);
  check('*/15 * * * * is exactly at the floor (allowed)', violatesFrequencyFloor('*/15 * * * *', now) === false);
  check('*/30 * * * * is above the floor', violatesFrequencyFloor('*/30 * * * *', now) === false);
  check('hourly is above the floor', violatesFrequencyFloor('0 * * * *', now) === false);
  check('daily is above the floor', violatesFrequencyFloor('0 3 * * *', now) === false);
  check('null cron (one-time job) never violates', violatesFrequencyFloor(null, now) === false);
  check('garbage cron does not throw', violatesFrequencyFloor('not-a-cron', now) === false);

  console.log('\n── dynamic-job classifier ──');
  check('payload.dynamic=true is dynamic', isDynamicJob({ id: 'x', payload: { dynamic: true }, name: 'x' }));
  check('auto-project-improvement:<id> is dynamic', isDynamicJob({ id: 'auto-project-improvement:buildmybot', payload: null, name: 'x' }));
  check('dynamic- prefix is dynamic', isDynamicJob({ id: 'dynamic-abc', payload: null, name: 'x' }));
  check('seeded system job is NOT dynamic', !isDynamicJob({ id: 'system-coo-branch-review', payload: { systemDefinitionVersion: 2 }, name: 'x' }));
  check('plain one-off is NOT dynamic', !isDynamicJob({ id: 'user-job', payload: null, name: 'x' }));

  console.log('\n── caps ──');
  check('floor constant is 15 minutes', DYNAMIC_JOB_FLOOR_MINUTES === 15);
  check('default ceiling is 25', DEFAULT_MAX_DYNAMIC_JOBS === 25);
  check('per-workstream cap is 3', PER_WORKSTREAM_JOB_CAP === 3);
  check('scheduled_jobs gained missedRuns/catchUpMode columns', 'missedRuns' in scheduledJobs && 'catchUpMode' in scheduledJobs);

  console.log('\n── schedule_task expanded enum (tool registry) ──');
  const registry = getToolRegistry(process.cwd());
  const scheduleTool = registry.get('schedule_task');
  check('schedule_task registered', Boolean(scheduleTool));
  if (scheduleTool) {
    for (const jobType of ['task_delegation', 'goal_review', 'work_generation', 'cron_governor', 'executor_dispatch', 'branch_review', 'opportunity_discovery']) {
      const parsed = scheduleTool.schema.safeParse({ name: `verify-${jobType}`, jobType });
      check(`schedule_task enum accepts ${jobType}`, parsed.success === true, parsed.success ? undefined : parsed.error?.message);
    }
    check('schedule_task mentions frequency floor', String(scheduleTool.description).includes('15-minute frequency floor'));
  }

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main();