// ─── Guard: worker health is durable and cross-process, not process-local ────
//
// Behavioural half: the process-local last-task-activity tracker (pure state,
// no DB) that both the HTTP process and a standalone worker feed into their
// heartbeat row.
// Source half: the schema/migration define worker_heartbeats, both
// entrypoints start a heartbeat via the shared bootstrap, and /health exposes
// it as a field distinct from (never a substitute for) the process-local
// `workforce` liveness block — the exact gap ADR-011 flagged as unresolved.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordTaskStarted,
  recordTaskFinished,
  getLastTaskActivity,
  workerIdForThisProcess,
  touchSchedulerHeartbeat,
} from '../packages/core/src/worker-heartbeat.js';

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

console.log('── Last-task-activity tracker (behaviour, no DB) ──');
check('no activity recorded yet reports nulls', (() => {
  const a = getLastTaskActivity();
  return a.currentTaskId === null && a.lastCompletedTaskId === null;
})());
recordTaskStarted('task-a');
check('a started task becomes the current task', getLastTaskActivity().currentTaskId === 'task-a');
check('currentTaskStartedAtMs is set to a real recent timestamp', (() => {
  const ms = getLastTaskActivity().currentTaskStartedAtMs;
  return typeof ms === 'number' && Math.abs(Date.now() - ms) < 5000;
})());
recordTaskFinished('task-a');
check('a finished task clears the current-task pointer', getLastTaskActivity().currentTaskId === null);
check('a finished task becomes the last-completed task', getLastTaskActivity().lastCompletedTaskId === 'task-a');

recordTaskStarted('task-b');
recordTaskFinished('task-c'); // a different task finishing must not clobber an unrelated still-running one
check('finishing an unrelated task id does not clear a different task\'s current pointer',
  getLastTaskActivity().currentTaskId === 'task-b');
check('the unrelated finish is still recorded as the last completed', getLastTaskActivity().lastCompletedTaskId === 'task-c');
recordTaskFinished('task-b');

console.log('\n── Process identity and scheduler heartbeat ──');
check('workerIdForThisProcess is stable across calls within one process', workerIdForThisProcess() === workerIdForThisProcess());
check('touchSchedulerHeartbeat does not throw when called with no DB available', (() => {
  touchSchedulerHeartbeat();
  return true;
})());

console.log('\n── Durable schema (source) ──');
const schemaSource = fs.readFileSync(path.join(root, 'lib/db/src/schema.ts'), 'utf8');
check('worker_heartbeats table is defined', schemaSource.includes("pgTable('worker_heartbeats'"));
for (const column of ['workerId', 'kind', 'buildSha', 'startedAt', 'lastHeartbeatAt', 'agentCount', 'aliveAgentCount', 'currentTaskId', 'lastCompletedTaskId', 'schedulerHeartbeatAt', 'lastError', 'status']) {
  check(`worker_heartbeats schema carries ${column}`, schemaSource.includes(`${column}:`));
}
const clientSource = fs.readFileSync(path.join(root, 'lib/db/src/client.ts'), 'utf8');
check('the idempotent DDL creates worker_heartbeats', clientSource.includes('CREATE TABLE IF NOT EXISTS worker_heartbeats'));
check('worker_id is the primary key (one row per process lifetime, upserted)', clientSource.includes('worker_id text PRIMARY KEY'));

console.log('\n── Both entrypoints start a heartbeat via the shared bootstrap (source) ──');
const bootstrapSource = fs.readFileSync(path.join(root, 'packages/api-server/src/runtime-bootstrap.ts'), 'utf8');
check('the shared bootstrap starts a heartbeat labeled by runtime kind', bootstrapSource.includes('startWorkerHeartbeat(options.kind)'));
check('the shared bootstrap stops the heartbeat on shutdown', bootstrapSource.includes('heartbeat.stop()'));

console.log('\n── /health exposes durable worker health separately from process-local liveness (source) ──');
const indexSource = fs.readFileSync(path.join(root, 'packages/api-server/src/index.ts'), 'utf8');
check('/health reads the durable heartbeat summary', indexSource.includes('getWorkerHeartbeatSummary()'));
check('/health publishes it under its own field, not merged into `workforce`', indexSource.includes('workerHeartbeats: {'));
check('/health documents that a healthy web server must not imply healthy autonomous workers',
  (() => {
    const normalized = indexSource.replace(/\/\//g, ' ').replace(/\s+/g, ' ');
    return normalized.includes('web server being healthy must not imply that') &&
      normalized.includes('autonomous workers are healthy');
  })());
check('a durable-read failure degrades this section to unknown rather than throwing (never crashes /health)',
  fs.readFileSync(path.join(root, 'packages/core/src/worker-heartbeat.ts'), 'utf8').includes('Never throws: a failed read here must not take down /health'));

console.log(failures === 0 ? '\n✅ ALL DURABLE WORKER HEARTBEAT GUARDS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
