import fs from 'node:fs';
import path from 'node:path';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const source = fs.readFileSync(
  path.join(root, 'packages/api-server/src/routes/approvals.ts'),
  'utf8',
);

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) failures++;
}

function routeBody(route: string, nextRoute: string): string {
  const start = source.indexOf(route);
  const end = source.indexOf(nextRoute, start + route.length);
  if (start < 0) return '';
  return source.slice(start, end < 0 ? source.length : end);
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

if (failures > 0) {
  console.error(`\n❌ Approval state integrity guard failed: ${failures} invariant(s) missing`);
  process.exit(1);
}

console.log('\n✅ Approval state integrity source invariants verified');
