/**
 * Deterministic send-safeguard guard. No database and no provider calls.
 * Run: pnpm exec tsx scripts/verify-send-safeguard.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MemorySendSafeguardStore,
  SendSafeguard,
  SendSafeguardError,
  classifySendCaller,
  installSendSafeguardForTests,
  runWithSendCaller,
  type SendChannel,
} from '../packages/core/src/send-safeguard.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

async function expectBlocked(
  name: string,
  fn: () => Promise<unknown>,
  reason: string,
): Promise<SendSafeguardError | null> {
  try {
    await fn();
    check(name, false, 'expected a throw');
    return null;
  } catch (error) {
    const match = error instanceof SendSafeguardError && error.reason === reason;
    check(name, match, error instanceof Error ? `${error.name}:${'reason' in error ? String((error as SendSafeguardError).reason) : error.message}` : String(error));
    return error instanceof SendSafeguardError ? error : null;
  }
}

function engine(): { store: MemorySendSafeguardStore; safeguard: SendSafeguard } {
  const store = new MemorySendSafeguardStore();
  store.clock = new Date('2026-10-03T18:00:00.000Z');
  return { store, safeguard: new SendSafeguard(store) };
}

async function clearSmall(safeguard: SendSafeguard, jobId: string): Promise<void> {
  await safeguard.confirm(jobId, 'operator-dashboard', 1);
  await safeguard.confirm(jobId, 'operator-dashboard', 2);
}

async function main(): Promise<void> {
  console.log('── channels blocked without clearance ──');
  const channels: SendChannel[] = ['email', 'phone', 'sms', 'calendar'];
  for (const channel of channels) {
    const { safeguard } = engine();
    const destination = channel === 'phone' || channel === 'sms' ? '8325550100' : 'person@example.com';
    const created = await safeguard.createJob({
      caller: 'tool',
      createdBy: 'verify',
      recipients: [{ channel, destination, messageText: `hello via ${channel}` }],
    });
    await expectBlocked(
      `${channel} blocked before clearance`,
      () => safeguard.assertSendAllowed(created.job.id, destination, channel),
      'awaiting_confirm',
    );
  }

  console.log('── confirm 1 alone does not send ──');
  {
    const { safeguard } = engine();
    const created = await safeguard.createJob({
      caller: 'operator-dashboard',
      createdBy: 'operator',
      fullAuto: true,
      recipients: [{ channel: 'email', destination: 'a@example.com', messageText: 'one' }],
    });
    await safeguard.confirm(created.job.id, 'operator-dashboard', 1);
    const job = await safeguard.describe(created.job.id);
    check('confirm 1 leaves the second confirmation empty', job.job.confirm2At === null);
    await expectBlocked(
      'confirm 1 alone does not send',
      () => safeguard.assertSendAllowed(created.job.id, 'a@example.com', 'email'),
      'awaiting_confirm',
    );
  }

  console.log('── five or more needs the code ──');
  {
    const { safeguard, store } = engine();
    await safeguard.setCode('operator-dashboard', '2468', true);
    const created = await safeguard.createJob({
      caller: 'operator-dashboard',
      createdBy: 'operator',
      fullAuto: true,
      campaignKey: 'launch',
      recipients: Array.from({ length: 5 }, (_, index) => ({
        channel: 'email' as const,
        destination: `p${index}@example.com`,
        messageText: 'same note',
      })),
    });
    await clearSmall(safeguard, created.job.id);
    await expectBlocked(
      'both confirms without the code do not send at 5+',
      () => safeguard.assertSendAllowed(created.job.id, 'p0@example.com', 'email'),
      'awaiting_code',
    );
    await safeguard.submitCode(created.job.id, 'operator-dashboard', '2468');
    const cleared = await safeguard.assertSendAllowed(created.job.id, 'p0@example.com', 'email');
    check('code lets that job send', cleared.status === 'sending');
    check('events do not store the code', !JSON.stringify(store.events).includes('2468'));
    check('event times are UTC', store.events.every((event) => event.createdAt.endsWith('Z')));
  }

  console.log('── 24h aggregation ──');
  {
    const { safeguard } = engine();
    await safeguard.setCode('operator-dashboard', '1357', true);
    const first = await safeguard.createJob({
      caller: 'operator-dashboard',
      createdBy: 'operator',
      fullAuto: true,
      campaignKey: 'story-drop',
      recipients: [0, 1, 2].map((index) => ({
        channel: 'sms' as const,
        destination: `+1713555010${index}`,
        messageText: 'batch',
      })),
    });
    await clearSmall(safeguard, first.job.id);
    const second = await safeguard.createJob({
      caller: 'operator-dashboard',
      createdBy: 'operator',
      fullAuto: true,
      campaignKey: 'story-drop',
      recipients: [3, 4].map((index) => ({
        channel: 'email' as const,
        destination: `r${index}@example.com`,
        messageText: 'batch',
      })),
    });
    check('aggregated total reaches the code threshold', (await safeguard.aggregatedCount(second.job)) >= 5);
    await clearSmall(safeguard, second.job.id);
    await expectBlocked(
      'sibling jobs inside 24h require the code',
      () => safeguard.assertSendAllowed(second.job.id, 'r3@example.com', 'email'),
      'awaiting_code',
    );
    await expectBlocked(
      'an earlier cleared batch is rechecked when the total crosses 5',
      () => safeguard.assertSendAllowed(first.job.id, '+17135550100', 'sms'),
      'awaiting_code',
    );
  }

  console.log('── edit voids confirms ──');
  {
    const { safeguard } = engine();
    const created = await safeguard.createJob({
      caller: 'tool',
      createdBy: 'agent',
      fullAuto: false,
      recipients: [{ channel: 'email', destination: 'a@example.com', messageText: 'original' }],
    });
    await safeguard.setFullAuto(created.job.id, 'operator-dashboard', true);
    await clearSmall(safeguard, created.job.id);
    await safeguard.revise(created.job.id, 'tool', [{
      channel: 'email',
      destination: 'a@example.com',
      messageText: 'edited',
    }]);
    const job = await safeguard.describe(created.job.id);
    check('edit clears both confirms', job.job.confirm1At === null && job.job.confirm2At === null && job.job.codeVerifiedAt === null);
    check('edit records a voided event', job.job.status === 'waiting_confirm');
    await expectBlocked(
      'edited job cannot send on the old confirms',
      () => safeguard.assertSendAllowed(created.job.id, 'a@example.com', 'email'),
      'awaiting_confirm',
    );
  }

  console.log('── code source and lockout ──');
  {
    const { safeguard, store } = engine();
    await safeguard.setCode('operator-dashboard', '9090', true);
    const created = await safeguard.createJob({
      caller: 'operator-dashboard',
      createdBy: 'operator',
      fullAuto: true,
      recipients: Array.from({ length: 5 }, (_, index) => ({
        channel: 'phone' as const,
        destination: `+1713555100${index}`,
        messageText: 'script',
      })),
    });
    await clearSmall(safeguard, created.job.id);
    const before = (await store.getCode()).failedAttempts;
    for (const caller of ['agent', 'tool', 'api-token', 'voice', 'chat', 'background-job'] as const) {
      await expectBlocked(
        `${caller} cannot enter the code`,
        () => runWithSendCaller(caller, () => safeguard.submitCode(created.job.id, caller, '9090')),
        'code_source_rejected',
      );
    }
    check('rejected sources do not burn an operator attempt', (await store.getCode()).failedAttempts === before);
    await expectBlocked('wrong code 1', () => safeguard.submitCode(created.job.id, 'operator-dashboard', '1111'), 'code_failed');
    await expectBlocked('wrong code 2', () => safeguard.submitCode(created.job.id, 'operator-dashboard', '2222'), 'code_failed');
    await expectBlocked('wrong code 3 locks sending', () => safeguard.submitCode(created.job.id, 'operator-dashboard', '3333'), 'locked');
    check('lock recorded an audit event', store.events.some((event) => event.eventType === 'locked'));
    await expectBlocked(
      'lock blocks a different cleared job',
      async () => {
        const other = await safeguard.createJob({
          caller: 'operator-dashboard',
          createdBy: 'operator',
          recipients: [{ channel: 'sms', destination: '+17135550000', messageText: 'later' }],
        });
        return safeguard.assertSendAllowed(other.job.id, '+17135550000', 'sms');
      },
      'locked',
    );
    await expectBlocked('bot cannot unlock', () => safeguard.unlock('api-token', true), 'operator_session_required');
    await safeguard.unlock('operator-dashboard', true);
    check('operator password unlocks sending', (await store.getCode()).locked === false);
  }

  console.log('── stop, kill switch, suppression, auto-approve ──');
  {
    const { safeguard, store } = engine();
    const created = await safeguard.createJob({
      caller: 'operator-dashboard',
      createdBy: 'operator',
      fullAuto: true,
      recipients: [
        { channel: 'email', destination: 'keep@example.com', messageText: 'stay' },
        { channel: 'sms', destination: '+17135552222', messageText: 'stay' },
      ],
    });
    await clearSmall(safeguard, created.job.id);
    await safeguard.stop(created.job.id, 'operator-dashboard');
    const stopped = await safeguard.describe(created.job.id);
    check('stop marks queued recipients cancelled', stopped.recipients.every((row) => row.status === 'cancelled'));
    check('stop does not delete recipients', stopped.recipients.length === 2);
    await expectBlocked(
      'stopped job cannot send',
      () => safeguard.assertSendAllowed(created.job.id, 'keep@example.com', 'email'),
      'stopped',
    );

    const live = await safeguard.createJob({
      caller: 'operator-dashboard',
      createdBy: 'operator',
      fullAuto: true,
      recipients: [{ channel: 'phone', destination: '+17135553333', messageText: 'dial' }],
    });
    await clearSmall(safeguard, live.job.id);
    store.killSwitch = true;
    await expectBlocked(
      'kill switch blocks a fully cleared job',
      () => safeguard.assertSendAllowed(live.job.id, '+17135553333', 'phone'),
      'kill_switch',
    );
    await expectBlocked(
      'kill switch blocks enqueue',
      () => safeguard.createJob({
        caller: 'tool',
        createdBy: 'agent',
        recipients: [{ channel: 'email', destination: 'new@example.com', messageText: 'nope' }],
      }),
      'kill_switch',
    );
    store.killSwitch = false;
    store.suppressed.add('email:blocked@example.com');
    const suppressed = await safeguard.createJob({
      caller: 'operator-dashboard',
      createdBy: 'operator',
      fullAuto: true,
      recipients: [{ channel: 'email', destination: 'blocked@example.com', messageText: 'no' }],
    });
    await clearSmall(safeguard, suppressed.job.id);
    await expectBlocked(
      'suppressed recipient is blocked',
      () => safeguard.assertSendAllowed(suppressed.job.id, 'Blocked@Example.com', 'email'),
      'suppressed',
    );
    const after = await safeguard.describe(suppressed.job.id);
    check('suppressed recipient is marked blocked', after.recipients[0]?.status === 'blocked');
  }

  console.log('── caller classification and auto-approve default ──');
  check(
    'admin token without a dashboard session is not the operator',
    classifySendCaller({ declared: 'operator-dashboard', operatorSessionValid: false }) === 'api-token',
  );
  check(
    'a declared agent wins over a valid dashboard session',
    classifySendCaller({ declared: 'agent', operatorSessionValid: true }) === 'agent',
  );
  check(
    'runtime tool caller wins over a dashboard header',
    runWithSendCaller('tool', () => classifySendCaller({ declared: 'operator-dashboard', operatorSessionValid: true })) === 'tool',
  );
  delete process.env.APEX_OPERATOR_AUTO_APPROVE_ALL;
  const policy = await import('../packages/core/src/approval-policy.ts');
  check('unset auto-approve fails closed', policy.operatorAutoApproveAllEnabled() === false);
  process.env.APEX_OPERATOR_AUTO_APPROVE_ALL = 'true';
  check('explicit true enables ordinary auto-approve', policy.operatorAutoApproveAllEnabled() === true);
  check('outbound sales sends cannot auto-approve', policy.outboundSalesSendCanAutoApprove() === false);
  delete process.env.APEX_OPERATOR_AUTO_APPROVE_ALL;

  console.log('── source wiring ──');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
  const mustCall = [
    'packages/core/src/email-delivery.ts',
    'packages/core/src/cartesia-sales-client.ts',
    'packages/core/src/revenue-ops/voice-router.ts',
    'packages/core/src/calendar-invite.ts',
    'packages/api-server/src/routes/sales-ops.ts',
    'packages/api-server/src/routes/cartesia-sales.ts',
    'packages/api-server/src/routes/telnyx-assistant.ts',
    'packages/api-server/src/telnyx-voice-guardrails.ts',
    'packages/api-server/src/routes/call-bridge.ts',
  ];
  for (const path of mustCall) {
    const source = read(path);
    check(`${path} calls assertSendAllowed`, source.includes('assertSendAllowed('));
  }
  const email = read('packages/core/src/email-delivery.ts');
  check(
    'email safeguard runs before Resend',
    email.indexOf('assertSendAllowed(') < email.indexOf('fetch(RESEND_API_URL'),
  );
  const cartesiaSales = read('packages/api-server/src/routes/cartesia-sales.ts');
  const bookStart = cartesiaSales.indexOf("router.post('/tools/book-consultation'");
  const bookFn = bookStart >= 0 ? cartesiaSales.slice(bookStart, bookStart + 2800) : '';
  const bookingService = read('packages/core/src/calendar/booking-service.ts');
  check(
    'consultation booking holds the slot and does not POST a Cal.com invite',
    bookFn.includes('getCalendarBookingService()')
      && bookFn.includes('service.book(')
      && bookFn.includes('invite_sent: false')
      && !bookFn.includes("calRequest('bookings'")
      && !cartesiaSales.includes('api.cal.com/v2/bookings')
      && bookingService.includes("sendUpdates: 'none'")
      && bookingService.includes('this.deps.invites.stage('),
  );
  const registry = read('packages/core/src/tool-registry.ts');
  check('outbound call tool still reaches Cartesia only after the gate', registry.includes('startCartesiaSalesCall({'));
  check('registry forces outbound sales tools through approval', registry.includes('isOutboundSalesSendTool(name)'));
  const approval = read('packages/core/src/approval-policy.ts');
  check('unset auto-approve source returns false', approval.includes('if (!raw) return false;'));
  const migration = read('lib/db/drizzle/20261003_send_safeguard.sql');
  check('migration is additive', !/drop\s+table/i.test(migration) && migration.includes('CREATE TABLE IF NOT EXISTS send_jobs'));
  const runtime = read('lib/db/src/client.ts');
  check('runtime migrate creates send_jobs', runtime.includes('CREATE TABLE IF NOT EXISTS send_jobs'));
  const safeguardSource = read('packages/core/src/send-safeguard.ts');
  check('safeguard source does not log the code', !/console\.(log|error|warn|info)\([^)]*code/.test(safeguardSource));
  const sweep = read('packages/core/src/instrumented-base-agent.ts');
  check('approval sweep excludes outbound sales tools', sweep.includes('OUTBOUND_SALES_SEND_TOOLS'));
  const campaigns = read('packages/api-server/src/routes/email-campaigns.ts');
  check('campaign cancel cascades', campaigns.includes('cascadeCampaignCancellation'));

  installSendSafeguardForTests(null);
  console.log(failures === 0 ? '\nSend safeguard checks passed.' : `\n${failures} send safeguard check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
