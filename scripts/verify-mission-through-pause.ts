/**
 * Follow-up to the mission-first budget split:
 *  (1) a provider pause hit by internal/background work parks only non-mission
 *      claims; mission/campaign tasks stay claimable. OpenRouter free-tier
 *      requests are counted per work class per key.
 *  (2) internal-loop rules cover the loop titles seen on prod 2026-10-23.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
process.env.DATABASE_URL ??= 'postgres://guard:guard@127.0.0.1:9/guard';
for (const k of ['APEX_MISSION_RESERVE_PCT', 'APEX_INTERNAL_LOOP_MAX_PCT', 'APEX_OPENROUTER_FREE_DAILY_REQUESTS']) delete process.env[k];

const root = process.env.GITHUB_WORKSPACE ??
  (fs.existsSync(path.join(process.cwd(), 'packages/core')) ? process.cwd() : path.resolve(process.cwd(), '../..'));
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
function check(label: string, cond: boolean) { assert.ok(cond, label); console.log(`  ok  ${label}`); }

async function main() {
  const wc = await import('../packages/core/src/work-class-budget.js');
  const tq = await import('../packages/core/src/task-queue.js');
  const ba = await import('../packages/core/src/base-agent.js');

  console.log('(2) loop titles from prod 2026-10-23 → internal');
  const internal = [
    'Delegation results: Delegation results: Delegation results: QA Gate f1e2c3',
    'Delegation results: Final re-delegation: Run cancellation-audit + tasks.patch suites',
    'REWORK: Goals PATCH cancellation attribution — 4 critical defects found in review',
    'Autonomous branch review — apex-coo-001 — 2026-10-23T03:05:54.800Z',
    'Autonomous goal review — 2026-10-23T03:05:54.800Z',
    'Investigate cancelled task 12 — goal 3b4e5ac evidence-loop cleanup',
    'ESCALATION — goal 3b4e5ac closure blocked: cancel stale evidence-loop',
    'FINAL attempt — run existing task-patch guard suites, verbatim output',
    'Gate f1e2c3: Create cancel-attribution module + rewrite PATCH endpoint',
    'QA evidence request (goal 3b4ace): verdict = all 6 items ABSENT',
    'Re-delegate: Provide PATCH endpoint code for Susan persona review',
    'RE-DELEGATION (corrected): failure-rate baseline + measurement methodology',
    'RE-DISPATCH (attempt 3): durable mirror of Arvizu control docs',
    'RE-OPEN (2nd): implement guarded PATCH for tasks.ts/goals.ts',
    'RESUME both remediation tasks — prior "done" is UNVERIFIED',
    'Peer Review Request: Delegation results: Delegation',
    'Batching protocol — goal 1dda2b3 (request volume reduction)',
    'Delegation results: Nationwide Car Dealership Lead Research — Phase 2',
  ];
  for (const t of internal) check(`internal: ${t.slice(0, 70)}`, wc.classifyWorkClass({ title: t, context: {} }) === 'internal');
  check('mission: Execute mission:', wc.classifyWorkClass({ title: 'Execute mission: Revenue Ops Mission: Find 25 Leads', context: {} }) === 'mission');
  check('mission: lead research title', wc.classifyWorkClass({ title: 'Nationwide Car Dealership Lead Research — Phase 2', context: {} }) === 'mission');
  check('mission: EXECUTE … mission', wc.classifyWorkClass({ title: 'EXECUTE real-estate 1,000 mission — Milestones 1–3', context: {} }) === 'mission');
  check('mission context still wins over loop wording', wc.classifyWorkClass({ title: 'REWORK: leads', context: { missionId: 'm' } }) === 'mission');
  check('plain work stays background', wc.classifyWorkClass({ title: 'Draft onboarding email copy', context: {} }) === 'background');

  console.log('(1a) OpenRouter free-tier share per key');
  wc.__resetWorkClassBudgetForTest();
  check('default free quota per key = 1000', wc.openRouterFreeDailyRequestsPerKey() === 1000);
  const keyA = 'openrouter_free:OPENROUTER_FREE_API_KEY' as const;
  const keyB = 'openrouter_free:OPENROUTER_API_KEY_2' as const;
  let n = 0;
  while (wc.checkWorkClassShare(keyA, 'internal', 1000, 1).allowed) { wc.recordWorkClassUsage(keyA, 'internal', 1); n++; }
  check('internal loops stop at 250/1000 free requests on a key', n === 250);
  check('mission still admitted on that key', wc.checkWorkClassShare(keyA, 'mission', 1000, 1).allowed);
  check('other key has its own count', wc.checkWorkClassShare(keyB, 'internal', 1000, 1).allowed);
  check('snapshot reports per-key usage', wc.getWorkClassUsageSnapshot().usage[keyA].internal === 250);
  process.env.APEX_OPENROUTER_FREE_DAILY_REQUESTS = '0';
  check('0 disables the free-tier share', wc.checkWorkClassShare(keyA, 'internal', wc.openRouterFreeDailyRequestsPerKey(), 1).allowed);
  delete process.env.APEX_OPENROUTER_FREE_DAILY_REQUESTS;

  console.log('(1b) non-mission latch lets mission work through');
  ba.__resetCapacityLatchForTest();
  ba.__setNonMissionLatchForTest(Date.now() + 10 * 60_000);
  check('workspace latch NOT set by a non-mission pause', tq.taskClaimPausedMs() === 0);
  check('non-mission claims parked', tq.taskClaimNonMissionPausedMs() > 0);
  check('mission task is claimable', tq.isMissionLinkedTask({ title: 'Execute mission: X', context: { goalId: 'g', missionId: 'm' } }));
  check('mission by description', tq.isMissionLinkedTask({ title: 'x', description: 'EXECUTE MISSION (2f0294ea)', context: {} }));
  check('loop task not claimable', !tq.isMissionLinkedTask({ title: 'Delegation results: QA gate', context: { goalId: 'g' } }));
  check('SQL predicate covers missionId/campaignId/title/description',
    ['missionId', 'campaignId', "execute mission:%", 'EXECUTE MISSION ('].every((k) => tq.MISSION_TASK_SQL.includes(k)));
  ba.__setNonMissionLatchForTest(0);
  check('latch clears', tq.taskClaimNonMissionPausedMs() === 0);

  console.log('wiring');
  const q = read('packages/core/src/task-queue.ts');
  check('dequeue + claimById apply mission filter under non-mission pause',
    (q.match(/AND \$\{missionFilter\}/g) ?? []).length === 2 && (q.match(/isMissionLinkedTask\(task\)/g) ?? []).length === 2);
  const b = read('packages/core/src/base-agent.ts');
  check('mission pause → workspace latch; others → non-mission latch',
    /=== 'mission'\) \{\s*noteCapacityPause\(pauseAt\);\s*\} else \{[\s\S]{0,120}noteNonMissionCapacityPause\(pauseAt\)/.test(b));
  check('work-class deferral stays per-task', /if \(isWorkClassDeferral\(msg\)\) \{\s*\/\/ per-task only/.test(b));
  const l = read('packages/core/src/llm-client.ts');
  check('free-tier share checked per credential before dispatch', l.includes('`openrouter_free:${credential.env}`') && l.indexOf('checkWorkClassShare(\n                  freeShareResource') < l.indexOf('if (freeShareResource) recordWorkClassUsage'));
  console.log('\nmission-through-pause: all checks passed');
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
