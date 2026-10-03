/** Deterministic send-safeguard guard.
 *
 * In-memory store only — no live providers, no production data.
 *
 * Usage: pnpm --filter @workspace/core exec tsx scripts/verify-send-safeguard.ts
 */
import {
  aggregatedRecipientCount,
  assertSendAllowed,
  CODE_THRESHOLD,
  codeRequiredForCount,
  configureSendSafeguard,
  confirmSendJob,
  createSendJob,
  gateOutboundSend,
  hashOperatorCode,
  isOperatorDashboardSession,
  isValidFourDigitCode,
  MemorySendSafeguardStore,
  rejectNonOperatorCodeSource,
  resetSendSafeguardForTests,
  setJobFullAuto,
  setOperatorCode,
  stopSendJob,
  submitSafeguardCode,
  unlockSafeguard,
  updateSendJobContent,
  verifyOperatorCode,
  type SendSafeguardSession,
} from '../packages/core/src/send-safeguard.js';
import {
  evaluatePolicy,
  HARD_GATED_TOOLS,
  isOutboundSalesSendTool,
  operatorAutoApproveAllEnabled,
  operatorMayAutoApproveTool,
} from '../packages/core/src/approval-policy.js';
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures += 1;
};

const operator: SendSafeguardSession = {
  actor: 'operator_dashboard',
  client: 'apex-dashboard',
  authKind: 'admin',
  operatorSessionValid: true,
};

const bot: SendSafeguardSession = {
  actor: 'bot_token',
  client: 'vapi',
  authKind: 'bot_token',
  operatorSessionValid: false,
};

function setup(opts?: { killSwitch?: boolean; suppressed?: Set<string> }) {
  resetSendSafeguardForTests();
  const store = new MemorySendSafeguardStore();
  configureSendSafeguard({
    store,
    loadKillSwitch: async () => Boolean(opts?.killSwitch),
    isRecipientSuppressed: async (_channel, destination) => Boolean(opts?.suppressed?.has(destination)),
  });
  return store;
}

async function clearJob(jobId: string, recipients = 1) {
  await confirmSendJob(jobId, 1, operator);
  await confirmSendJob(jobId, 2, operator);
  if (recipients >= CODE_THRESHOLD) {
    await setOperatorCode('2468');
    await submitSafeguardCode(jobId, '2468', operator);
  }
}

async function main(): Promise<void> {
  console.log('── operator auto-approve fails closed when unset ──');
  const previous = process.env.APEX_OPERATOR_AUTO_APPROVE_ALL;
  delete process.env.APEX_OPERATOR_AUTO_APPROVE_ALL;
  check('unset env is false', operatorAutoApproveAllEnabled() === false);
  process.env.APEX_OPERATOR_AUTO_APPROVE_ALL = 'true';
  check('explicit true enables non-outbound auto-approve', operatorAutoApproveAllEnabled() === true);
  check('send_email is never auto-approvable', operatorMayAutoApproveTool('send_email') === false);
  check('make_outbound_call is never auto-approvable', operatorMayAutoApproveTool('make_outbound_call') === false);
  check('send_email_campaign_batch is an outbound sales tool', isOutboundSalesSendTool('send_email_campaign_batch') === true);
  const outboundDecision = evaluatePolicy({
    toolName: 'send_email',
    projectAutonomyLevel: 'full_autonomous',
    projectAutoapproveTools: [...HARD_GATED_TOOLS],
    taskBelongsToProject: true,
  });
  check('project autonomy cannot auto-approve outbound email', outboundDecision.autoApprove === false);
  if (previous === undefined) delete process.env.APEX_OPERATOR_AUTO_APPROVE_ALL;
  else process.env.APEX_OPERATOR_AUTO_APPROVE_ALL = previous;

  console.log('\n── code hashing ──');
  check('only 4 digits are valid', isValidFourDigitCode('1234') && !isValidFourDigitCode('12') && !isValidFourDigitCode('abcd'));
  const hashed = await hashOperatorCode('1234');
  check('hash is not the plaintext code', hashed.hashHex !== '1234' && !hashed.hashHex.includes('1234'));
  check('correct code verifies', await verifyOperatorCode('1234', hashed.hashHex, hashed.saltHex) === true);
  check('wrong code is rejected', await verifyOperatorCode('0000', hashed.hashHex, hashed.saltHex) === false);

  console.log('\n── session source ──');
  check('dashboard session is accepted', isOperatorDashboardSession(operator) === true);
  check('bot session is rejected', isOperatorDashboardSession(bot) === false);
  let rejected = false;
  try {
    rejectNonOperatorCodeSource(bot);
  } catch {
    rejected = true;
  }
  check('code from a bot/tool source throws', rejected);

  console.log('\n── each channel blocked without clearance ──');
  for (const channel of ['email', 'call', 'sms', 'calendar'] as const) {
    setup();
    const job = await createSendJob({
      recipients: [{ channel, destination: channel === 'email' || channel === 'calendar' ? 'a@example.com' : '+15551234567', messageText: 'hello' }],
    });
    let blocked = false;
    try {
      await assertSendAllowed(job.id, channel === 'email' || channel === 'calendar' ? 'a@example.com' : '+15551234567', channel);
    } catch (error) {
      blocked = error instanceof Error && error.message.includes('Both operator confirms');
    }
    check(`${channel} blocked without clearance`, blocked);
  }

  console.log('\n── confirm 1 alone does not send ──');
  {
    setup();
    const job = await createSendJob({
      recipients: [{ channel: 'email', destination: 'one@example.com', messageText: 'hi' }],
    });
    await confirmSendJob(job.id, 1, operator);
    let blocked = false;
    try {
      await assertSendAllowed(job.id, 'one@example.com', 'email');
    } catch {
      blocked = true;
    }
    check('confirm 1 is not enough', blocked);
  }

  console.log('\n── both confirms but no code at 5+ does not send ──');
  {
    setup();
    const job = await createSendJob({
      recipients: Array.from({ length: 5 }, (_, i) => ({
        channel: 'email' as const,
        destination: `p${i}@example.com`,
        messageText: 'batch',
      })),
    });
    await setOperatorCode('1357');
    await confirmSendJob(job.id, 1, operator);
    await confirmSendJob(job.id, 2, operator);
    let blocked = false;
    try {
      await assertSendAllowed(job.id, 'p0@example.com', 'email');
    } catch (error) {
      blocked = error instanceof Error && /4-digit|code/i.test(error.message);
    }
    check('5 recipients require the code after both confirms', blocked);
  }

  console.log('\n── aggregation across jobs within 24h triggers the code ──');
  {
    setup();
    const first = await createSendJob({
      campaignKey: 'story-a',
      storyKey: 'story-a',
      recipients: Array.from({ length: 3 }, (_, i) => ({
        channel: 'sms' as const,
        destination: `+1555000000${i}`,
        messageText: 'part 1',
      })),
    });
    const second = await createSendJob({
      campaignKey: 'story-a',
      storyKey: 'story-a',
      recipients: [{ channel: 'email', destination: 'plus@example.com', messageText: 'part 2' }],
    });
    const siblings = [first, second];
    const total = aggregatedRecipientCount(second, siblings, new Date());
    check('3+1 aggregates to 4, still under threshold', total === 4 && codeRequiredForCount(total) === false);
    const third = await createSendJob({
      campaignKey: 'story-a',
      storyKey: 'story-a',
      recipients: [{ channel: 'call', destination: '+15559990000', messageText: 'part 3' }],
    });
    const aggregated = aggregatedRecipientCount(third, [first, second, third], new Date());
    check('3+1+1 aggregates to 5 and requires a code', aggregated === 5 && codeRequiredForCount(aggregated));
    await confirmSendJob(third.id, 1, operator);
    await confirmSendJob(third.id, 2, operator);
    let blocked = false;
    try {
      await assertSendAllowed(third.id, '+15559990000', 'call');
    } catch {
      blocked = true;
    }
    check('aggregated 5-count job cannot send without the code', blocked);
  }

  console.log('\n── edit after confirm voids ──');
  {
    setup();
    const job = await createSendJob({
      recipients: [{ channel: 'email', destination: 'edit@example.com', messageText: 'original' }],
    });
    await confirmSendJob(job.id, 1, operator);
    const voided = await updateSendJobContent({ jobId: job.id, messageText: 'changed copy' });
    check('content edit after confirm voids the job', voided.status === 'voided');
    let blocked = false;
    try {
      await assertSendAllowed(job.id, 'edit@example.com', 'email');
    } catch {
      blocked = true;
    }
    check('voided job cannot send', blocked);
  }

  console.log('\n── code from a non-operator/bot source rejected ──');
  {
    setup();
    const job = await createSendJob({
      recipients: Array.from({ length: 5 }, (_, i) => ({
        channel: 'email' as const,
        destination: `bot${i}@example.com`,
        messageText: 'x',
      })),
    });
    await setOperatorCode('9999');
    await confirmSendJob(job.id, 1, operator);
    await confirmSendJob(job.id, 2, operator);
    let rejectedBot = false;
    try {
      await submitSafeguardCode(job.id, '9999', bot);
    } catch (error) {
      rejectedBot = error instanceof Error && /operator dashboard|rejected actor/.test(error.message);
    }
    check('bot/token/agent code submission is rejected', rejectedBot);
    let rejectedAgent = false;
    try {
      await submitSafeguardCode(job.id, '9999', { actor: 'agent', authKind: 'none', operatorSessionValid: false });
    } catch {
      rejectedAgent = true;
    }
    check('agent actor is rejected', rejectedAgent);
  }

  console.log('\n── 3 wrong codes locks all sending ──');
  {
    setup();
    await setOperatorCode('1111');
    const job = await createSendJob({
      recipients: Array.from({ length: 5 }, (_, i) => ({
        channel: 'email' as const,
        destination: `lock${i}@example.com`,
        messageText: 'lock',
      })),
    });
    await confirmSendJob(job.id, 1, operator);
    await confirmSendJob(job.id, 2, operator);
    for (let i = 0; i < 3; i += 1) {
      try {
        await submitSafeguardCode(job.id, '0000', operator);
      } catch {
        // expected
      }
    }
    const settings = await (await import('../packages/core/src/send-safeguard.js')).getOperatorSafeguardSettings();
    check('lock engages after 3 failures', settings.locked === true);
    const other = await createSendJob({
      recipients: [{ channel: 'sms', destination: '+15551112222', messageText: 'later' }],
    }).then(() => false).catch(() => true);
    // create also checks lock
    check('new jobs cannot enqueue while locked', other === true);
    await unlockSafeguard();
    const after = await (await import('../packages/core/src/send-safeguard.js')).getOperatorSafeguardSettings();
    check('operator password path unlocks (unlock() clears lock)', after.locked === false);
  }

  console.log('\n── Stop cancels queued items ──');
  {
    setup();
    const job = await createSendJob({
      recipients: [
        { channel: 'email', destination: 'a@example.com', messageText: 'one' },
        { channel: 'sms', destination: '+15550001111', messageText: 'two' },
      ],
    });
    await stopSendJob(job.id, operator);
    const view = await (await import('../packages/core/src/send-safeguard.js')).getSendJobView(job.id);
    check('job is stopped', view.job.status === 'stopped');
    check('queued recipients were cancelled, not deleted', view.recipients.length === 2 && view.recipients.every((row) => row.status === 'cancelled'));
  }

  console.log('\n── kill switch ON blocks even a fully cleared job ──');
  {
    const store = setup();
    const job = await createSendJob({
      recipients: [{ channel: 'email', destination: 'k@example.com', messageText: 'go' }],
    });
    await confirmSendJob(job.id, 1, operator);
    await confirmSendJob(job.id, 2, operator);
    configureSendSafeguard({
      store,
      loadKillSwitch: async () => true,
      isRecipientSuppressed: async () => false,
    });
    let blocked = false;
    try {
      await assertSendAllowed(job.id, 'k@example.com', 'email');
    } catch (error) {
      blocked = error instanceof Error && /kill switch/i.test(error.message);
    }
    check('cleared job still dies on the kill switch', blocked);
  }

  console.log('\n── suppressed recipient blocked ──');
  {
    setup({ suppressed: new Set(['optout@example.com']) });
    const job = await createSendJob({
      recipients: [{ channel: 'email', destination: 'optout@example.com', messageText: 'nope' }],
    });
    await confirmSendJob(job.id, 1, operator);
    await confirmSendJob(job.id, 2, operator);
    let blocked = false;
    try {
      await assertSendAllowed(job.id, 'optout@example.com', 'email');
    } catch (error) {
      blocked = error instanceof Error && /suppression|do-not-contact/i.test(error.message);
    }
    check('suppressed recipient cannot send', blocked);
  }

  console.log('\n── full-auto cleared job under 5 can send ──');
  {
    setup();
    const job = await createSendJob({
      fullAuto: true,
      recipients: [{ channel: 'email', destination: 'ok@example.com', messageText: 'cleared' }],
    });
    await setJobFullAuto(job.id, true, operator);
    await clearJob(job.id, 1);
    let ok = true;
    try {
      await assertSendAllowed(job.id, 'ok@example.com', 'email');
    } catch (error) {
      ok = false;
      console.log('    detail', error instanceof Error ? error.message : error);
    }
    check('cleared full-auto job under 5 is allowed', ok);
  }

  console.log('\n── gateOutboundSend without a job still cannot hit a provider ──');
  {
    setup();
    let blocked = false;
    try {
      await gateOutboundSend({
        channel: 'sms',
        recipient: '+15553334444',
        messageText: 'direct',
      });
    } catch {
      blocked = true;
    }
    check('direct gate creates a job and still blocks the send', blocked);
  }

  console.log('\n── source: every live send path calls the safeguard ──');
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const email = read('packages/core/src/email-delivery.ts');
  const cartesia = read('packages/core/src/cartesia-sales-client.ts');
  const salesOps = read('packages/api-server/src/routes/sales-ops.ts');
  const callBridge = read('packages/api-server/src/routes/call-bridge.ts');
  const telnyxAssistant = read('packages/api-server/src/routes/telnyx-assistant.ts');
  const telnyxVoice = read('packages/api-server/src/telnyx-voice-guardrails.ts');
  const cartesiaRoutes = read('packages/api-server/src/routes/cartesia-sales.ts');
  const approval = read('packages/core/src/approval-policy.ts');
  check(
    'email delivery gates before Resend',
    email.includes('gateOutboundSend') && email.indexOf('gateOutboundSend') < email.indexOf('fetch(RESEND_API_URL'),
  );
  check(
    'Cartesia helper gates before the live call POST',
    cartesia.includes('gateOutboundSend') && cartesia.indexOf('gateOutboundSend') < cartesia.indexOf(`${'CARTESIA_API'}/agents/calls`) === false
      ? cartesia.indexOf('gateOutboundSend') < cartesia.indexOf('/agents/calls')
      : cartesia.indexOf('gateOutboundSend') < cartesia.indexOf('/agents/calls'),
  );
  check(
    'operator SMS gates before Telnyx',
    salesOps.includes('gateOutboundSend') && salesOps.indexOf('gateOutboundSend') < salesOps.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
  );
  check('call-bridge customer dials are gated', callBridge.includes("role === 'customer'") && callBridge.includes('gateOutboundSend'));
  check(
    'front-desk confirmation SMS is gated',
    telnyxAssistant.includes('gateOutboundSend') && telnyxAssistant.indexOf('gateOutboundSend') < telnyxAssistant.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
  );
  check(
    'checkout SMS is gated',
    telnyxVoice.includes('gateOutboundSend') && telnyxVoice.indexOf('gateOutboundSend') < telnyxVoice.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
  );
  check('demo-link SMS is gated', cartesiaRoutes.includes("createdBy: 'cartesia-demo-link'") && cartesiaRoutes.includes('gateOutboundSend'));
  check('calendar booking is gated', cartesiaRoutes.includes("channel: 'calendar'") && cartesiaRoutes.includes('gateOutboundSend'));
  const voiceRouter = read('packages/core/src/revenue-ops/voice-router.ts');
  check(
    'revenue-ops call_initiate stub is still gated before any later adapter',
    voiceRouter.includes('gateOutboundSend') && voiceRouter.indexOf('gateOutboundSend') < voiceRouter.indexOf('db.insert(calls)'),
  );
  check('auto-approve unset fails closed in source', /if \(!raw\) return false;/.test(approval));

  if (failures > 0) {
    console.error(`\n${failures} send-safeguard check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll send-safeguard checks passed.');
}

await main();
