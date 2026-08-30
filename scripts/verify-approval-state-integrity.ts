import fs from 'node:fs';
import path from 'node:path';
import {
  APPROVAL_RECOVERY_STALE_MS,
  APPROVAL_WAIT_MAX_MS,
  approvalPayloadsEqual,
  canonicalApprovalPayload,
  consumedApprovalStatus,
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

check('no approval resolution path blindly updates by id alone',
  !approve.includes('.where(eq(approvals.id, req.params.id))') &&
  !reject.includes('.where(eq(approvals.id, req.params.id))'));

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

console.log('\n── Restart-safe one-shot continuation ──');
check('recovery grace is longer than the maximum live approval waiter',
  APPROVAL_RECOVERY_STALE_MS > APPROVAL_WAIT_MAX_MS);
check('recovery only considers resolved approval decisions',
  agentSource.includes("inArray(approvals.status, ['approved', 'rejected'])") &&
  !agentSource.includes("inArray(approvals.status, ['pending', 'approved', 'rejected'])"));
check('recovery only requeues tasks still awaiting approval after stale cutoff',
  agentSource.includes("eq(tasksTable.status, 'awaiting_approval')") &&
  agentSource.includes('lt(tasksTable.updatedAt, cutoff)'));
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
check('timeout is itself consumed and cannot become a reusable rejection',
  agentSource.includes("status: 'consumed_rejected'") &&
  agentSource.includes('Auto-rejected after'));

if (failures > 0) {
  console.error(`\n❌ Approval state integrity guard failed: ${failures} invariant(s) missing`);
  process.exit(1);
}

console.log('\n✅ Approval state integrity and restart-safe continuation invariants verified');
