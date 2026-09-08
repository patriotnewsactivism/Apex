import fs from 'node:fs';
import path from 'node:path';
import {
  approvalPayloadsEqual,
  canonicalApprovalPayload,
  consumedApprovalStatus,
  isApprovalYieldSignal,
  ApprovalYieldSignal,
  resolveApprovalAutoRejectMs,
} from '../packages/core/src/approval-continuation.js';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const routeSource = fs.readFileSync(
  path.join(root, 'packages/api-server/src/routes/approvals.ts'),
  'utf8',
);
const agentSource = fs.readFileSync(
  path.join(root, 'packages/core/src/instrumented-base-agent.ts'),
  'utf8',
);
const coreAgentSource = fs.readFileSync(
  path.join(root, 'packages/core/src/base-agent.ts'),
  'utf8',
);

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) failures++;
}

function routeBody(route: string, nextRoute: string): string {
  const start = routeSource.indexOf(route);
  const end = routeSource.indexOf(nextRoute, start + route.length);
  if (start < 0) return '';
  return routeSource.slice(start, end < 0 ? routeSource.length : end);
}

const approve = routeBody("router.post('/:id/approve'", "router.post('/:id/reject'");
const reject = routeBody("router.post('/:id/reject'", "router.post('/:id/acknowledge'");
const acknowledge = routeBody("router.post('/:id/acknowledge'", 'return router;');

console.log('── Approval compare-and-set transitions ──');
for (const [name, body] of [['approve', approve], ['reject', reject]] as const) {
  check(`${name} only targets kind=approval`, body.includes("eq(approvals.kind, 'approval')"));
  check(`${name} only targets status=pending`, body.includes("eq(approvals.status, 'pending')"));
  check(`${name} verifies that a row was actually transitioned`,
    body.includes('.returning({ id: approvals.id })') && body.includes('if (!resolved)'));
  check(`${name} rejects replay/stale resolution with conflict`, body.includes('res.status(409)'));
}

check('acknowledge only targets kind=escalation', acknowledge.includes("eq(approvals.kind, 'escalation')"));
check('acknowledge only targets status=pending', acknowledge.includes("eq(approvals.status, 'pending')"));
check('acknowledge verifies transition result',
  acknowledge.includes('.returning({ id: approvals.id })') && acknowledge.includes('if (!resolved)'));
check('acknowledge rejects replay/stale resolution with conflict', acknowledge.includes('res.status(409)'));

function updateBody(body: string): string {
  const start = body.indexOf('db.update(approvals)');
  if (start < 0) return '';
  const end = body.indexOf('.returning(', start);
  return end < 0 ? body.slice(start) : body.slice(start, end);
}
check('no approval resolution UPDATE blindly targets id alone (must also pin kind/status)',
  (() => {
    const approveUpdate = updateBody(approve);
    const rejectUpdate = updateBody(reject);
    return (
      approveUpdate.length > 0 && approveUpdate.includes('eq(approvals.status,') &&
      rejectUpdate.length > 0 && rejectUpdate.includes('eq(approvals.status,')
    );
  })());

console.log('\n── Exact normalized payload binding ──');
const payloadA = { command: 'pnpm test', timeoutMs: 30_000, nested: { z: 2, a: 1 } };
const payloadB = { nested: { a: 1, z: 2 }, timeoutMs: 30_000, command: 'pnpm test' };
check('canonical payload ignores object key order',
  canonicalApprovalPayload(payloadA) === canonicalApprovalPayload(payloadB));
check('exact payload equality accepts semantically identical JSON objects',
  approvalPayloadsEqual(payloadA, payloadB));
check('exact payload equality rejects changed approved arguments',
  !approvalPayloadsEqual(payloadA, { ...payloadA, timeoutMs: 60_000 }));
check('approved decision has a distinct consumed terminal state',
  consumedApprovalStatus('approved') === 'consumed_approved');
check('rejected decision has a distinct consumed terminal state',
  consumedApprovalStatus('rejected') === 'consumed_rejected');

check('instrumented agent re-parses approval args through the registered tool schema',
  agentSource.includes('tool.schema.safeParse(args)') && agentSource.includes('normalizedApprovalArgs'));
check('approval rows persist normalized args, never the raw LLM object',
  agentSource.includes('toolArgs: normalizedArgs') && !agentSource.includes('toolArgs: args as Record'));
check('tool/agent authorization is rechecked before approval persistence and recovery',
  agentSource.includes('this.config.tools.includes(toolName)') &&
  agentSource.includes('!tool.requiresApproval') &&
  agentSource.includes('this.config.tools.includes(row.toolName)'));
check('restart reuse requires exact normalized payload equality',
  agentSource.includes('resolvedDecisionForExactPayload') &&
  agentSource.includes('approvalPayloadsEqual(row.toolArgs, normalizedArgs)'));

console.log('\n── Approval yield (Phase 3): no live in-process wait ──');
check('requestHumanApproval no longer polls in-process for a decision',
  !agentSource.includes("while (Date.now() < deadline)") &&
  !/setTimeout\(resolve, 1000\)/.test(agentSource));
check('requestHumanApproval persists the pending approval before yielding',
  agentSource.includes("status: 'pending'") &&
  agentSource.includes('kind: \'approval\'') &&
  agentSource.includes('await this.taskQueue.awaitApproval(taskId)'));
check('requestHumanApproval yields by throwing a dedicated signal, not returning a value',
  agentSource.includes('throw new ApprovalYieldSignal(taskId, approvalId)'));
check('the yield signal is a real Error subclass distinguishable from an ordinary failure',
  new ApprovalYieldSignal('t1', 'a1') instanceof Error &&
  isApprovalYieldSignal(new ApprovalYieldSignal('t1', 'a1')) &&
  !isApprovalYieldSignal(new Error('ordinary failure')));
check('BaseAgent.executeTask treats the yield signal as neither success nor failure completion',
  coreAgentSource.includes('isApprovalYieldSignal(err)') &&
  coreAgentSource.includes('yielded: true') &&
  !/isApprovalYieldSignal\(err\)[\s\S]{0,200}taskQueue\.fail/.test(coreAgentSource));
check('the yield path never calls taskQueue.fail (task stays durably awaiting_approval, not failed)',
  (() => {
    const idx = coreAgentSource.indexOf('isApprovalYieldSignal(err)');
    const block = coreAgentSource.slice(idx, coreAgentSource.indexOf('const msg = err instanceof Error', idx));
    return idx >= 0 && !block.includes('taskQueue.fail');
  })());

console.log('\n── Immediate requeue on decision (fast path) + durable backstop ──');
check('approve resolves and then requeues the task immediately (fast path)',
  (() => {
    const idx = approve.indexOf("res.json({ approved: true })");
    const before = approve.slice(0, idx);
    return before.includes('requeueAwaitingApprovalTask');
  })());
check('reject resolves and then requeues the task immediately (fast path)',
  (() => {
    const idx = reject.indexOf("res.json({ rejected: true })");
    const before = reject.slice(0, idx);
    return before.includes('requeueAwaitingApprovalTask');
  })());
check('the fast-path requeue only touches a task still awaiting_approval (cannot resurrect a withdrawn task)',
  routeSource.includes("eq(tasksTable.status, 'awaiting_approval')") &&
  routeSource.includes('async function requeueAwaitingApprovalTask'));
check('durable recovery sweep is unconditional (no stale-live-waiter cutoff to outlive anymore)',
  agentSource.includes('async function recoverResolvedApprovalWaits') &&
  !agentSource.includes('APPROVAL_RECOVERY_STALE_MS'));
check('recovery only considers resolved approval decisions',
  agentSource.includes("inArray(approvals.status, ['approved', 'rejected'])") &&
  !agentSource.includes("inArray(approvals.status, ['pending', 'approved', 'rejected'])"));
check('recovery only requeues tasks still awaiting approval',
  agentSource.includes("eq(tasksTable.status, 'awaiting_approval')"));

console.log('\n── Durable auto-reject replaces the old 5-minute in-process timeout ──');
check('auto-reject window defaults to hours, not minutes, and is operator-configurable',
  agentSource.includes('resolveApprovalAutoRejectMs') &&
  fs.readFileSync(path.join(root, 'packages/core/src/approval-continuation.ts'), 'utf8')
    .includes('APEX_APPROVAL_AUTO_REJECT_HOURS'));
check('a zero/negative/non-finite configured window disables auto-reject rather than defaulting to something short',
  (() => {
    const prior = process.env.APEX_APPROVAL_AUTO_REJECT_HOURS;
    try {
      process.env.APEX_APPROVAL_AUTO_REJECT_HOURS = '0';
      const zero = resolveApprovalAutoRejectMs();
      process.env.APEX_APPROVAL_AUTO_REJECT_HOURS = '-5';
      const negative = resolveApprovalAutoRejectMs();
      process.env.APEX_APPROVAL_AUTO_REJECT_HOURS = 'not-a-number';
      const nonFinite = resolveApprovalAutoRejectMs();
      process.env.APEX_APPROVAL_AUTO_REJECT_HOURS = '2';
      const positive = resolveApprovalAutoRejectMs();
      return zero === 0 && negative === 0 && nonFinite === 0 && positive === 2 * 60 * 60 * 1000;
    } finally {
      if (prior === undefined) delete process.env.APEX_APPROVAL_AUTO_REJECT_HOURS;
      else process.env.APEX_APPROVAL_AUTO_REJECT_HOURS = prior;
    }
  })());
check('auto-reject sets plain "rejected", never "consumed_rejected" directly (must flow through the same one-shot consumption as a human decision)',
  (() => {
    const idx = agentSource.indexOf('async function sweepExpiredPendingApprovals');
    const body = agentSource.slice(idx, agentSource.indexOf('function ensureApprovalRecoveryLoop', idx));
    return idx >= 0 && body.includes("status: 'rejected'") && !body.includes("'consumed_rejected'");
  })());

console.log('\n── Restart-safe one-shot continuation (unchanged core invariants) ──');
check('resolved approvals are compare-and-set consumed',
  agentSource.includes('eq(approvals.status, decision)') &&
  agentSource.includes('status: consumedApprovalStatus(decision)'));
const consumeIndex = agentSource.indexOf('const consumed = await this.consumeDecision(row.id, row.status)');
const executeIndex = agentSource.indexOf('const output = await tool.execute(parsed.data, toolContext)');
check('recovered approval is consumed before the side-effecting tool executes',
  consumeIndex >= 0 && executeIndex > consumeIndex);
check('policy/schema drift makes recovered approval stale instead of executing it',
  agentSource.includes("status: 'stale'") &&
  agentSource.includes('approved payload is not the current normalized tool payload'));
check('recovered approval continuation runs before the ordinary reasoning loop',
  agentSource.includes('const continuation = await this.consumeRecoveredContinuation(taskId)') &&
  agentSource.indexOf('consumeRecoveredContinuation(taskId)') < agentSource.indexOf('super.executeTask(taskId'));
check('a successful side effect cannot become a fake failure because its return value is not JSON serializable',
  agentSource.includes('summarizeRecoveredToolResult') &&
  agentSource.includes('[tool executed successfully; return value was not JSON-serializable]'));

if (failures > 0) {
  console.error(`\n❌ Approval state integrity guard failed: ${failures} invariant(s) missing`);
  process.exit(1);
}

console.log('\n✅ Approval state integrity, yield, and restart-safe continuation invariants verified');
