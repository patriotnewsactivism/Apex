// Guard: Vapi no-answer handling + silence timeout (2026-10-14).
// Pure checks plus source assertions; never dials, never touches the DB.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  isUnansweredNoAudio,
  planNoAnswerRetry,
  NO_ANSWER_RETRY_MAX_PER_DAY,
  NO_ANSWER_RETRY_MIN_GAP_MS,
} from '../packages/core/src/no-answer-retry.js';
import { emptyOutboundPolicy, type OutboundPolicySnapshot } from '../packages/core/src/outbound-policy.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}`); }
}
function findRoot(): string {
  let dir = process.cwd();
  while (!existsSync(resolve(dir, 'pnpm-workspace.yaml')) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
const root = findRoot();
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const R = 'call.in-progress.error-assistant-did-not-receive-customer-audio';
check('no-audio reason with empty transcript is unanswered', isUnansweredNoAudio({ endedReason: R, transcript: '', messages: [] }));
check('bare reason (no prefix) is unanswered', isUnansweredNoAudio({ endedReason: 'assistant-did-not-receive-customer-audio' }));
check('other prefix is unanswered', isUnansweredNoAudio({ endedReason: 'pipeline-error-assistant-did-not-receive-customer-audio' }));
check('assistant-only messages still unanswered', isUnansweredNoAudio({ endedReason: R, messages: [{ role: 'system', message: 'x' }, { role: 'bot', message: 'Hi, this is Don' }], transcript: 'AI: Hi, this is Don' }));
check('customer transcript line => not unanswered', !isUnansweredNoAudio({ endedReason: R, transcript: 'AI: Hi\nUser: hello?' }));
check('customer message => not unanswered', !isUnansweredNoAudio({ endedReason: R, messages: [{ role: 'user', message: 'hello' }] }));
check('connected seconds > 0 => not unanswered', !isUnansweredNoAudio({ endedReason: R, connectedSeconds: 4 }));
check('different reason => not unanswered', !isUnansweredNoAudio({ endedReason: 'customer-ended-call' }));

const live: OutboundPolicySnapshot = { ...emptyOutboundPolicy(), mode: 'capped_live', timezone: 'America/Chicago', sendWindowStartHour: 8, sendWindowEndHour: 19 };
const at = (iso: string) => new Date(iso);
// 10:00 CT = 15:00Z (CDT)
const now = at('2026-10-14T15:00:00Z');
const p1 = planNoAnswerRetry({ now, policy: live, retriesScheduled: [], attempts: [now] });
check('first retry scheduled', p1.schedule === true);
check('retry at least 10 minutes after last attempt', p1.schedule === true && p1.notBefore.getTime() - now.getTime() >= NO_ANSWER_RETRY_MIN_GAP_MS);
const p2 = planNoAnswerRetry({ now, policy: live, retriesScheduled: [now], attempts: [now] });
check('second retry allowed', p2.schedule === true && p2.retryNumber === 2);
const p3 = planNoAnswerRetry({ now, policy: live, retriesScheduled: [now, now], attempts: [now] });
check(`no more than ${NO_ANSWER_RETRY_MAX_PER_DAY} retries per day`, p3.schedule === false);
const later = new Date(now.getTime() + 30 * 60_000);
const p4 = planNoAnswerRetry({ now, policy: live, retriesScheduled: [], attempts: [later] });
check('gap measured from latest attempt', p4.schedule === true && p4.notBefore.getTime() >= later.getTime() + NO_ANSWER_RETRY_MIN_GAP_MS);
// 18:55 CT -> +10 min is 19:05, outside window
const p5 = planNoAnswerRetry({ now: at('2026-10-14T23:55:00Z'), policy: live, retriesScheduled: [], attempts: [] });
check('never scheduled outside calling hours / into tomorrow', p5.schedule === false);
// 07:30 CT -> pushed to 08:00 CT
const p6 = planNoAnswerRetry({ now: at('2026-10-14T12:30:00Z'), policy: live, retriesScheduled: [], attempts: [] });
check('early-morning retry waits for window start', p6.schedule === true && p6.notBefore.toISOString() === '2026-10-14T13:00:00.000Z');
check('kill switch => no retry', planNoAnswerRetry({ now, policy: { ...live, killSwitch: true }, retriesScheduled: [], attempts: [] }).schedule === false);
check('mode off => no retry', planNoAnswerRetry({ now, policy: { ...live, mode: 'off' }, retriesScheduled: [], attempts: [] }).schedule === false);
check('policy unavailable => no retry', planNoAnswerRetry({ now, policy: null, retriesScheduled: [], attempts: [] }).schedule === false);
check('yesterday retries do not count today', planNoAnswerRetry({ now, policy: live, retriesScheduled: [at('2026-10-13T15:00:00Z'), at('2026-10-13T16:00:00Z')], attempts: [] }).schedule === true);

const vapi = read('packages/api-server/src/routes/vapi.ts');
const sched = vapi.slice(vapi.indexOf('export async function scheduleNoAnswerRetry'), vapi.indexOf('async function createStripeCheckoutSession'));
check('webhook classifies unanswered as no_answer', /isUnansweredNoAudio\(/.test(vapi) && /fallbackDispositionFromEndedReason\(String\(endedReason\), \{ unanswered \}\)/.test(vapi) && /if \(opts\.unanswered\) return 'no_answer'/.test(vapi));
check('retry is a queued task, never a direct dial', sched.length > 0 && !/fetch\(/.test(sched) && !/startCartesiaSalesCall|api\.vapi\.ai|api\.telnyx/.test(sched));
check('retry task targets make_outbound_call (normal gate) with nextRetryAt', /make_outbound_call/.test(sched) && /nextRetryAt: plan\.notBefore/.test(sched));
check('retry dedupes per source call', /sourceCallId === input\.callId/.test(sched));

const reg = read('packages/core/src/tool-registry.ts');
const inbound = read('packages/api-server/src/vapi-inbound-latency.ts');
check('configure_inbound_assistant sets silenceTimeoutSeconds 30', /silenceTimeoutSeconds:\s*30/.test(reg));
check('inbound reconciler patches silenceTimeoutSeconds 30', (inbound.match(/silenceTimeoutSeconds/g) ?? []).length >= 2 && /silenceTimeoutSeconds:\s*30/.test(inbound));
const policyStore = read('packages/core/src/outbound-policy.ts');
check('make_outbound_call is still a gated sales outbound tool', /'make_outbound_call'/.test(policyStore) && /killSwitch\) return deny/.test(policyStore));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
