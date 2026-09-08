// ─── Guard: the soft deadline actually sits below the hard timeout ───────────
//
// Behavioural half: resolveHardTimeoutMs/resolveSoftDeadlineMs against every
// combination of job/non-job runtime and env overrides, including malicious/
// malformed env values.
// Source half: start()'s Promise.race and executeTask() derive their timeouts
// from the same shared function, so the two can never silently drift apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHardTimeoutMs, resolveSoftDeadlineMs } from '../packages/core/src/base-agent.js';

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

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

console.log('── Hard timeout resolution ──');
withEnv({ APEX_TASK_HARD_TIMEOUT_MS: undefined, EXECUTOR_TASK_HARD_TIMEOUT_MS: undefined }, () => {
  check('default non-job hard timeout is 10 minutes', resolveHardTimeoutMs({}) === 10 * 60 * 1000);
  check('default non-job hard timeout applies with no context at all', resolveHardTimeoutMs(null) === 10 * 60 * 1000);
  check('default job-runtime hard timeout is 55 minutes', resolveHardTimeoutMs({ runtime: 'job' }) === 55 * 60 * 1000);
  check('a runtime value other than "job" is treated as ordinary', resolveHardTimeoutMs({ runtime: 'process' }) === 10 * 60 * 1000);
});
withEnv({ APEX_TASK_HARD_TIMEOUT_MS: '120000' }, () => {
  check('non-job hard timeout is operator-configurable', resolveHardTimeoutMs({}) === 120_000);
});
withEnv({ EXECUTOR_TASK_HARD_TIMEOUT_MS: '600000' }, () => {
  check('job-runtime hard timeout is independently operator-configurable', resolveHardTimeoutMs({ runtime: 'job' }) === 600_000);
});

console.log('\n── Soft deadline resolution ──');
withEnv({ APEX_SOFT_TIMEOUT_RATIO: undefined }, () => {
  const hard = 10 * 60 * 1000;
  check('default soft deadline is 70% of the hard timeout', resolveSoftDeadlineMs(hard) === Math.floor(hard * 0.7));
  check('soft deadline is always strictly less than the hard timeout by default', resolveSoftDeadlineMs(hard) < hard);
});
withEnv({ APEX_SOFT_TIMEOUT_RATIO: '0.5' }, () => {
  check('ratio is operator-configurable', resolveSoftDeadlineMs(1000) === 500);
});
withEnv({ APEX_SOFT_TIMEOUT_RATIO: '0.99' }, () => {
  check('an unreasonably high ratio is clamped so a checkpoint can still be written before the race fires', resolveSoftDeadlineMs(1000) <= 950);
});
withEnv({ APEX_SOFT_TIMEOUT_RATIO: '0.01' }, () => {
  check('an unreasonably low ratio is clamped so tasks are not starved of real work time', resolveSoftDeadlineMs(1000) >= 300);
});
withEnv({ APEX_SOFT_TIMEOUT_RATIO: 'not-a-number' }, () => {
  check('a non-numeric ratio falls back to the default rather than producing NaN', resolveSoftDeadlineMs(1000) === 700);
});
withEnv({ APEX_SOFT_TIMEOUT_RATIO: '-1' }, () => {
  check('a negative ratio is clamped rather than producing a negative/zero deadline', resolveSoftDeadlineMs(1000) >= 300);
});

console.log('\n── start() and executeTask() cannot silently drift apart (source) ──');
const agentSource = fs.readFileSync(path.join(root, 'packages/core/src/base-agent.ts'), 'utf8');
check('start()\'s hard-timeout race uses the shared resolver',
  agentSource.includes('const TASK_HARD_TIMEOUT_MS = resolveHardTimeoutMs(task.context);'));
check('executeTask() derives its own hard timeout from the same shared resolver',
  agentSource.includes('const hardTimeoutMs = resolveHardTimeoutMs(context);'));
check('executeTask() derives the soft deadline from that same hard timeout, not an independent constant',
  agentSource.includes('const softDeadlineMs = resolveSoftDeadlineMs(hardTimeoutMs);'));
check('resolveHardTimeoutMs and resolveSoftDeadlineMs are exported (single source of truth, testable in isolation)',
  agentSource.includes('export function resolveHardTimeoutMs(') && agentSource.includes('export function resolveSoftDeadlineMs('));

console.log(failures === 0 ? '\n✅ ALL SOFT-DEADLINE GUARDS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
