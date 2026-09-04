// ─── Guard: task lifecycle transitions may not resurrect withdrawn work ──────
//
// complete() and fail() carefully refuse to act on a task this execution no
// longer owns (operator cancellation, an independently terminalized row, or a
// hard-timeout quarantine whose original execution is still detached and alive).
//
// The other five transitions — block/unblock/resume/awaitApproval/
// markInProgress — used to write unconditionally by task id, which silently
// undid those guarantees:
//
//   * an approval decision arriving after an operator cancelled the task
//     flipped 'cancelled' back to 'in_progress' and the agent then executed the
//     approved (possibly irreversible) tool;
//   * markInProgress/resume could un-quarantine a hard-timeout task, recreating
//     exactly the duplicate-side-effect race the quarantine prevents.
//
// Behavioural half: exercises the real TaskQueue against its in-memory fallback
// (no Postgres needed) and asserts withdrawn tasks stay withdrawn.
// Source half: asserts the durable SQL path carries the same predicate, so the
// two paths cannot drift.

process.env.NODE_ENV = 'test';
process.env.APEX_ALLOW_EPHEMERAL_QUEUE_FALLBACK = '1';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskQueue } from '../packages/core/src/task-queue.js';

// CI invokes this through `pnpm --filter <pkg> exec`, so cwd is a package
// directory, not the repo root. Resolve from this file instead of cwd.
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

type MemTask = { id: string; status: string; errorMessage: string | null };

/** The queue falls back to its in-memory list whenever the durable write
 *  throws. CI has no Postgres, so every db call throws and the fallback path
 *  — which mirrors the SQL predicate — is what runs here. */
function memoryQueueOf(queue: TaskQueue): MemTask[] {
  return (queue as unknown as { memoryQueue: MemTask[] }).memoryQueue;
}

async function seed(status: string, errorMessage: string | null = null) {
  const queue = new TaskQueue('guard-agent');
  const task = await queue.enqueue({ title: 't', description: 'd' } as never);
  const mem = memoryQueueOf(queue);
  const row = mem.find((t) => t.id === task.id)!;
  row.status = status;
  row.errorMessage = errorMessage;
  return { queue, row };
}

const QUARANTINE = 'Quarantined after hard task timeout: Task exceeded hard 10-minute wall-clock timeout';

/** Returns the number of failed invariants. Also invoked from
 *  verify-task-timeout-quarantine.ts so CI enforces it without a workflow edit. */
export async function checkTaskOwnershipTransitions(): Promise<number> {
  failures = 0;
  console.log('── Task ownership transitions (behaviour) ──');

  for (const withdrawn of ['cancelled', 'done', 'failed']) {
    const { queue, row } = await seed(withdrawn);
    await queue.resume(row.id);
    check(`resume() cannot requeue a ${withdrawn} task`, row.status === withdrawn, row.status);

    const { queue: q2, row: r2 } = await seed(withdrawn);
    const owned = await q2.markInProgress(r2.id);
    check(
      `markInProgress() reports lost ownership for a ${withdrawn} task`,
      owned === false && r2.status === withdrawn,
      { owned, status: r2.status },
    );

    const { queue: q3, row: r3 } = await seed(withdrawn);
    await q3.unblock(r3.id);
    check(`unblock() cannot requeue a ${withdrawn} task`, r3.status === withdrawn, r3.status);

    const { queue: q4, row: r4 } = await seed(withdrawn);
    await q4.awaitApproval(r4.id);
    check(`awaitApproval() cannot reopen a ${withdrawn} task`, r4.status === withdrawn, r4.status);

    const { queue: q5, row: r5 } = await seed(withdrawn);
    await q5.block(r5.id, 'external dependency');
    check(`block() cannot reopen a ${withdrawn} task`, r5.status === withdrawn, r5.status);
  }

  // Hard-timeout quarantine: the original execution may still be alive.
  const { queue: qq, row: rq } = await seed('blocked', QUARANTINE);
  const ownedQ = await qq.markInProgress(rq.id);
  check(
    'markInProgress() refuses to un-quarantine a hard-timeout task',
    ownedQ === false && rq.status === 'blocked' && rq.errorMessage === QUARANTINE,
    { ownedQ, status: rq.status },
  );

  const { queue: qq2, row: rq2 } = await seed('blocked', QUARANTINE);
  await qq2.resume(rq2.id);
  check(
    'resume() refuses to un-quarantine a hard-timeout task',
    rq2.status === 'blocked',
    rq2.status,
  );

  const { queue: qq3, row: rq3 } = await seed('blocked', QUARANTINE);
  await qq3.unblock(rq3.id);
  check('unblock() refuses to un-quarantine a hard-timeout task', rq3.status === 'blocked', rq3.status);

  // Ordinary live work must still transition normally — the guard must not
  // freeze the queue it is protecting.
  const { queue: live, row: liveRow } = await seed('awaiting_approval');
  const ownedLive = await live.markInProgress(liveRow.id);
  check(
    'markInProgress() still restores a task waiting on approval',
    ownedLive === true && liveRow.status === 'in_progress',
    { ownedLive, status: liveRow.status },
  );

  const { queue: blocked, row: blockedRow } = await seed('blocked', 'waiting on vendor API');
  await blocked.unblock(blockedRow.id);
  check(
    'unblock() still returns an ordinarily blocked task to the queue',
    blockedRow.status === 'pending',
    blockedRow.status,
  );

  const { queue: nullBlocked, row: nullBlockedRow } = await seed('blocked', null);
  await nullBlocked.unblock(nullBlockedRow.id);
  check(
    'a blocked task with no error message is still live and can be unblocked',
    nullBlockedRow.status === 'pending',
    nullBlockedRow.status,
  );

  const { queue: prog, row: progRow } = await seed('in_progress');
  await prog.awaitApproval(progRow.id);
  check(
    'awaitApproval() still parks live work',
    progRow.status === 'awaiting_approval',
    progRow.status,
  );

  console.log('── Durable SQL path carries the same predicate (source) ──');
  const queueSrc = fs.readFileSync(path.join(root, 'packages/core/src/task-queue.ts'), 'utf8');
  check(
    'a single liveOwnershipPredicate() expresses the SQL guard',
    queueSrc.includes('function liveOwnershipPredicate()') &&
      queueSrc.includes("NOT IN ('done', 'failed', 'cancelled')") &&
      queueSrc.includes('TIMEOUT_QUARANTINE_PREFIX'),
  );
  check(
    // Without COALESCE a blocked row with a NULL error_message makes the
    // predicate NULL, excluding it from every guarded update -- unblock() and
    // resume() would silently no-op, and the SQL path would disagree with the
    // in-memory fallback. Reachable via PATCH /api/tasks/:id.
    'the quarantine test is NULL-safe for blocked rows without an error message',
    queueSrc.includes('COALESCE(${tasks.errorMessage}, \'\')'),
  );
  for (const method of ['block', 'unblock', 'resume', 'awaitApproval', 'markInProgress']) {
    const start = queueSrc.indexOf(`async ${method}(`);
    const body = start < 0 ? '' : queueSrc.slice(start, start + 1400);
    check(
      `${method}() gates its durable UPDATE on liveOwnershipPredicate()`,
      body.includes('liveOwnershipPredicate()'),
    );
  }
  check(
    'markInProgress() returns durable ownership rather than assuming it',
    queueSrc.includes('async markInProgress(taskId: string): Promise<boolean>') &&
      queueSrc.includes('.returning({ id: tasks.id })'),
  );

  console.log('── Approval callers abort on lost ownership (source) ──');
  const baseAgent = fs.readFileSync(path.join(root, 'packages/core/src/base-agent.ts'), 'utf8');
  const instrumented = fs.readFileSync(
    path.join(root, 'packages/core/src/instrumented-base-agent.ts'),
    'utf8',
  );
  check(
    'BaseAgent throws instead of running approved work it no longer owns',
    baseAgent.includes('requireTaskOwnershipAfterApproval') &&
      baseAgent.includes('refusing to continue approved work'),
  );
  check(
    'no approval path calls markInProgress without checking ownership',
    // Bare statement form = result discarded. `const owned = await ...` inside
    // requireTaskOwnershipAfterApproval is the one legitimate call.
    !/^\s*await this\.taskQueue\.markInProgress\(/m.test(baseAgent) &&
      !/^\s*await this\.taskQueue\.markInProgress\(/m.test(instrumented),
  );
  check(
    'instrumented approval continuation uses the ownership-checked helper',
    instrumented.includes('requireTaskOwnershipAfterApproval'),
  );

  console.log(
    failures === 0
      ? '✅ ALL TASK OWNERSHIP TRANSITION GUARDS PASSED'
      : `❌ ${failures} CHECK(S) FAILED`,
  );
  return failures;
}

// Standalone: `tsx scripts/verify-task-ownership-transitions.ts`
if (process.argv[1] && process.argv[1].endsWith('verify-task-ownership-transitions.ts')) {
  void checkTaskOwnershipTransitions().then((f) => process.exit(f === 0 ? 0 : 1));
}
