// ─── Integration scenario: create work → worker starts it → worker disappears
// → replacement worker resumes → exactly one final side effect → completes ──
//
// SCOPE, STATED HONESTLY: this drives the real TaskQueue methods
// (enqueue/dequeue/checkpointAndResume/complete) that every worker process —
// HTTP control plane or standalone start:worker — actually calls, and it
// proves the same ownership guard that makes duplicate completion impossible
// in production. What it does NOT do is spawn two real OS processes against
// one real Postgres instance; CI has no database, and the in-memory fallback
// this script drives (see verify-task-ownership-transitions.ts) is
// deliberately per-TaskQueue-instance, not shared across processes — that is
// exactly why production requires Postgres for durability. Two workers are
// simulated here as two sequential callers against the SAME TaskQueue
// instance, standing in for what would be two real processes sharing one
// Postgres table. The full multi-process/real-Postgres version of this
// scenario is the no-browser acceptance test already required by
// docs/DURABLE_AUTONOMY_OPERATIONS.md — this script is what CI can prove
// without that infrastructure, not a replacement for it.

process.env.NODE_ENV = 'test';
process.env.APEX_ALLOW_EPHEMERAL_QUEUE_FALLBACK = '1';

import { randomUUID } from 'node:crypto';
import { TaskQueue } from '../packages/core/src/task-queue.js';
import { buildCheckpoint, extractCheckpointHistory, mergeCheckpointIntoContext, priorYieldCountFromContext, isResumableCheckpoint } from '../packages/core/src/task-checkpoint.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

type MemTask = { id: string; status: string; context: Record<string, unknown> | null; retryCount: number; leasedAt: Date | null; result: string | null };
function memoryQueueOf(queue: TaskQueue): MemTask[] {
  return (queue as unknown as { memoryQueue: MemTask[] }).memoryQueue;
}

async function scenarioCleanYieldThenResume(): Promise<void> {
  console.log('── Scenario A: worker yields cleanly (soft deadline) before disappearing ──');

  // The shared durable store both "workers" claim from — see the scope note
  // above for why this is one instance rather than two real processes.
  const sharedQueue = new TaskQueue('apex-lead-research-001');

  // 1. Create work.
  const created = await sharedQueue.enqueue({ title: 'Research 50 leads', description: 'Find and qualify leads.' });
  check('work is created pending', created.status === 'pending');

  // 2. Worker A starts it.
  const claimedByA = await sharedQueue.dequeue();
  check('worker A claims the task', claimedByA !== null && claimedByA.id === created.id && claimedByA.status === 'in_progress');

  // 3. Worker A makes real, observed progress, then hits its soft deadline
  //    and checkpoints instead of finishing the external side effect
  //    (saving the lead) it was about to perform.
  const executionIdA = randomUUID();
  const checkpoint = buildCheckpoint({
    taskId: created.id,
    executionId: executionIdA,
    goalId: null,
    agentId: 'apex-lead-research-001',
    history: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Research 50 leads' },
      { role: 'assistant', content: 'Found 12 qualifying businesses so far; about to save the first batch.' },
    ],
    completedSteps: ['searchBusinessDirectory(industry=hvac)'],
    findings: ['searchBusinessDirectory(industry=hvac)'],
    decisions: [], // the save itself has NOT happened yet — this is the whole point
    unresolvedBlockers: [],
    approvalRequirement: false,
    iterationsUsed: 8,
    toolExecutions: 3,
    maxIterations: 20,
    priorYieldCount: 0,
    reason: 'soft_deadline',
  });
  const yielded = await sharedQueue.checkpointAndResume(created.id, mergeCheckpointIntoContext(claimedByA!.context, checkpoint));
  check('worker A\'s checkpoint is durably saved and the task returns to pending', yielded === true);
  const afterYield = memoryQueueOf(sharedQueue).find((t) => t.id === created.id)!;
  check('the task is pending again, not stuck in_progress with no owner', afterYield.status === 'pending');

  // 4. Worker A disappears. Nothing more happens on its behalf — no complete()
  //    or fail() call is ever made for executionIdA.

  // 5. Replacement worker B starts and claims the SAME task.
  const claimedByB = await sharedQueue.dequeue();
  check('worker B claims the same task after A disappeared', claimedByB !== null && claimedByB.id === created.id);

  // 6. Worker B resumes from the real checkpoint A left behind.
  const resumedCheckpoint = claimedByB!.context?.checkpoint;
  check('the checkpoint worker B sees is the exact one worker A wrote (not fabricated, not lost)',
    isResumableCheckpoint(resumedCheckpoint) && resumedCheckpoint.executionId === executionIdA);
  check('worker B can restore the exact conversation A was having', (() => {
    if (!isResumableCheckpoint(resumedCheckpoint)) return false;
    const history = extractCheckpointHistory(resumedCheckpoint);
    return history.some((m) => m.content.includes('Found 12 qualifying businesses'));
  })());
  check('worker B knows this is a resumed slice, not a fresh task', priorYieldCountFromContext(claimedByB!.context) === 1);
  check('the pending external side effect (saving leads) had genuinely not happened yet',
    isResumableCheckpoint(resumedCheckpoint) && resumedCheckpoint.decisions.length === 0);

  // 7. Worker B does the work A never finished and completes the task ONCE.
  await sharedQueue.complete(created.id, 'Saved 12 leads.');
  const completed = memoryQueueOf(sharedQueue).find((t) => t.id === created.id)!;
  check('the task is done after worker B finishes it', completed.status === 'done' && completed.result === 'Saved 12 leads.');

  // 8. EXACTLY ONE final side effect: a late/duplicate completion attempt
  //    (e.g. a zombie worker A somehow still running) must be rejected.
  let duplicateRejected = false;
  try {
    await sharedQueue.complete(created.id, 'Saved 12 leads (duplicate attempt).');
  } catch (err) {
    duplicateRejected = err instanceof Error && err.message.includes('no longer owned by this execution state');
  }
  check('a second completion attempt for the same task is rejected, not accepted as a duplicate success', duplicateRejected);
  check('the duplicate attempt did not overwrite the real result', memoryQueueOf(sharedQueue).find((t) => t.id === created.id)!.result === 'Saved 12 leads.');
}

async function scenarioHardCrashLeaseRecovery(): Promise<void> {
  console.log('\n── Scenario B: worker vanishes with no checkpoint (hard crash, lease expires) ──');

  const sharedQueue = new TaskQueue('apex-backend-001');
  const created = await sharedQueue.enqueue({ title: 'Fix flaky test', description: 'Investigate and fix.' });
  const claimedByA = await sharedQueue.dequeue();
  check('worker A claims the task', claimedByA !== null);

  // Worker A vanishes with zero warning: no checkpoint, no fail(), nothing.
  // Simulate what recoverStaleLeasedTasks() (packages/api-server/src/bootstrap-jobs.ts,
  // run by every runtime via the shared bootstrap) does at the row level once
  // the lease is stale: requeue with retryCount incremented. That function
  // itself is DB-only (no memory-fallback path, unlike TaskQueue) so it is
  // not directly callable in a Postgres-less CI run; this reproduces its
  // documented effect on the row so the ownership guarantee downstream of
  // recovery — the actual point of this scenario — is still exercised for
  // real rather than assumed.
  const row = memoryQueueOf(sharedQueue).find((t) => t.id === created.id)!;
  check('the row is in_progress with a lease before recovery', row.status === 'in_progress' && row.leasedAt !== null);
  row.leasedAt = new Date(Date.now() - 15 * 60 * 1000); // 15 min old > 10 min stale threshold
  row.status = 'pending';
  row.retryCount += 1;

  const claimedByB = await sharedQueue.dequeue();
  check('worker B claims the recovered task', claimedByB !== null && claimedByB.id === created.id);
  check('worker B sees the incremented retry count (crash was not free)', claimedByB!.retryCount === 1);

  await sharedQueue.complete(created.id, 'Fixed.');
  check('worker B completes the recovered task', memoryQueueOf(sharedQueue).find((t) => t.id === created.id)!.status === 'done');

  let duplicateRejected = false;
  try {
    await sharedQueue.complete(created.id, 'Fixed (duplicate).');
  } catch {
    duplicateRejected = true;
  }
  check('a duplicate completion after crash recovery is still rejected — exactly one side effect', duplicateRejected);
}

async function main(): Promise<void> {
  await scenarioCleanYieldThenResume();
  await scenarioHardCrashLeaseRecovery();
  console.log(failures === 0 ? '\n✅ CRASH-RECOVERY INTEGRATION SCENARIO PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
