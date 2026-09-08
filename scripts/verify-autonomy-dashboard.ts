// ─── Guard: the autonomy dashboard exposes real, non-fabricated metrics ──────
//
// Static by design (no DB) — the metric-shape and wiring invariants can be
// verified from source: the route computes every field from a durable query
// or a clearly-labeled process-local counter (never a literal placeholder),
// and it is mounted behind requireAdminAuth like every other /api route.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const route = fs.readFileSync(path.join(root, 'packages/api-server/src/routes/autonomy.ts'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'packages/api-server/src/index.ts'), 'utf8');

console.log('── Mounting and access control ──');
check('createAutonomyRouter is exported', route.includes('export function createAutonomyRouter()'));
check('index.ts mounts it under /api/autonomy', indexSource.includes("app.use('/api/autonomy', createAutonomyRouter())"));
check('the mount happens after the /api requireAdminAuth gate, not before', (() => {
  const gateIdx = indexSource.indexOf("app.use('/api', requireAdminAuth)");
  const mountIdx = indexSource.indexOf("app.use('/api/autonomy', createAutonomyRouter())");
  return gateIdx >= 0 && mountIdx > gateIdx;
})());
check('a query failure returns 500 with the real error, never a fabricated healthy payload',
  route.includes('res.status(500).json({ error:'));

console.log('\n── Required metrics are each backed by a real query or counter, not a placeholder ──');
const requiredSignals: Array<[string, string]> = [
  ['healthy autonomous workers', 'heartbeats.healthyWorkerCount'],
  ['heartbeat age', 'oldestHeartbeatAgeSeconds'],
  ['active agents', 'liveness.alive'],
  ['pending tasks', "eq(tasks.status, 'pending')"],
  ['oldest pending task', 'oldestPendingRow'],
  ['resumed tasks (durable)', 'resumedRow'],
  ['checkpoints created (durable)', 'checkpointRows'],
  ['tasks soft-yielded (process-local counter)', 'counters.tasksSoftYielded'],
  ['hard-timeout quarantines (both durable count and counter)', 'quarantinedRow'],
  ['stuck/blocked tasks', 'blockedRow'],
  ['executor jobs', 'executorSummary'],
  ['retry backlog', 'retryBacklogRow'],
  ['pending approvals', 'pendingApprovalsRow'],
  ['throughput over 1h', 'throughput1h'],
  ['throughput over 24h', 'throughput24h'],
  ['completed goals', 'goalCounts.completed'],
  ['failed goals', 'goalCounts.failed'],
  ['duplicate-side-effect prevention events', 'duplicateSideEffectsPrevented'],
];
for (const [label, needle] of requiredSignals) {
  check(`${label} is present`, route.includes(needle));
}

console.log('\n── Duplicate-side-effect prevention is wired to real guard events, not invented ──');
const baseAgentSource = fs.readFileSync(path.join(root, 'packages/core/src/base-agent.ts'), 'utf8');
const instrumentedSource = fs.readFileSync(path.join(root, 'packages/core/src/instrumented-base-agent.ts'), 'utf8');
check('a real prevented duplicate: refusing to run approved work after losing task ownership',
  baseAgentSource.includes('recordDuplicateSideEffectPrevented();') &&
  baseAgentSource.includes('refusing to continue approved work'));
check('a real prevented duplicate: the unique-index-backed duplicate-delegation skip',
  baseAgentSource.includes('Skipping duplicate task'));
check('a real prevented duplicate: losing the compare-and-set race to consume an approval decision',
  instrumentedSource.includes('recordDuplicateSideEffectPrevented();') &&
  instrumentedSource.includes('already consumed this exact decision first'));

console.log('\n── Counters live in runtime-health.ts, not duplicated ad-hoc ──');
const runtimeHealthSource = fs.readFileSync(path.join(root, 'packages/core/src/runtime-health.ts'), 'utf8');
for (const fn of ['recordCheckpointCreated', 'recordTaskSoftYielded', 'recordTaskResumedFromCheckpoint', 'recordApprovalYield', 'recordHardTimeoutQuarantine', 'recordHeavyWorkRoutedToExecutor', 'recordDuplicateSideEffectPrevented', 'getAutonomyCounters']) {
  check(`runtime-health.ts exports ${fn}`, runtimeHealthSource.includes(`export function ${fn}`));
}

console.log(failures === 0 ? '\n✅ ALL AUTONOMY DASHBOARD GUARDS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
