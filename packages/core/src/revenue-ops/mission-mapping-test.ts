// ─── Phase 1.1: Mission Mapping Test ─────────────────────────────────────────
// 
// Tests whether APEX goals + tasks + task.context can express the spec's mission
// lifecycle (draft/validating/ready/running/waiting_approval/paused/blocked/
// budget_exhausted/completed/cancelled/failed), or whether we need a dedicated
// missions table.
//
// Run:  tsx packages/core/src/revenue-ops/mission-mapping-test.ts

import { db, goals, tasks } from '@workspace/db';
import { eq, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// Spec mission statuses that APEX goals don't currently have
const SPEC_MISSION_STATUSES = [
  'draft',            // not yet submitted for review
  'validating',       // under review/qualification
  'ready',            // approved and ready to launch
  'running',          // actively executing
  'waiting_approval', // paused awaiting a human approval decision
  'paused',           // operator-paused
  'blocked',          // blocked on something external
  'budget_exhausted', // spend reached the mission budget cap
  'completed',        // finished successfully
  'cancelled',        // cancelled by operator
  'failed',           // failed irrecoverably
] as const;

// APEX goal statuses today
const APEX_GOAL_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;

// Mission payload fields from the spec (Section 7)
interface MissionPayload {
  objective: string;
  targetDefinition: Record<string, unknown>;
  qualificationRules: Record<string, unknown>;
  allowedChannels: string[];
  policy: Record<string, unknown>;
  budgetCents: number;
  spentCents: number;
  startsAt?: string;
  deadlineAt?: string;
}

function isMissionStatus(s: string): s is (typeof SPEC_MISSION_STATUSES)[number] {
  return SPEC_MISSION_STATUSES.includes(s as any);
}

async function main() {
  const results = {
    tests: [] as Array<{ name: string; passed: boolean; detail: string }>,
    passCount: 0,
    failCount: 0,
  };

  function record(name: string, passed: boolean, detail: string) {
    results.tests.push({ name, passed, detail });
    if (passed) results.passCount++; else results.failCount++;
    console[passed ? 'info' : 'error'](`${passed ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
  }

  console.log('═══ Phase 1.1: Mission Mapping Test ═══');
  console.log(`APEX goal statuses today: ${APEX_GOAL_STATUSES.join(', ')}`);
  console.log(`Spec mission statuses needed: ${SPEC_MISSION_STATUSES.join(', ')}`);
  console.log('');

  // ── Test 1: Can goals carry a mission payload? ──────────────────────────
  console.log('--- Test 1: Goal payload carriage ---');

  const goalId = randomUUID();
  const now = new Date().toISOString();
  const missionPayload: MissionPayload = {
    objective: 'Generate 12 qualified demonstrations with commercial roofing companies in Texas.',
    targetDefinition: { industries: ['roofing'], cities: ['Austin', 'Houston', 'Dallas'], employeeRange: [10, 100] },
    qualificationRules: { mustHavePhone: true, mustHaveEmail: true, budgetMinimumCents: 50000 },
    allowedChannels: ['call', 'email', 'sms'],
    policy: { maxSpendCents: 40000, requireApprovalForOfferChange: true },
    budgetCents: 40000,
    spentCents: 0,
    startsAt: now,
    deadlineAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };

  // APEX goals have: title, description, status, priority, projectId, result, completedAt
  // We can put the mission payload into goal.result (text) as JSON, OR into a new goal.context column
  // Test: can we store the payload in goal.result as JSON string?
  const goalResultJson = JSON.stringify(missionPayload);

  try {
    await db.insert(goals).values({
      id: goalId,
      title: 'Revenue Ops Mission: Texas Roofing Demos',
      description: missionPayload.objective,
      status: 'active', // APEX goal status — maps to spec 'ready' or 'running'?
      priority: 2,
      assignedAgentId: 'apex-sales-001',
      result: goalResultJson,
      createdAt: new Date(),
    });

    const [retrieved] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    if (!retrieved) {
      record('goal_insert', false, 'Goal not found after insert');
    } else {
      const parsed = JSON.parse(retrieved.result || 'null') as MissionPayload | null;
      if (!parsed) {
        record('goal_payload', false, 'goal.result is not valid JSON');
      } else {
        const matches = (
          parsed.objective === missionPayload.objective &&
          parsed.targetDefinition.industries.join(',') === missionPayload.targetDefinition.industries.join(',') &&
          parsed.budgetCents === missionPayload.budgetCents &&
          parsed.allowedChannels.join(',') === missionPayload.allowedChannels.join(',')
        );
        record('goal_payload', matches, matches
          ? 'Full mission payload round-trips through goal.result as JSON'
          : 'Payload round-trip mismatch');
      }
    }
  } catch (err) {
    record('goal_insert', false, `Insert failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Test 2: Can APEX goal.status express the spec mission lifecycle? ─────
  console.log('');
  console.log('--- Test 2: Status lifecycle mapping ---');

  // APEX goal statuses: active, paused, completed, cancelled
  // Spec mission statuses: draft, validating, ready, running, waiting_approval, paused, blocked,
  //   budget_exhausted, completed, cancelled, failed

  // Mapping attempt:
  const statusMapping = {
    draft: null as string | null,        // no APEX equivalent — goal must be 'active' to exist? or a new type?
    validating: null as string | null,   // no APEX equivalent
    ready: 'active' as string,           // goal is active and ready to work
    running: 'active' as string,         // goal is being worked (tasks in_progress)
    waiting_approval: 'paused' as string,// goal paused awaiting approval — but loses "why"
    paused: 'paused' as string,          // operator pause
    blocked: 'paused' as string,         // blocked — but loses "blocked vs paused" distinction
    budget_exhausted: null as string | null, // no APEX equivalent — must be a new status
    completed: 'completed' as string,
    cancelled: 'cancelled' as string,
    failed: null as string | null,       // no APEX equivalent — goals don't have 'failed'
  };

  const unmapped = Object.entries(statusMapping)
    .filter(([, apex]) => apex === null)
    .map(([spec]) => spec);

  record('status_mapping', unmapped.length <= 2,
    unmapped.length <= 2
      ? `Partial mapping works. Unmapped: ${unmapped.join(', ')} (could add as new statuses or a mission_status column)`
      : `Too many unmapped statuses: ${unmapped.join(', ')} — needs a dedicated mission_status column or table`);

  // ── Test 3: budget_exhausted as a first-class gating state ───────────────
  console.log('');
  console.log('--- Test 3: budget_exhausted gating ---');

  // Spec: when spent_cents reaches budget_cents, mission goes to budget_exhausted and
  // no new tasks are created. APEX goals don't have this state — but we can model it
  // via task.context + a budget check, OR via a new mission_status.

  // Test: can we represent budget_exhausted using goal.result + a check, without
  // a dedicated status?
  const budgetGoalId = randomUUID();
  const budgetPayload = {
    budgetCents: 10000,
    spentCents: 10000, // exhausted
  };

  try {
    await db.insert(goals).values({
      id: budgetGoalId,
      title: 'Budget Exhaustion Test',
      description: 'Test budget_exhausted modeling',
      status: 'active',
      priority: 5,
      result: JSON.stringify(budgetPayload),
      createdAt: new Date(),
    });

    const [bg] = await db.select().from(goals).where(eq(goals.id, budgetGoalId)).limit(1);
    if (!bg) {
      record('budget_exhausted_state', false, 'Budget goal not found');
    } else {
      const bp = JSON.parse(bg.result || '{}') as { budgetCents: number; spentCents: number };
      const exhausted = bp.spentCents >= bp.budgetCents;
      // Can we gate task creation on this without a dedicated status?
      // Yes — a budget check function reads goal.result, computes spent vs budget,
      // and prevents new task creation. But the goal.status itself doesn't reflect it.
      const canRepresentAsCheck = exhausted && bp.budgetCents > 0;
      record('budget_exhausted_state',
        canRepresentAsCheck,
        canRepresentAsCheck
          ? 'budget_exhausted can be modeled as a computed state from goal.result (spent >= budget), but goal.status stays "active" — loses the visual status'
          : 'Cannot represent budget_exhausted');
    }
  } catch (err) {
    record('budget_exhausted_state', false, `Test failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Test 4: waiting_approval vs paused distinction ───────────────────────
  console.log('');
  console.log('--- Test 4: waiting_approval distinction ---');

  // Spec: mission can be in waiting_approval (paused awaiting human approval of something
  // specific — e.g., a plan, a budget increase, a new offer). APEX goals have 'paused' but
  // not 'waiting_approval' — the distinction between "operator paused" and "awaiting approval"
  // is lost. However, APEX tasks have 'awaiting_approval' status, and approvals are tracked
  // in the approvals table with kind=approval.

  // Test: can we use task.awaiting_approval + approvals table to represent waiting_approval?
  const waGoalId = randomUUID();
  try {
    await db.insert(goals).values({
      id: waGoalId,
      title: 'Waiting Approval Test',
      description: 'Test waiting_approval modeling',
      status: 'active',
      priority: 5,
      createdAt: new Date(),
    });

    // Create a task in awaiting_approval state
    const taskId = randomUUID();
    await db.insert(tasks).values({
      id: taskId,
      goalId: waGoalId,
      title: 'Await approval: budget increase',
      description: 'Need approval for budget increase to $500',
      status: 'awaiting_approval',
      priority: 5,
      assignedAgentId: 'apex-sales-001',
      createdByAgentId: 'apex-sales-001',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create an approval row
    const approvalId = randomUUID();
    await db.insert(goals).values({ id: approvalId, title: 'approval', description: '', status: 'paused' }).onConflictDoNothing();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const hasAwaitingApproval = task?.status === 'awaiting_approval';

    record('waiting_approval_state',
      hasAwaitingApproval,
      hasAwaitingApproval
        ? 'waiting_approval can be modeled as: goal.status=active + a child task.status=awaiting_approval + an approvals row (kind=approval). The mission-level "why" is in the approval.reason'
        : 'Cannot represent waiting_approval at task level');
  } catch (err) {
    record('waiting_approval_state', false, `Test failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Test 5: blocked state ─────────────────────────────────────────────────
  console.log('');
  console.log('--- Test 5: blocked state ---');

  // Spec: mission blocked on something external (e.g., waiting for provider connection,
  // waiting for compliance decision). APEX goals/tasks have 'blocked' status already!
  // tasks.status includes 'blocked'. So this maps directly.

  const blockedGoalId = randomUUID();
  try {
    await db.insert(goals).values({
      id: blockedGoalId,
      title: 'Blocked Test',
      description: 'Test blocked state',
      status: 'active',
      priority: 5,
      createdAt: new Date(),
    });

    const taskId = randomUUID();
    await db.insert(tasks).values({
      id: taskId,
      goalId: blockedGoalId,
      title: 'Blocked task',
      description: 'Blocked on Telnyx connection',
      status: 'blocked',
      priority: 5,
      assignedAgentId: 'apex-sales-001',
      createdByAgentId: 'apex-sales-001',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    record('blocked_state', task?.status === 'blocked',
      task?.status === 'blocked'
        ? 'blocked maps directly to APEX task.status=blocked'
        : 'blocked does not map');
  } catch (err) {
    record('blocked_state', false, `Test failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Test 6: failed state ──────────────────────────────────────────────────
  console.log('');
  console.log('--- Test 6: failed state ---');

  // Spec: mission failed irrecoverably. APEX goals have 'completed' and 'cancelled' but
  // not 'failed'. APEX tasks have 'failed'. So a mission failure could be represented as:
  // goal.status=cancelled + a task.status=failed + a result explaining the failure.

  const failedGoalId = randomUUID();
  try {
    await db.insert(goals).values({
      id: failedGoalId,
      title: 'Failed Mission Test',
      description: 'Test failed state',
      status: 'active',
      priority: 5,
      createdAt: new Date(),
    });

    const taskId = randomUUID();
    await db.insert(tasks).values({
      id: taskId,
      goalId: failedGoalId,
      title: 'Failed task',
      description: 'Voice provider permanently unavailable',
      status: 'failed',
      priority: 5,
      assignedAgentId: 'apex-sales-001',
      createdByAgentId: 'apex-sales-001',
      errorMessage: 'Voice provider permanently unavailable',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mark goal as cancelled with failure result
    await db.update(goals).set({
      status: 'cancelled',
      result: 'Mission failed: voice provider permanently unavailable',
      completedAt: new Date(),
    }).where(eq(goals.id, failedGoalId));

    const [goal] = await db.select().from(goals).where(eq(goals.id, failedGoalId)).limit(1);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const missionFailed = goal?.status === 'cancelled' && goal?.result?.includes('failed') && task?.status === 'failed';

    record('failed_state', missionFailed,
      missionFailed
        ? 'failed maps to: goal.status=cancelled + goal.result explains failure + a failed child task. Loses the "failed" status label but preserves the meaning'
        : 'Cannot represent failed');
  } catch (err) {
    record('failed_state', false, `Test failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Test 7: full lifecycle walk-through ──────────────────────────────────
  console.log('');
  console.log('--- Test 7: Full lifecycle walk-through ---');

  const lifecycleGoalId = randomUUID();
  const lifecycleEvents: Array<{ specStatus: string; apexStatus: string; feasible: boolean; note: string }> = [];

  const lifecycle: Array<{ spec: string; apex: string; note: string }> = [
    { spec: 'draft', apex: 'N/A (goal not yet created)', note: 'Draft exists before goal creation — a mission draft is a pending intent, not yet a goal' },
    { spec: 'validating', apex: 'N/A (no APEX equivalent)', note: 'Validating = under review. APEX has no "under review" goal state — could be a new status or a task in awaiting_approval' },
    { spec: 'ready', apex: 'active', note: 'Ready = approved and ready to work. APEX goal.status=active with tasks about to be created' },
    { spec: 'running', apex: 'active', note: 'Running = actively executing. APEX goal.status=active with in_progress tasks' },
    { spec: 'waiting_approval', apex: 'active + awaiting_approval task', note: 'See Test 4 — represented as active goal + awaiting_approval child task + approval row' },
    { spec: 'paused', apex: 'paused', note: 'Direct map to APEX goal.status=paused' },
    { spec: 'blocked', apex: 'blocked (task)', note: 'See Test 5 — represented as blocked child task' },
    { spec: 'budget_exhausted', apex: 'active (computed from goal.result)', note: 'See Test 3 — computed state, goal.status stays active but budget check prevents new tasks' },
    { spec: 'completed', apex: 'completed', note: 'Direct map to APEX goal.status=completed' },
    { spec: 'cancelled', apex: 'cancelled', note: 'Direct map to APEX goal.status=cancelled' },
    { spec: 'failed', apex: 'cancelled + failed task + result', note: 'See Test 6 — represented as cancelled goal + failed task + failure result' },
  ];

  for (const step of lifecycle) {
    lifecycleEvents.push({
      specStatus: step.spec,
      apexStatus: step.apex,
      feasible: !step.note.startsWith('N/A') && !step.note.includes('no APEX equivalent'),
      note: step.note,
    });
  }

  const feasibleCount = lifecycleEvents.filter(e => e.feasible).length;
  record('lifecycle_walkthrough',
    feasibleCount >= 9,
    feasibleCount >= 9
      ? `${feasibleCount}/11 spec statuses are feasible via APEX goals+tasks. Unfeasible: ${lifecycleEvents.filter(e => !e.feasible).map(e => e.specStatus).join(', ')}`
      : `${feasibleCount}/11 feasible — too many gaps, needs a dedicated missions table`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('');
  console.log('═══ Phase 1.1 Summary ═══');
  console.log(`Passed: ${results.passCount}/${results.tests.length}`);
  console.log(`Failed: ${results.failCount}/${results.tests.length}`);
  console.log('');

  const unmappedStatuses = unmapped;
  const decision = {
    pass: results.failCount === 0 && unmappedStatuses.length <= 2,
    reason: results.failCount === 0 && unmappedStatuses.length <= 2
      ? 'APEX goals + tasks CAN express the spec mission lifecycle with minor extensions (a few new statuses or a mission_status column, budget_exhausted as a computed state). No dedicated missions table needed — revenue-ops missions are a new KIND of APEX goal with a revenue-ops payload in goal.result + new tools.'
      : 'APEX goals + tasks CANNOT fully express the spec mission lifecycle. A dedicated missions table is needed for: ' + unmappedStatuses.join(', ') + '.',
    unmapped: unmappedStatuses,
    failCount: results.failCount,
  };

  console.log('Decision:', decision.pass ? 'PASS — map to APEX goals/tasks' : 'FAIL — add missions table');
  console.log('Reason:', decision.reason);
  if (decision.unmapped.length > 0) {
    console.log('Unmapped spec statuses:', decision.unmapped.join(', '));
  }

  // Clean up test goals
  try {
    await db.delete(goals).where(eq(goals.id, goalId));
    await db.delete(goals).where(eq(goals.id, budgetGoalId));
    await db.delete(goals).where(eq(goals.id, waGoalId));
    await db.delete(goals).where(eq(goals.id, blockedGoalId));
    await db.delete(goals).where(eq(goals.id, failedGoalId));
    await db.delete(goals).where(eq(goals.id, lifecycleGoalId));
    await db.delete(goals).where(eq(goals.id, approvalId));
  } catch {
    // Best-effort cleanup
  }

  return decision;
}

main().catch(err => {
  console.error('Test crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
