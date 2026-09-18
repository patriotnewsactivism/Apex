/**
 * Guard: the Apex Front Desk Telnyx-assistant tool surface.
 *
 * Two properties matter most here, both easy to regress silently:
 *
 * 1. It's a server-to-server webhook (Telnyx can't carry a Bearer token) and
 *    must be mounted BEFORE requireAdminAuth, same as vapi/telnyx/resend.
 * 2. send-confirmation sends a FIXED template, never freeform content from
 *    the assistant's own arguments — this fires from an unsupervised live
 *    call with no human approving each send, so the one thing standing
 *    between "confirmation email" and "arbitrary email the AI decided to
 *    write" is that the html is built from html`...${reason}...` literals in
 *    this file, not from an args.body/args.html/args.content passthrough.
 *
 * Source-structural (no live Postgres/ApexCEO/Telnyx account in CI) except
 * for the phone-number and payload-extraction helpers, which are pure and
 * imported/executed directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

async function main(): Promise<void> {
  console.log('Verifying the Apex Front Desk Telnyx-assistant surface...\n');

  const route = read('packages/api-server/src/routes/telnyx-assistant.ts');
  const index = read('packages/api-server/src/index.ts');
  const env = read('.env.example');

  // ── Every endpoint the assistant/messaging-profile config points at ──────
  check('dynamic-variables endpoint exists', /router\.post\('\/dynamic-variables', async/.test(route));
  check('take-message tool endpoint exists', /router\.post\('\/tools\/take-message', async/.test(route));
  check('send-confirmation tool endpoint exists', /router\.post\('\/tools\/send-confirmation', async/.test(route));
  check('lookup-caller-history tool endpoint exists', /router\.post\('\/tools\/lookup-caller-history', async/.test(route));
  check('inbound SMS endpoint exists', /router\.post\('\/sms-inbound', async/.test(route));

  // ── Auth: every handler checks the key, and does so first ────────────────
  const handlers = ['/dynamic-variables', '/tools/take-message', '/tools/send-confirmation', '/tools/lookup-caller-history', '/sms-inbound'];
  for (const h of handlers) {
    const idx = route.indexOf(`router.post('${h}', async`);
    const body = route.slice(idx, idx + 400);
    check(
      `${h} verifies the key before doing anything else`,
      /if \(!verifyAssistantKey\(req\.query as Record<string, unknown>\)\) \{\s*return res\.status\(403\)/.test(body),
    );
  }
  check(
    'the key check is timing-safe, not a plain string compare',
    /crypto\.timingSafeEqual\(Buffer\.from\(received\), Buffer\.from\(secret\)\)/.test(route),
  );
  check(
    'a missing configured secret fails closed (rejects) rather than accepting any request',
    /if \(!secret\) \{[\s\S]{0,150}return false;/.test(route),
  );

  // ── Mounted as a pre-auth webhook, same rule as vapi/telnyx/resend ───────
  check('the router is imported in index.ts', /import \{ createTelnyxAssistantRouter \} from '\.\/routes\/telnyx-assistant\.js';/.test(index));
  check('the router is mounted at /api/telnyx-assistant', /app\.use\('\/api\/telnyx-assistant', createTelnyxAssistantRouter\(ceo\)\)/.test(index));
  const authGateIndex = index.indexOf("app.use('/api', requireAdminAuth);");
  const mountIndex = index.indexOf("app.use('/api/telnyx-assistant'");
  check(
    'mounted BEFORE the blanket /api admin-auth gate (Telnyx cannot send a Bearer token)',
    authGateIndex > -1 && mountIndex > -1 && mountIndex < authGateIndex,
    { mountIndex, authGateIndex },
  );

  // ── The safety property: fixed template, not freeform content ────────────
  const sendConfirmIdx = route.indexOf("router.post('/tools/send-confirmation'");
  const sendConfirmEndIdx = route.indexOf("router.post('/sms-inbound'");
  const sendConfirmBody = route.slice(sendConfirmIdx, sendConfirmEndIdx);
  check(
    'the confirmation email body is a template literal built in this file, not passed through from tool args',
    /const html = `<p>Hi \$\{contactName\}/.test(sendConfirmBody),
  );
  check(
    'no args field named body/html/content/message is ever used as the email or SMS text',
    !/args\.(body|html|content|message)\b/.test(sendConfirmBody),
  );
  check(
    'the SMS text is also a fixed template, not args-derived free text',
    /const text = `Apex: thanks for calling/.test(sendConfirmBody),
  );
  check(
    'send_email is invoked with requestApproval auto-true (operator/system-initiated, matches sales-ops.ts precedent), not left ungated silently',
    /requestApproval: async \(\) => true/.test(sendConfirmBody),
  );

  // ── take-message creates a real, visible followup — not just a log line ──
  const takeMsgIdx = route.indexOf("router.post('/tools/take-message'");
  const takeMsgEndIdx = route.indexOf("router.post('/tools/send-confirmation'");
  const takeMsgBody = route.slice(takeMsgIdx, takeMsgEndIdx);
  check(
    'take-message actually submits a goal, not only a log line nobody is watching',
    /await ceo\.submitGoal\(/.test(takeMsgBody),
  );
  check(
    'an urgent message gets a higher (lower-numbered) priority than a routine one',
    /CALLER_NAME_GOAL_PRIORITY_URGENT/.test(takeMsgBody) && /CALLER_NAME_GOAL_PRIORITY_NORMAL/.test(takeMsgBody),
  );

  // ── lookup-caller-history: bounded, defensive, and never throws to the caller ──
  const lookupIdx = route.indexOf("router.post('/tools/lookup-caller-history'");
  const lookupEndIdx = route.indexOf("router.post('/sms-inbound'");
  const lookupBody = route.slice(lookupIdx, lookupEndIdx);
  check(
    'it matches SMS history against both the raw and E.164 forms of the number, like findKnownCaller does for leads',
    /or\(eq\(smsMessages\.counterpartyNumber, phone\), eq\(smsMessages\.counterpartyNumber, e164\)\)/.test(lookupBody),
  );
  check(
    'recent-message history is bounded (a live phone tool must not return an unbounded result set)',
    /\.limit\(5\)/.test(lookupBody),
  );
  check(
    'a lookup failure degrades to found:false rather than a 500 the assistant has no way to react to',
    /catch \(err\) \{[\s\S]{0,300}found: false/.test(lookupBody),
  );

  // ── Env vars documented ───────────────────────────────────────────────────
  check(
    '.env.example documents the new secret and the front-desk number',
    /TELNYX_ASSISTANT_WEBHOOK_SECRET=/.test(env) && /APEX_FRONT_DESK_NUMBER=/.test(env),
  );

  // ── Pure helpers: run them, don't just read them ──────────────────────────
  const mod = (await import(
    path.join(root, 'packages/api-server/src/routes/telnyx-assistant.ts')
  )) as typeof import('../packages/api-server/src/routes/telnyx-assistant.js');
  const { normalizePhone, extractCallerNumber } = mod;

  check(
    'normalizePhone treats +1, bare 10-digit, and spaced/dashed forms as the same number',
    normalizePhone('+18328804970') === normalizePhone('8328804970') &&
      normalizePhone('8328804970') === normalizePhone('(832) 880-4970') &&
      normalizePhone('+18328804970') === '8328804970',
    {
      plus1: normalizePhone('+18328804970'),
      bare: normalizePhone('8328804970'),
      formatted: normalizePhone('(832) 880-4970'),
    },
  );
  check(
    'extractCallerNumber finds the number under the primary expected field name',
    extractCallerNumber({ telnyx_end_user_target: '+18328804970' }) === '+18328804970',
  );
  check(
    'extractCallerNumber falls back through alternate field names in order',
    extractCallerNumber({ from: '+18328804970' }) === '+18328804970' &&
      extractCallerNumber({ caller_number: '+18328804970' }) === '+18328804970' &&
      extractCallerNumber({ call: { from: '+18328804970' } }) === '+18328804970',
  );
  check(
    'extractCallerNumber returns empty string rather than throwing on a payload with none of the expected fields',
    extractCallerNumber({ unrelated: 'field' }) === '',
  );

  if (failures > 0) {
    console.error(`\n${failures} telnyx-front-desk check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll telnyx-front-desk checks passed.');
}

main();
