/**
 * Mission-first LLM budget split (work-class-budget.ts):
 *  - mission/campaign tasks get first claim (60% reserve by default);
 *  - internal delegation/verification loops are capped (25% by default) and
 *    the same internal task is backed off after N runs per window;
 *  - operator chat is never restricted; caps themselves are unchanged;
 *  - a share deferral is per-task and never latches the workspace pause.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyWorkClass,
  checkWorkClassShare,
  recordWorkClassUsage,
  checkInternalLoopRepeat,
  internalLoopSignature,
  formatWorkClassDeferral,
  isWorkClassDeferral,
  missionReservePct,
  internalLoopMaxPct,
  getWorkClassUsageSnapshot,
  __resetWorkClassBudgetForTest,
} from '../packages/core/src/work-class-budget.js';
import { isLLMCapacityPause, getLLMCapacityResumeAt } from '../packages/core/src/provider-failure.js';

const root = process.env.GITHUB_WORKSPACE ??
  (fs.existsSync(path.join(process.cwd(), 'packages/core')) ? process.cwd() : path.resolve(process.cwd(), '../..'));
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  console.log(`  ok  ${label}`);
}
for (const k of ['APEX_MISSION_RESERVE_PCT', 'APEX_INTERNAL_LOOP_MAX_PCT', 'APEX_INTERNAL_LOOP_REPEAT_MAX', 'APEX_INTERNAL_LOOP_WINDOW_MINUTES']) delete process.env[k];

console.log('classification');
check('mission context → mission', classifyWorkClass({ title: 'x', context: { goalId: 'g', missionId: 'm' } }) === 'mission');
check('campaign context → mission', classifyWorkClass({ title: 'x', context: { campaignId: 'c' } }) === 'mission');
check('"Execute mission:" title → mission', classifyWorkClass({ title: 'Execute mission: Find 25 HVAC leads', context: {} }) === 'mission');
check('EXECUTE MISSION description → mission', classifyWorkClass({ title: 'x', description: 'EXECUTE MISSION (2f0294ea)' }) === 'mission');
for (const t of ['CEO VERIFY goal 1234abcd progress', 'VERIFY-ONLY: confirm PATCH landed', 'Delegation verdict for task 9f9f9f9f', 'BLOCKER: tool missing', 'JUDGE: review output', 'Re-attempt verification of deploy', 'Verify credit levels on providers', 'closeout: wave-3']) {
  check(`internal: "${t}"`, classifyWorkClass({ title: t, context: {} }) === 'internal');
}
check('mission linkage wins over verify wording', classifyWorkClass({ title: 'VERIFY leads', context: { missionId: 'm' } }) === 'mission');
check('operator lane → operator', classifyWorkClass({ title: 'VERIFY x', operatorLane: true }) === 'operator');
check('ordinary task → background', classifyWorkClass({ title: 'Draft blog post outline', context: {} }) === 'background');

console.log('defaults + env clamping');
check('mission reserve default 60', missionReservePct() === 60);
check('internal max default 25', internalLoopMaxPct() === 25);
process.env.APEX_MISSION_RESERVE_PCT = '250';
process.env.APEX_INTERNAL_LOOP_MAX_PCT = 'abc';
check('invalid env falls back to safe defaults', missionReservePct() === 60 && internalLoopMaxPct() === 25);
process.env.APEX_MISSION_RESERVE_PCT = '50';
check('env override honoured', missionReservePct() === 50);
delete process.env.APEX_MISSION_RESERVE_PCT; delete process.env.APEX_INTERNAL_LOOP_MAX_PCT;

console.log('shares (cap 100 requests)');
__resetWorkClassBudgetForTest();
const T = Date.parse('2026-10-23T06:20:00Z');
let internalAdmitted = 0;
while (checkWorkClassShare('requests', 'internal', 100, 1, T).allowed) { recordWorkClassUsage('requests', 'internal', 1, T); internalAdmitted++; }
check('internal loops stop at 25% of the cap', internalAdmitted === 25);
let bgAdmitted = 0;
while (checkWorkClassShare('requests', 'background', 100, 1, T).allowed) { recordWorkClassUsage('requests', 'background', 1, T); bgAdmitted++; }
check('internal+background stop at 40% (60% mission reserve)', internalAdmitted + bgAdmitted === 40);
const denied = checkWorkClassShare('requests', 'background', 100, 1, T);
check('denial resumes at next UTC midnight', denied.resumeAt === '2026-10-24T00:00:00.000Z');
check('mission still admitted after non-mission exhausted its share', checkWorkClassShare('requests', 'mission', 100, 1, T).allowed);
check('operator still admitted', checkWorkClassShare('requests', 'operator', 100, 1, T).allowed);
check('no cap configured → no share applies', checkWorkClassShare('tokens', 'internal', 0, 1e9, T).allowed);
check('UTC rollover resets usage', checkWorkClassShare('requests', 'internal', 100, 1, Date.parse('2026-10-24T00:00:01Z')).allowed);
check('snapshot exposes usage', getWorkClassUsageSnapshot(Date.parse('2026-10-24T00:00:01Z')).usage.requests.internal === 0);

console.log('internal loop dedupe/backoff');
__resetWorkClassBudgetForTest();
check('signature strips ids/numbers',
  internalLoopSignature('CEO VERIFY goal 1f2e3d4c-aaaa-bbbb-cccc-111122223333 (wave 3)') === internalLoopSignature('CEO VERIFY goal 9e8d7c6b-0000-1111-2222-333344445555 (wave 7)'));
const t0 = Date.parse('2026-10-23T01:00:00Z');
check('run 1 admitted', checkInternalLoopRepeat('t1', 'CEO VERIFY goal abc12345', t0).allowed);
check('same task, later call, not cut off', checkInternalLoopRepeat('t1', 'CEO VERIFY goal abc12345', t0 + 1000).allowed);
check('run 2 admitted', checkInternalLoopRepeat('t2', 'CEO VERIFY goal def67890', t0 + 2000).allowed);
const rep = checkInternalLoopRepeat('t3', 'CEO VERIFY goal 0a0a0a0a', t0 + 3000);
check('run 3 of same loop deferred', !rep.allowed);
check('backoff resumes when oldest run leaves 6h window', rep.resumeAt === new Date(t0 + 6 * 3600_000).toISOString());
check('different internal task unaffected', checkInternalLoopRepeat('t4', 'Delegation verdict for X', t0 + 3000).allowed);
check('admitted again after window', checkInternalLoopRepeat('t5', 'CEO VERIFY goal 11111111', t0 + 6 * 3600_000 + 5000).allowed);

console.log('deferral is per-task, not a workspace latch');
const msg = formatWorkClassDeferral(denied);
check('queue treats it as a capacity pause (requeue, no failure)', isLLMCapacityPause(msg));
check('resume-at parsed by queue', getLLMCapacityResumeAt(msg)?.toISOString() === '2026-10-24T00:00:00.000Z');
check('recognised as work-class deferral', isWorkClassDeferral(msg));
check('ordinary capacity pause is NOT a work-class deferral',
  !isWorkClassDeferral('APEX LLM capacity paused. resume-at=2026-10-23T06:59:59Z | workspace: token budget'));
const base = read('packages/core/src/base-agent.ts');
check('base-agent skips noteCapacityPause for work-class deferrals', /if \(!isWorkClassDeferral\(msg\)\) \{\s*noteCapacityPause/.test(base));

console.log('wiring');
const llm = read('packages/core/src/llm-client.ts');
check('llm-client checks request + token shares', llm.includes("checkWorkClassShare('requests'") && llm.includes("checkWorkClassShare('tokens'"));
check('llm-client checks paid spend share before tryReservePaidSpend',
  llm.indexOf("checkWorkClassShare(\n                  'spend_micros'") > 0 &&
  llm.indexOf("checkWorkClassShare(\n                  'spend_micros'") < llm.indexOf('const paidReservation = provider.paid'));
check('untagged direct callers are not throttled', llm.includes("execution?.workClass ?? 'mission'"));
check('operator lane maps to operator class', /operatorLane \|\| execution\?\.operatorLane\s*\?\s*'operator'/.test(llm));
const inst = read('packages/core/src/instrumented-base-agent.ts');
check('tasks are classified into the execution context', inst.includes('workClass: classifyWorkClass({ title, description, context })'));
const spend = read('packages/core/src/spend-ledger.ts');
check('daily spend cap still read from APEX_DAILY_SPEND_USD', spend.includes('APEX_DAILY_SPEND_USD'));

console.log('\nmission-first budget: all checks passed');
