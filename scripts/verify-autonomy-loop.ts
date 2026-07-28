/**
 * Functional verification of the closed-loop autonomy work, against a REAL
 * Postgres with the REAL schema — not a mock, and not just a typecheck.
 *
 * Usage (DESTRUCTIVE — it truncates tasks/goals/agents/approvals, so point it
 * at a scratch database, NEVER at production):
 *   DATABASE_URL=postgres://user@host:port/scratchdb \
 *     pnpm --filter @workspace/api-server exec tsx ../../scripts/verify-autonomy-loop.ts
 *
 * Per QWEN.md's verification sequence: compiling and deploying are necessary
 * but NOT sufficient. This exercises the actual handler classes and the actual
 * tool implementations against real rows and asserts on real returned data.
 */
import { randomUUID } from 'crypto';
import { db, migrate, tasks, goals, agents, approvals } from '@workspace/db';
import { eq, sql } from 'drizzle-orm';
import {
  DelegationFollowupJob,
  GoalProgressJob,
  FailureReviewJob,
  BranchReviewJob,
} from '../packages/background-jobs/src/index.js';
import { getToolRegistry } from '../packages/core/src/index.js';
import type { ScheduledJob } from '@workspace/db';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}`, detail !== undefined ? JSON.stringify(detail, null, 2) : '');
  }
}

function job(over: Partial<ScheduledJob>): ScheduledJob {
  return {
    id: 'test-job',
    name: 'test',
    jobType: 'x',
    cronExpression: '* * * * *',
    enabled: true,
    targetAgentId: null,
    payload: {},
    priority: 5,
    status: 'active',
    retryCount: 0,
    maxRetries: 3,
    nextRunAt: new Date(),
    lastRunAt: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ScheduledJob;
}

const toolCtx = (agentId: string, taskId?: string) => ({
  agentId,
  taskId,
  workspaceRoot: process.cwd(),
  requestApproval: async () => true,
});

async function main() {
  await migrate();
  console.log('✅ Schema migrated\n');

  // Clean slate
  await db.delete(tasks);
  await db.delete(goals);
  await db.delete(approvals);
  await db.delete(agents);

  const now = new Date();
  for (const [id, role, tier] of [
    ['apex-ceo-001', 'CEO', 0],
    ['apex-coo-001', 'COO', 1],
    ['apex-lead-research-001', 'LEAD_RESEARCH', 3],
  ] as const) {
    await db.insert(agents).values({
      id,
      name: id,
      role,
      tier,
      status: 'idle',
      systemPrompt: 'x',
      model: 'm',
      provider: 'p',
      createdAt: now,
    });
  }

  const registry = getToolRegistry(process.cwd());

  // ── 1. New tools are actually registered and exposed to the LLM ──────────
  console.log('── 1. Tool registration ──');
  const schemas = registry.getLLMToolSchemas();
  const names = schemas.map((s) => s.name);
  for (const t of [
    'get_delegation_status',
    'get_task_details',
    'list_goals',
    'update_goal_status',
    'escalate_to_human',
  ]) {
    check(`${t} registered with an LLM schema`, names.includes(t));
  }

  // ── 2. Delegation follow-up: the return leg of delegation ────────────────
  console.log('\n── 2. DelegationFollowupJob (closed-loop delegation) ──');
  const goalId = randomUUID();
  await db.insert(goals).values({
    id: goalId,
    title: 'Grow BuildMyBot pipeline',
    description: 'Find and qualify new leads',
    status: 'active',
    priority: 2,
    assignedAgentId: 'apex-ceo-001',
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
  });

  // A COO parent task that delegated two children to the researcher.
  const parentId = randomUUID();
  await db.insert(tasks).values({
    id: parentId,
    goalId,
    title: 'Run a lead-gen initiative',
    description: 'd',
    status: 'done',
    priority: 3,
    assignedAgentId: 'apex-coo-001',
    createdByAgentId: 'apex-ceo-001',
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    maxRetries: 3,
  });
  const childDone = randomUUID();
  const childFailed = randomUUID();
  const childOpen = randomUUID();
  await db.insert(tasks).values([
    {
      id: childDone,
      goalId,
      parentTaskId: parentId,
      title: 'Research HVAC companies in Texas',
      description: 'd',
      status: 'done',
      priority: 5,
      assignedAgentId: 'apex-lead-research-001',
      createdByAgentId: 'apex-coo-001',
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: 3,
      result: 'Saved 32 qualifying HVAC leads.',
    },
    {
      id: childFailed,
      goalId,
      parentTaskId: parentId,
      title: 'Research roofing companies in Florida',
      description: 'd',
      status: 'failed',
      priority: 5,
      assignedAgentId: 'apex-lead-research-001',
      createdByAgentId: 'apex-coo-001',
      createdAt: now,
      updatedAt: now,
      retryCount: 3,
      maxRetries: 3,
      errorMessage: 'searchBusinessDirectory returned 0 results after 4 attempts',
    },
    {
      id: childOpen,
      goalId,
      parentTaskId: parentId,
      title: 'Research medspas in Georgia',
      description: 'd',
      status: 'pending',
      priority: 5,
      assignedAgentId: 'apex-lead-research-001',
      createdByAgentId: 'apex-coo-001',
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: 3,
    },
  ]);

  // 2a. With a sibling still running, the batch must be DEFERRED.
  const deferred = (await new DelegationFollowupJob().execute(
    job({ jobType: 'delegation_followup' }),
  )) as Record<string, number>;
  check('defers reporting while a sibling is still running', deferred.synthesesCreated === 0 && deferred.deferredBatchesStillRunning === 1, deferred);

  // 2b. Finish the last sibling → the whole batch reports.
  await db.update(tasks).set({ status: 'done', result: 'Saved 11 medspa leads.', updatedAt: new Date() }).where(eq(tasks.id, childOpen));
  const reported = (await new DelegationFollowupJob().execute(
    job({ jobType: 'delegation_followup' }),
  )) as Record<string, unknown>;
  check('creates exactly one synthesis task once all siblings finished', reported.synthesesCreated === 1, reported);

  const [synth] = await db.select().from(tasks).where(sql`${tasks.title} LIKE 'Delegation results:%'`);
  check('synthesis routed to the DELEGATOR (apex-coo-001), not the worker', synth?.assignedAgentId === 'apex-coo-001', synth?.assignedAgentId);
  check('synthesis is a root task (cannot re-trigger itself)', synth?.parentTaskId === null);
  check('synthesis inherits the goal', synth?.goalId === goalId);
  check('synthesis carries the real success result text', (synth?.description ?? '').includes('Saved 32 qualifying HVAC leads.'));
  check('synthesis carries the real failure error text', (synth?.description ?? '').includes('returned 0 results after 4 attempts'));
  check('synthesis states the honest tally', (synth?.description ?? '').includes('2 succeeded, 1 failed'));

  // 2c. Idempotency — a second run must not re-report the same batch.
  const rerun = (await new DelegationFollowupJob().execute(job({ jobType: 'delegation_followup' }))) as Record<string, number>;
  check('does not re-report an already-reported batch', rerun.synthesesCreated === 0, rerun);

  // ── 3. get_delegation_status reads the real outcomes back ────────────────
  console.log('\n── 3. get_delegation_status tool ──');
  const ds = await registry.execute('get_delegation_status', { taskId: parentId }, toolCtx('apex-coo-001', parentId));
  const dsData = ds.data as { counts: Record<string, number>; allChildrenFinished: boolean; guidance: string };
  check('tool succeeded', ds.success, ds.error);
  check('reports 3 children: 2 done, 1 failed', dsData?.counts.total === 3 && dsData.counts.done === 2 && dsData.counts.failed === 1, dsData?.counts);
  check('guidance tells the manager to act on the failure', dsData?.guidance.includes('FAILED'));

  // ── 4. Goal lifecycle: goals can finally be closed, but not dishonestly ──
  console.log('\n── 4. Goal lifecycle tools ──');

  // The synthesis task from step 2 inherited this goal and is still pending —
  // so the goal is correctly NOT closable yet. That IS the closed loop: the
  // manager must actually process the delegation results before the goal can
  // be reported complete. Assert that, then let the manager finish it.
  const preClose = await registry.execute('update_goal_status', { goalId, status: 'completed', result: 'x' }, toolCtx('apex-ceo-001'));
  check(
    'goal cannot be closed while the delegation-results review is unworked',
    (preClose.data as { updated: boolean })?.updated === false,
    preClose.data,
  );
  await db.update(tasks).set({ status: 'done', result: 'Reviewed; FL sweep re-delegated.', updatedAt: new Date() }).where(eq(tasks.id, synth.id));

  const lg = await registry.execute('list_goals', {}, toolCtx('apex-ceo-001'));
  const lgData = lg.data as { goals: Array<{ goalId: string; state: string; tasks: Record<string, number> }> };
  const g = lgData?.goals.find((x) => x.goalId === goalId);
  // 5 tasks on this goal: parent + 3 children + the synthesis review.
  check('list_goals reports real task rollup, not just titles', g?.tasks.total === 5 && g.tasks.done === 4 && g.tasks.failed === 1 && g.tasks.open === 0, g?.tasks);
  check('goal state is work_finished_with_failures', g?.state === 'work_finished_with_failures', g?.state);

  const noResult = await registry.execute('update_goal_status', { goalId, status: 'completed' }, toolCtx('apex-ceo-001'));
  check('refuses to complete a goal with no result text', !noResult.success && (noResult.error ?? '').includes('without a `result`'), noResult.error);

  // Open work must block closure — the anti-inflated-reporting guard.
  const blockerId = randomUUID();
  await db.insert(tasks).values({
    id: blockerId, goalId, title: 'still running', description: 'd', status: 'in_progress',
    priority: 5, assignedAgentId: 'apex-coo-001', createdByAgentId: 'apex-ceo-001',
    createdAt: now, updatedAt: now, retryCount: 0, maxRetries: 3,
  });
  const blocked = await registry.execute('update_goal_status', { goalId, status: 'completed', result: 'done' }, toolCtx('apex-ceo-001'));
  check('refuses to complete a goal whose work is still running', (blocked.data as { updated: boolean })?.updated === false, blocked.data);

  await db.update(tasks).set({ status: 'done', updatedAt: new Date() }).where(eq(tasks.id, blockerId));
  const closed = await registry.execute('update_goal_status', { goalId, status: 'completed', result: '43 leads saved; FL roofing sweep failed.' }, toolCtx('apex-ceo-001'));
  check('closes the goal once work is genuinely finished', (closed.data as { updated: boolean })?.updated === true, closed.data);
  const [closedGoal] = await db.select().from(goals).where(eq(goals.id, goalId));
  check('goal row is actually completed with a result + timestamp', closedGoal.status === 'completed' && !!closedGoal.result && !!closedGoal.completedAt);

  // ── 5. GoalProgressJob drives goals to a conclusion ──────────────────────
  console.log('\n── 5. GoalProgressJob ──');
  const staleGoalId = randomUUID();
  await db.insert(goals).values({
    id: staleGoalId,
    title: 'Launch referral program',
    description: 'Never decomposed',
    status: 'active',
    priority: 3,
    assignedAgentId: 'apex-ceo-001',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });
  const gp = (await new GoalProgressJob().execute(job({ jobType: 'goal_progress', targetAgentId: 'apex-ceo-001' }))) as {
    actionsCreated: number; actions: Array<{ goalId: string; state: string }>;
  };
  check('detects the accepted-but-never-decomposed goal', gp.actionsCreated === 1 && gp.actions[0].state === 'no_work_created', gp);
  const [gpTask] = await db.select().from(tasks).where(sql`${tasks.title} LIKE 'Goal review:%'`);
  check('assigns the goal review to the goal owner', gpTask?.assignedAgentId === 'apex-ceo-001');
  check('review task tells the CEO to decompose or cancel', (gpTask?.description ?? '').includes('never decomposed'));
  const gp2 = (await new GoalProgressJob().execute(job({ jobType: 'goal_progress', targetAgentId: 'apex-ceo-001' }))) as { actionsCreated: number };
  check('idempotent — does not stack a second review on the same goal', gp2.actionsCreated === 0, gp2);

  // ── 6. FailureReviewJob clusters recurring failures ──────────────────────
  console.log('\n── 6. FailureReviewJob ──');
  for (let i = 0; i < 3; i++) {
    await db.insert(tasks).values({
      id: randomUUID(),
      title: `Sweep batch ${i}`,
      description: 'd',
      status: 'failed',
      priority: 5,
      assignedAgentId: 'apex-lead-research-001',
      createdByAgentId: 'system-scheduler',
      createdAt: now,
      updatedAt: now,
      retryCount: 3,
      maxRetries: 3,
      // Same root cause, different ids/numbers — must cluster as ONE.
      errorMessage: `All LLM providers failed for task ${randomUUID()} at ${new Date().toISOString()} (429 rate limit, attempt ${i})`,
    });
  }
  const fr = (await new FailureReviewJob().execute(job({ jobType: 'failure_review', targetAgentId: 'apex-ceo-001' }))) as {
    failures: number; significantClusters: number; taskCreated: boolean;
  };
  check('collapses varying ids/numbers into a single cluster', fr.significantClusters === 1, fr);
  check('creates one triage task for the CEO', fr.taskCreated === true, fr);
  const [triage] = await db.select().from(tasks).where(sql`${tasks.title} LIKE 'Failure triage%'`);
  check('triage names the failing agent', (triage?.description ?? '').includes('apex-lead-research-001'));
  check('triage teaches capacity-vs-defect classification', (triage?.description ?? '').includes('CAPACITY'));
  const fr2 = (await new FailureReviewJob().execute(job({ jobType: 'failure_review', targetAgentId: 'apex-ceo-001' }))) as { taskCreated: boolean };
  check('idempotent — no duplicate triage while one is open', fr2.taskCreated === false, fr2);

  // ── 7. BranchReviewJob gives the COO its own heartbeat ───────────────────
  console.log('\n── 7. BranchReviewJob ──');
  const br = (await new BranchReviewJob().execute(
    job({
      jobType: 'branch_review',
      targetAgentId: 'apex-coo-001',
      payload: { subordinates: ['apex-lead-research-001'], focus: 'Keep the pipeline moving.' },
    }),
  )) as { taskId: string; failuresLast24h: number };
  check('creates a branch review for the COO', !!br.taskId);
  check('sees its subordinate real failures', br.failuresLast24h === 4, br);
  const [brTask] = await db.select().from(tasks).where(eq(tasks.id, br.taskId));
  check('carries the role-specific focus', (brTask?.description ?? '').includes('Keep the pipeline moving.'));
  check('enforces the no-busywork rule', (brTask?.description ?? '').includes('RESTRAINT'));
  const br2 = (await new BranchReviewJob().execute(
    job({ jobType: 'branch_review', targetAgentId: 'apex-coo-001', payload: { subordinates: [] } }),
  )) as { skipped?: boolean };
  check('idempotent — no stacking while the last review is unworked', br2.skipped === true, br2);

  // ── 8. escalate_to_human reaches a human-visible queue ───────────────────
  console.log('\n── 8. escalate_to_human ──');
  const esc = await registry.execute(
    'escalate_to_human',
    { subject: 'GITHUB_TOKEN not provisioned', detail: 'PR loop cannot run.', urgency: 'high', category: 'anomaly' },
    toolCtx('apex-cto-001', parentId),
  );
  check('escalation tool succeeded', esc.success, esc.error);
  const [row] = await db.select().from(approvals).where(eq(approvals.toolName, 'escalate_to_human'));
  check('lands as a PENDING item in the approval queue a human sees', row?.status === 'pending');
  check('reason line carries urgency + category for triage', (row?.reason ?? '').includes('[HIGH · anomaly]'), row?.reason);

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
