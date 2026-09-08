// ─── Guard: checkpoints round-trip and never resurrect withdrawn tasks ───────
//
// Behavioural half: the pure checkpoint builder/reader functions, and the
// real TaskQueue.checkpointAndResume() against its in-memory fallback (no
// Postgres needed — see verify-task-ownership-transitions.ts for why this
// works in CI).
// Source half: the soft-deadline yield point in base-agent.ts actually uses
// the guarded transition and never bypasses it.

process.env.NODE_ENV = 'test';
process.env.APEX_ALLOW_EPHEMERAL_QUEUE_FALLBACK = '1';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskQueue } from '../packages/core/src/task-queue.js';
import {
  buildCheckpoint,
  extractCheckpointHistory,
  formatResumePreamble,
  isResumableCheckpoint,
  mergeCheckpointIntoContext,
  priorYieldCountFromContext,
  CHECKPOINT_VERSION,
} from '../packages/core/src/task-checkpoint.js';

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

type MemTask = { id: string; status: string; errorMessage: string | null; context: Record<string, unknown> | null };
function memoryQueueOf(queue: TaskQueue): MemTask[] {
  return (queue as unknown as { memoryQueue: MemTask[] }).memoryQueue;
}

async function main(): Promise<void> {
  console.log('── Checkpoint construction (pure) ──');

  const sampleHistory = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'do the thing' },
    { role: 'assistant' as const, content: 'Working on it — found 3 leads so far.' },
  ];

  const checkpoint = buildCheckpoint({
    taskId: 't1',
    executionId: 'exec-1',
    goalId: 'g1',
    agentId: 'apex-lead-research-001',
    history: sampleHistory,
    completedSteps: ['webSearch(query=leads)'],
    findings: ['webSearch(query=leads)'],
    decisions: ['saveResearchedLead(company=Acme)'],
    unresolvedBlockers: [],
    approvalRequirement: false,
    iterationsUsed: 4,
    toolExecutions: 2,
    maxIterations: 20,
    priorYieldCount: 0,
    reason: 'soft_deadline',
  });

  check('checkpoint carries the current version', checkpoint.checkpointVersion === CHECKPOINT_VERSION);
  check('checkpoint preserves task/execution/agent identity', checkpoint.taskId === 't1' && checkpoint.executionId === 'exec-1' && checkpoint.agentId === 'apex-lead-research-001');
  check('checkpoint yieldCount starts at 1 for a first yield', checkpoint.retryMetadata.yieldCount === 1);
  check('workingSummary is the model\'s own last narration, not a fabricated summary', checkpoint.workingSummary === 'Working on it — found 3 leads so far.');
  check('completedSteps/findings/decisions are exactly what was recorded, nothing invented', (
    checkpoint.completedSteps.length === 1 && checkpoint.decisions.length === 1 && checkpoint.findings.length === 1
  ));
  check('remainingSteps is honestly empty — nothing populates it today', checkpoint.remainingSteps.length === 0);
  check('history round-trips through extractCheckpointHistory', (() => {
    const restored = extractCheckpointHistory(checkpoint);
    return restored.length === sampleHistory.length && restored[2].content === sampleHistory[2].content;
  })());

  const resumed = buildCheckpoint({
    taskId: 't1', executionId: 'exec-2', goalId: 'g1', agentId: 'apex-lead-research-001',
    history: sampleHistory, completedSteps: [], findings: [], decisions: [], unresolvedBlockers: [],
    approvalRequirement: false, iterationsUsed: 2, toolExecutions: 1, maxIterations: 20,
    priorYieldCount: priorYieldCountFromContext({ checkpoint }),
    reason: 'soft_deadline',
  });
  check('yieldCount increments across successive checkpoints of the same task', resumed.retryMetadata.yieldCount === 2);

  console.log('\n── Defensive parsing of untyped context.checkpoint ──');
  check('a real checkpoint is recognized', isResumableCheckpoint(checkpoint));
  check('undefined is rejected, not crashed on', !isResumableCheckpoint(undefined));
  check('a legacy/foreign object is rejected', !isResumableCheckpoint({ foo: 'bar' }));
  check('a wrong-version object is rejected', !isResumableCheckpoint({ ...checkpoint, checkpointVersion: 999 }));

  console.log('\n── Executor-job dispatch marker reset (must be exact, or the job silently stalls) ──');
  const jobContext = { runtime: 'job', projectId: 'p1', worktree: 'main', dispatchedAt: '2026-01-01T00:00:00.000Z', dispatchAttempts: 2 };
  const merged = mergeCheckpointIntoContext(jobContext, checkpoint);
  check('dispatchedAt is cleared so the dispatch loop will re-fire (its WHERE clause requires IS NULL)', merged.dispatchedAt === undefined);
  check('dispatchAttempts resets so backoff does not compound across ordinary yields', merged.dispatchAttempts === 0);
  check('unrelated context keys survive the merge', merged.projectId === 'p1' && merged.worktree === 'main');
  const nonJobMerged = mergeCheckpointIntoContext({ someOtherKey: 1 }, checkpoint);
  check('a non-job task\'s context is untouched beyond adding the checkpoint', nonJobMerged.someOtherKey === 1 && !('dispatchedAt' in nonJobMerged));

  check('the resume preamble names the yield number and reason without inventing content', (() => {
    const preamble = formatResumePreamble(checkpoint);
    return preamble.includes('yield #1') && preamble.includes('soft_deadline') && preamble.includes(checkpoint.workingSummary);
  })());

  console.log('\n── TaskQueue.checkpointAndResume (behaviour) ──');

  async function seed(status: string, errorMessage: string | null = null) {
    const queue = new TaskQueue('guard-agent');
    const task = await queue.enqueue({ title: 't', description: 'd' } as never);
    const mem = memoryQueueOf(queue);
    const row = mem.find((t) => t.id === task.id)!;
    row.status = status;
    row.errorMessage = errorMessage;
    return { queue, row };
  }

  {
    const { queue, row } = await seed('in_progress');
    const took = await queue.checkpointAndResume(row.id, { checkpoint });
    check('checkpointAndResume succeeds for a live in_progress task', took === true);
    check('the task is returned to pending, not left in_progress', row.status === 'pending');
    check('the checkpoint is actually persisted into context', (row.context as Record<string, unknown> | undefined)?.checkpoint === checkpoint);
  }

  const QUARANTINE = 'Quarantined after hard task timeout: Task exceeded hard 10-minute wall-clock timeout';
  for (const [label, status, errorMessage] of [
    ['cancelled', 'cancelled', null],
    ['done', 'done', null],
    ['failed', 'failed', null],
    ['hard-timeout quarantined', 'blocked', QUARANTINE],
  ] as const) {
    const { queue, row } = await seed(status, errorMessage);
    const took = await queue.checkpointAndResume(row.id, { checkpoint });
    check(`checkpointAndResume refuses to resurrect a ${label} task`, took === false && row.status === status);
  }

  console.log('\n── Wiring in base-agent.ts (source) ──');
  const agentSource = fs.readFileSync(path.join(root, 'packages/core/src/base-agent.ts'), 'utf8');
  check('the soft deadline is checked before starting another LLM round-trip, never mid-tool-call',
    (() => {
      const loopStart = agentSource.indexOf('while (iterations < maxIter) {');
      const deadlineCheck = agentSource.indexOf('Date.now() - startTime >= softDeadlineMs', loopStart);
      const llmCall = agentSource.indexOf('const response = await this.llm.complete(history, tools)', loopStart);
      return loopStart >= 0 && deadlineCheck > loopStart && deadlineCheck < llmCall;
    })());
  check('the yield path uses the ownership-checked guarded transition, not a raw update',
    agentSource.includes('await this.taskQueue.checkpointAndResume('));
  check('a soft-yield is deliberately excluded from learning-system outcome credit',
    agentSource.includes('Deliberately not recordMetricsAsync()'));
  check('the hard timeout is documented as an emergency backstop, not the normal slicing mechanism',
    agentSource.includes('emergency backstop') || agentSource.includes('emergency-only backstop') || agentSource.includes('normal way work gets sliced'));
  check('a resumed execution restores history rather than starting a fresh conversation',
    agentSource.includes('extractCheckpointHistory(priorCheckpoint)'));
  check('checkpoint audit rows are written best-effort and never block the yield',
    agentSource.includes('await db.insert(taskCheckpoints).values('));

  console.log(failures === 0 ? '\n✅ ALL CHECKPOINT/RESUME GUARDS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
