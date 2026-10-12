/**
 * Guard: the operator rehearsal bypass (kill switch + suppression) applies to
 * the operator practising on themself and to nothing else.
 *
 * 2026-10-06: Matthew's own number (the saved rehearsal phone) carried two
 * stale suppressions (a "don't call again" on a 9/24 test call and a voice
 * agent's `dnc` on a 9/27 practice call), so every "Sell to me" call was
 * blocked. He also wants to practise while the outbound kill switch is on.
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
  maskRehearsalDestination,
  operatorRehearsalAllowlist,
  operatorRehearsalDailyCap,
  runWithSendCaller,
  type SendCaller,
  type SendChannel,
} from '../packages/core/src/send-safeguard.ts';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✅ ${name}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
}

const PHONE = '+18325550123';
const EMAIL = 'operator@example.com';
const PROSPECT = '+17135550199';

function engine(): { store: MemorySendSafeguardStore; safeguard: SendSafeguard } {
  const store = new MemorySendSafeguardStore();
  store.clock = new Date('2026-10-06T13:30:00.000Z');
  store.rehearsal = { phone: PHONE, email: EMAIL };
  return { store, safeguard: new SendSafeguard(store) };
}

async function attempt(
  safeguard: SendSafeguard,
  caller: SendCaller,
  channel: SendChannel,
  destination: string,
  opts: { operatorDirect?: boolean; operatorRehearsal?: boolean; payload?: Record<string, unknown>; extra?: string } = {},
): Promise<{ ok: true; bypass?: string[] } | { ok: false; reason: string }> {
  try {
    return await runWithSendCaller(caller, async () => {
      const recipients = [{ channel, destination, messageText: 'practice', payload: opts.payload }];
      if (opts.extra) recipients.push({ channel, destination: opts.extra, messageText: 'practice', payload: undefined });
      const created = await safeguard.createJob({
        caller,
        createdBy: caller === 'operator-dashboard' ? 'operator' : 'agent',
        operatorDirect: opts.operatorDirect,
        operatorRehearsal: opts.operatorRehearsal,
        recipients,
      });
      const cleared = await safeguard.assertSendAllowed(created.job.id, destination, channel);
      return { ok: true as const, bypass: cleared.rehearsalBypass };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof SendSafeguardError ? error.reason : `unexpected:${String(error)}` };
  }
}

const rehearsal = { operatorDirect: true, operatorRehearsal: true };

async function main(): Promise<void> {
  console.log('── configuration ──');
  check('allowlist unset → empty (bypass disabled)', operatorRehearsalAllowlist({}).size === 0);
  const list = operatorRehearsalAllowlist({ APEX_OPERATOR_REHEARSAL_DESTINATIONS: ' (832) 555-0123 , Operator@Example.com,junk' });
  check('allowlist normalizes phone and email, drops junk', list.has(PHONE) && list.has(EMAIL) && list.size === 2, JSON.stringify([...list]));
  check('daily cap defaults to 20', operatorRehearsalDailyCap({}) === 20);
  check('daily cap is configurable', operatorRehearsalDailyCap({ APEX_OPERATOR_REHEARSAL_DAILY_CAP: '5' }) === 5);
  check('masking keeps only the last 4 digits / the email domain', maskRehearsalDestination('phone', PHONE) === '***-***-0123' && maskRehearsalDestination('email', EMAIL) === '***@example.com');

  console.log('\n── allowlist unset: no bypass at all ──');
  delete process.env.APEX_OPERATOR_REHEARSAL_DESTINATIONS;
  {
    const { store, safeguard } = engine();
    store.killSwitch = true;
    const r = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, rehearsal);
    check('kill switch still blocks the rehearsal call', !r.ok && r.reason === 'kill_switch', JSON.stringify(r));
    store.killSwitch = false;
    store.suppressed.add(`all:${PHONE}`);
    const s = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, rehearsal);
    check('suppression still blocks the rehearsal call', !s.ok && s.reason === 'suppressed', JSON.stringify(s));
    check('no bypass audit rows', store.rehearsalAudit.length === 0);
  }

  process.env.APEX_OPERATOR_REHEARSAL_DESTINATIONS = `${PHONE},${EMAIL}`;

  console.log('\n── rehearsal + allowlisted + exact match: bypass ──');
  {
    const { store, safeguard } = engine();
    store.killSwitch = true;
    store.suppressed.add(`all:${PHONE}`);
    const call = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, rehearsal);
    check('rehearsal call goes out past kill switch + suppression', call.ok && JSON.stringify(call.bypass) === JSON.stringify(['kill switch', 'suppression']), JSON.stringify(call));
    const mail = await attempt(safeguard, 'operator-dashboard', 'email', 'OPERATOR@example.com', rehearsal);
    check('rehearsal email goes out past the kill switch (case-insensitive exact match)', mail.ok && JSON.stringify(mail.bypass) === JSON.stringify(['kill switch']), JSON.stringify(mail));
    check('each bypass wrote an outbound_audit row', store.rehearsalAudit.length === 2, String(store.rehearsalAudit.length));
    const row = store.rehearsalAudit[0];
    check('audit row text and masking', row?.detail === 'rehearsal destination: kill switch + suppression bypassed' && row.maskedDestination === '***-***-0123' && !JSON.stringify(store.rehearsalAudit).includes('5550123'), JSON.stringify(row));
    const events = await store.listEvents();
    check('safeguard event log records the bypass too', events.some((e) => e.detail.reason === 'operator_rehearsal_bypass'));
    store.killSwitch = false;
    store.suppressed.clear();
    const plain = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, rehearsal);
    check('nothing to bypass → no audit row, normal send', plain.ok && !plain.bypass && store.rehearsalAudit.length === 2, JSON.stringify(plain));
  }

  console.log('\n── everything else stays blocked by the kill switch ──');
  {
    const { store, safeguard } = engine();
    store.killSwitch = true;
    const prospect = await attempt(safeguard, 'operator-dashboard', 'phone', PROSPECT, rehearsal);
    check('a prospect number on a "rehearsal" job is blocked', !prospect.ok && prospect.reason === 'kill_switch', JSON.stringify(prospect));
    const agent = await attempt(safeguard, 'tool', 'phone', PHONE, rehearsal);
    check('an agent/tool call to the rehearsal phone is blocked', !agent.ok && agent.reason === 'kill_switch', JSON.stringify(agent));
    const agentForged = await attempt(safeguard, 'tool', 'phone', PHONE, { payload: { operatorRehearsal: true } });
    check('a forged payload marker from a tool is ignored', !agentForged.ok && agentForged.reason === 'kill_switch', JSON.stringify(agentForged));
    const voice = await attempt(safeguard, 'voice', 'phone', PHONE, {});
    check('a voice/agent call to the rehearsal phone is blocked', !voice.ok && voice.reason === 'kill_switch');
    const notDirect = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, { operatorRehearsal: true });
    check('operator send without operatorDirect is blocked', !notDirect.ok && notDirect.reason === 'kill_switch');
    const notRehearsal = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, { operatorDirect: true });
    check('operator-direct non-rehearsal send is blocked', !notRehearsal.ok && notRehearsal.reason === 'kill_switch');
    const bulk = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, { ...rehearsal, extra: PROSPECT });
    check('a multi-recipient ("bulk") rehearsal job is blocked', !bulk.ok && bulk.reason === 'kill_switch', JSON.stringify(bulk));
    const sms = await attempt(safeguard, 'operator-dashboard', 'sms', PHONE, rehearsal);
    check('SMS is never bypassed', !sms.ok && sms.reason === 'kill_switch');
    store.rehearsal = { phone: PROSPECT, email: EMAIL };
    const moved = await attempt(safeguard, 'operator-dashboard', 'phone', PROSPECT, rehearsal);
    check('changing the saved phone to a non-allowlisted number does not move the bypass', !moved.ok && moved.reason === 'kill_switch', JSON.stringify(moved));
    store.rehearsal = { phone: '+18325550124', email: EMAIL };
    const near = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, rehearsal);
    check('an allowlisted number that is not the saved phone is blocked', !near.ok && near.reason === 'kill_switch');
    check('none of these wrote a bypass row', store.rehearsalAudit.length === 0);
  }

  console.log('\n── suppression for non-rehearsal calls to the same number ──');
  {
    const { store, safeguard } = engine();
    store.suppressed.add(`phone:${PHONE}`);
    const opCall = await runWithSendCaller('operator-dashboard', async () => {
      const job = await safeguard.createJob({ caller: 'operator-dashboard', createdBy: 'operator', recipients: [{ channel: 'phone', destination: PHONE, messageText: 'x' }] });
      await safeguard.confirm(job.job.id, 'operator-dashboard', 1);
      await safeguard.confirm(job.job.id, 'operator-dashboard', 2);
      try { await safeguard.assertSendAllowed(job.job.id, PHONE, 'phone'); return 'sent'; } catch (e) { return e instanceof SendSafeguardError ? e.reason : 'error'; }
    });
    check('a normal (non-rehearsal) operator call to that number is still suppressed', opCall === 'suppressed', opCall);
    const tool = await attempt(safeguard, 'tool', 'phone', PHONE, {});
    check('a tool call is still blocked (awaiting confirm happens after suppression)', !tool.ok && tool.reason === 'suppressed', JSON.stringify(tool));
  }

  console.log('\n── lockout and audit failure ──');
  {
    const { store, safeguard } = engine();
    store.killSwitch = true;
    store.code = { ...store.code, locked: true };
    const locked = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, rehearsal);
    check('the send-code lockout is never bypassed', !locked.ok && locked.reason === 'locked', JSON.stringify(locked));
    store.code = { ...store.code, locked: false };
    store.recordRehearsalBypass = async () => { throw new Error('db down'); };
    const unaudited = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, rehearsal);
    check('no audit row → no bypass (kill switch holds)', !unaudited.ok && unaudited.reason === 'kill_switch', JSON.stringify(unaudited));
  }

  console.log('\n── daily cap ──');
  {
    process.env.APEX_OPERATOR_REHEARSAL_DAILY_CAP = '3';
    const { store, safeguard } = engine();
    store.killSwitch = true;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, rehearsal));
    check('the first 3 bypasses go out', results.slice(0, 3).every((r) => r.ok));
    check('the 4th is blocked by the kill switch', !results[3]!.ok && (results[3] as { reason: string }).reason === 'kill_switch', JSON.stringify(results[3]));
    store.clock = new Date(store.clock.getTime() + 24 * 60 * 60 * 1000 + 1000);
    const nextDay = await attempt(safeguard, 'operator-dashboard', 'phone', PHONE, rehearsal);
    check('the window rolls after 24 hours', nextDay.ok);
    delete process.env.APEX_OPERATOR_REHEARSAL_DAILY_CAP;
  }

  console.log('\n── wiring (source checks) ──');
  const read = (p: string) => readFileSync(resolve(here, '..', p), 'utf8');
  const salesFloor = read('packages/api-server/src/routes/sales-floor.ts');
  const registry = read('packages/core/src/tool-registry.ts');
  const cartesiaSales = read('packages/api-server/src/routes/cartesia-sales.ts');
  const guard = read('packages/core/src/outbound-compliance-guard.ts');
  check('rehearsal flag comes only from a validated operator dashboard session', salesFloor.includes("operatorDashboardSessionValid(req.header('x-apex-operator-session')") && (salesFloor.match(/operatorSession: await requestHasOperatorSession\(req\)/g) ?? []).length === 2);
  check('both rehearsal sends pass operatorRehearsal from that session', (salesFloor.match(/operatorRehearsal: target\.operatorSession/g) ?? []).length === 2);
  check('agent tools never set operatorDirect or operatorRehearsal', !registry.includes('operatorDirect') && !registry.includes('operatorRehearsal'));
  check('rehearsal phone/email can only be changed with an operator session', salesFloor.includes('Changing the rehearsal phone or email requires a signed-in operator dashboard session.'));
  check('voice agent dnc never suppresses the saved rehearsal phone', cartesiaSales.includes('isSavedRehearsalPhone(p.phone_number)') && cartesiaSales.includes('suppression NOT written'));
  check('expired suppressions are ignored by the Cartesia tools and the compliance guard', cartesiaSales.includes('gt(suppressions.expiresAt, new Date())') && (guard.match(/gt\(suppressions\.expiresAt, new Date\(\)\)/g) ?? []).length === 2);

  console.log(failures === 0 ? '\n✅ Rehearsal bypass is tight.\n' : `\n❌ ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
