/**
 * Guard: Matthew can always have APEX rehearse / "practice pitch me" from the
 * operator chat, even with the outbound kill switch on — and that path can
 * never reach anyone but his saved, allowlisted rehearsal phone/email.
 *
 * 2026-10-06: #313 let the Sales Floor "Sell to me" button through the kill
 * switch, but asking APEX in chat went create_goal → agent make_outbound_call
 * (caller "tool"), which the send safeguard blocks while the kill switch is on.
 * The chat now has a rehearse_with_me tool that runs the SAME operator
 * rehearsal as Sales Floor, only when the chat request carried a valid
 * operator dashboard session.
 *
 * No database, no provider calls.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MemorySendSafeguardStore,
  SendSafeguard,
  SendSafeguardError,
  runWithSendCaller,
  type SendCaller,
  type SendChannel,
} from '../packages/core/src/send-safeguard.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { console.log(`  ✅ ${name}`); return; }
  failures += 1;
  console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
}
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const PHONE = '+18325550123';
const EMAIL = 'operator@example.com';
const PROSPECT = '+17135550199';

function engine(killSwitch = true) {
  const store = new MemorySendSafeguardStore();
  store.clock = new Date('2026-10-06T15:00:00.000Z');
  store.killSwitch = killSwitch;
  store.rehearsal = { phone: PHONE, email: EMAIL };
  return { store, safeguard: new SendSafeguard(store) };
}

async function attempt(safeguard: SendSafeguard, caller: SendCaller, channel: SendChannel, destination: string, rehearsal: boolean) {
  try {
    return await runWithSendCaller(caller, async () => {
      const created = await safeguard.createJob({
        caller,
        createdBy: caller === 'operator-dashboard' ? 'operator' : 'agent',
        operatorDirect: rehearsal,
        operatorRehearsal: rehearsal,
        recipients: [{ channel, destination, messageText: 'practice' }],
      });
      const cleared = await safeguard.assertSendAllowed(created.job.id, destination, channel);
      return { ok: true as const, bypass: cleared.rehearsalBypass ?? [] };
    });
  } catch (error) {
    return { ok: false as const, reason: error instanceof SendSafeguardError ? error.reason : `unexpected:${String(error)}` };
  }
}

async function main(): Promise<void> {
  process.env.APEX_OPERATOR_REHEARSAL_DESTINATIONS = `${PHONE},${EMAIL}`;
  delete process.env.APEX_OPERATOR_REHEARSAL_DAILY_CAP;

  console.log('── chat wiring (source) ──');
  const chat = read('packages/api-server/src/routes/chat.ts');
  const floor = read('packages/api-server/src/routes/sales-floor.ts');
  const toolDecl = /name: 'rehearse_with_me',[\s\S]*?parameters: \{ type: 'object', properties: \{\} \}/.exec(chat);
  check('the chat offers a rehearse_with_me tool', /CHAT_TOOLS: LLMTool\[\] = \[[\s\S]*name: 'rehearse_with_me'/.test(chat));
  check('rehearse_with_me takes no destination (no phone/email/number parameter)', Boolean(toolDecl));
  const caseBody = /case 'rehearse_with_me': \{([\s\S]*?)\n    \}/.exec(chat)?.[1] ?? '';
  check('the tool refuses unless the request had an operator session, before doing anything',
    /options\.operatorSession !== true/.test(caseBody)
      && caseBody.indexOf('options.operatorSession !== true') < caseBody.indexOf('startOperatorSelfRehearsal('));
  check('the tool runs the same operator rehearsal as Sales Floor', /startOperatorSelfRehearsal\(\{ operatorSession: true \}\)/.test(caseBody));
  check('the tool never reads a destination from the model\'s arguments', !/call\.args/.test(caseBody));
  check('/message derives operatorSession from a validated x-apex-operator-session header',
    /operatorSession = await operatorDashboardSessionValid\(typeof header === 'string' \? header : null\)/.test(chat)
      && /req\.header\('x-apex-operator-session'\)/.test(chat));
  check('/message passes that session to executeTool', /executeTool\(call, ceo, \{ operatorSession \}\)/.test(chat));
  check('executeTool defaults to no operator session (voice and other callers)', /options: ChatToolOptions = \{\}/.test(chat));
  for (const p of ['packages/api-server/src/live-voice.ts', 'packages/api-server/src/gemini-live-session.ts']) {
    check(`${p.split('/').pop()} does not grant an operator session`, !/operatorSession: true/.test(read(p)));
  }
  check('Copilot mode does not expose rehearse_with_me', !read('packages/api-server/src/copilot-actions.ts').includes("'rehearse_with_me'"));
  const helper = /export async function startOperatorSelfRehearsal\([\s\S]*?\n\}/.exec(floor)?.[0] ?? '';
  check('the shared helper only ever targets the saved policy rehearsal email/phone',
    /loadOutboundPolicy\(\)/.test(helper) && /runRehearsal\(policy,/.test(helper) && !/toNumber|destination:/.test(helper));
  check('runRehearsal dials/mails only policy.rehearsalPhone / policy.rehearsalEmail',
    /toEmail: policy\.rehearsalEmail/.test(floor) && !/toNumber: target\./.test(floor));
  check('Sales Floor "Sell to me" uses the same helper', /startOperatorSelfRehearsal\(\{ operatorSession: await requestHasOperatorSession\(req\) \}\)/.test(floor));
  check('kill switch on: only an operator-session rehearsal to allowlisted saved destinations may continue',
    /if \(policy\.killSwitch\) \{[\s\S]*?target\.operatorSession[\s\S]*?operatorRehearsalDestinationAllowlisted\('phone', policy\.rehearsalPhone\)/.test(floor));
  check('the chat prompt routes "practice pitch me" to rehearse_with_me, never a goal or another number',
    /rehearse_with_me right\s+away \(do not create a goal\)/.test(chat) && /Never use it, or anything else, to reach a prospect/.test(chat));

  console.log('\n── send safeguard, kill switch ON (what the chat path runs) ──');
  {
    const { store, safeguard } = engine(true);
    const phone = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, true);
    check('operator rehearsal call to the saved allowlisted phone is allowed', phone.ok && phone.bypass.includes('kill switch'), JSON.stringify(phone));
    check('…and writes a rehearsal_bypass audit row (masked)', store.rehearsalAudit.length === 1 && store.rehearsalAudit[0]!.maskedDestination === '***-***-0123', JSON.stringify(store.rehearsalAudit));
    const email = await attempt(safeguard, 'operator-dashboard', 'email', EMAIL, true);
    check('operator rehearsal email to the saved allowlisted email is allowed the same way', email.ok && email.bypass.includes('kill switch') && store.rehearsalAudit.length === 2, JSON.stringify(email));
  }
  {
    const { safeguard } = engine(true);
    check('an agent/tool call to the same number is still blocked by the kill switch', (await attempt(safeguard, 'tool', 'phone', PHONE, false)).ok === false);
    check('an agent/tool email to the saved address is still blocked', (await attempt(safeguard, 'tool', 'email', EMAIL, false)).ok === false);
    check('a rehearsal aimed at a prospect is blocked', (await attempt(safeguard, 'operator-dashboard', 'phone', PROSPECT, true)).ok === false);
    check('a background job cannot claim rehearsal', (await attempt(safeguard, 'background-job', 'phone', PHONE, true)).ok === false);
  }
  {
    const { store, safeguard } = engine(true);
    process.env.APEX_OPERATOR_REHEARSAL_DESTINATIONS = EMAIL;
    check('the saved phone must also be on APEX_OPERATOR_REHEARSAL_DESTINATIONS', (await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, true)).ok === false && store.rehearsalAudit.length === 0);
    process.env.APEX_OPERATOR_REHEARSAL_DESTINATIONS = `${PHONE},${EMAIL}`;
  }
  {
    const { safeguard } = engine(true);
    process.env.APEX_OPERATOR_REHEARSAL_DAILY_CAP = '2';
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, true));
    check('the rehearsal daily cap still applies (3rd of cap 2 is blocked)', results[0]!.ok && results[1]!.ok && !results[2]!.ok, JSON.stringify(results));
    delete process.env.APEX_OPERATOR_REHEARSAL_DAILY_CAP;
  }

  console.log(failures === 0 ? '\n✅ Chat rehearsal works through the kill switch and reaches only the operator.\n' : `\n❌ ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
