/**
 * Guard: the Sales Operations manual-SMS surface (send + thread read) and the
 * shared phone-number validator it now shares with /call.
 *
 * Source-structural for the route wiring (no live Postgres/Telnyx account in
 * CI) plus direct execution of the exported pure normalizeE164() against
 * real and malformed input.
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
  console.log('Verifying the Sales Operations manual-SMS surface...\n');

  const route = read('packages/api-server/src/routes/sales-ops.ts');
  const schema = read('lib/db/src/schema.ts');
  const client = read('lib/db/src/client.ts');
  const telnyxAssistant = read('packages/api-server/src/routes/telnyx-assistant.ts');
  const apiClient = read('packages/dashboard/src/lib/api.ts');
  const authMiddleware = read('packages/api-server/src/middleware/auth.ts');

  // ── A third-party voice platform (Vapi) needs to call /sms/send from its own
  //    tool-calling. It must not be handed the full admin token to do that —
  //    a scoped token limited to exactly this one route, same pattern as the
  //    existing outcome-ledger-ingest token. ───────────────────────────────────
  check(
    'a scoped Vapi SMS token is optional, not a hard-required env var',
    /configuredVapiSmsToken = process\.env\.APEX_VAPI_SMS_TOKEN\?\.trim\(\) \|\| null/.test(authMiddleware),
  );
  check(
    'the scoped token is checked with the same constant-time comparison as every other credential',
    /validateVapiSmsToken.*constantTimeTokenMatch\(bearerToken\(authHeader\), configuredVapiSmsToken\)/s.test(authMiddleware),
  );
  check(
    'the scoped token is accepted for exactly POST /api/sales-ops/sms/send, not the whole API',
    /isVapiSmsRoute[\s\S]*?req\.method === 'POST' && path === '\/api\/sales-ops\/sms\/send'/.test(authMiddleware),
  );
  check(
    'requireAdminAuth actually wires the scoped route check in, not just declares it',
    /isVapiSmsRoute\(req\) && validateVapiSmsToken\(req\.headers\.authorization\)/.test(authMiddleware),
  );

  // ── Backend: routes exist, mounted behind requireAdminAuth (this router,
  //    not telnyx-assistant.ts, which is the pre-auth webhook surface) ───────
  check('POST /sms/send exists', /router\.post\('\/sms\/send', async/.test(route));
  check('GET /sms/threads exists', /router\.get\('\/sms\/threads', async/.test(route));
  check('GET /sms/threads/:number exists', /router\.get\('\/sms\/threads\/:number', async/.test(route));
  check(
    'the SMS routes live in sales-ops.ts, which is mounted after requireAdminAuth — not in the pre-auth telnyx-assistant.ts webhook router',
    !/\/sms\/send|\/sms\/threads/.test(telnyxAssistant),
  );

  // ── Backend: send validates destination + message text before calling out ──
  const sendIdx = route.indexOf("router.post('/sms/send'");
  const sendEndIdx = route.indexOf('return router;');
  const sendBody = route.slice(sendIdx, sendEndIdx);
  check(
    'send rejects an invalid destination number before calling Telnyx',
    /if \(!toNumber\) \{\s*res\.status\(400\)/.test(sendBody),
  );
  check(
    'send rejects empty message text before calling Telnyx',
    /if \(!text\) \{\s*res\.status\(400\)/.test(sendBody),
  );
  check(
    'a failed Telnyx send is still persisted (status failed), not silently dropped',
    /status = 'failed'/.test(sendBody) && /await db\.insert\(smsMessages\)\.values/.test(sendBody),
  );

  // ── Backend: /call and /sms/send share one validator, not two copies ────────
  check(
    'normalizeE164 is exported for direct testing',
    /export function normalizeE164\(/.test(route),
  );
  check(
    '/call uses the shared normalizeE164 validator',
    /const customerNumber = normalizeE164\(body\.customerNumber\)/.test(route),
  );
  check(
    '/sms/send uses the shared normalizeE164 validator',
    /const toNumber = normalizeE164\(body\.toNumber\)/.test(route),
  );

  // ── Schema + bootstrap DDL agree on the sms_messages table ───────────────────
  check('schema.ts declares smsMessages', /export const smsMessages = pgTable\('sms_messages'/.test(schema));
  check(
    'schema.ts indexes the thread lookup (counterparty_number, created_at)',
    /threadIdx: index\('sms_messages_thread_idx'\)\.on\(table\.counterpartyNumber, table\.createdAt\)/.test(schema),
  );
  check(
    'client.ts bootstrap DDL creates sms_messages (fresh databases must not 42P01 on first boot)',
    /CREATE TABLE IF NOT EXISTS sms_messages/.test(client),
  );
  check(
    'client.ts bootstrap DDL creates the matching thread index',
    /CREATE INDEX IF NOT EXISTS sms_messages_thread_idx/.test(client),
  );

  // ── Inbound SMS webhook persists into the same table the dashboard reads ────
  check(
    '/sms-inbound persists an inbound row into smsMessages (not just a log line)',
    /direction: 'inbound'/.test(telnyxAssistant) && /await db\.insert\(smsMessages\)\.values/.test(telnyxAssistant),
  );
  check(
    'send-confirmation\'s SMS branch also persists an outbound row (so AI-sent confirmations show up in the thread view)',
    /direction: 'outbound'/.test(telnyxAssistant),
  );

  // ── Frontend: dashboard API client has the three methods, typed ─────────────
  check('lib/api.ts exposes salesOps.smsThreads', /smsThreads: \(\) => apiFetch<SmsThreadSummary\[\]>/.test(apiClient));
  check('lib/api.ts exposes salesOps.smsThread', /smsThread: \(number: string\) =>/.test(apiClient));
  check('lib/api.ts exposes salesOps.sendSms', /sendSms: \(body: \{ toNumber: string; body: string \}\) =>/.test(apiClient));

  // ── Pure helper: run it, don't just read it ──────────────────────────────────
  const mod = (await import(
    path.join(root, 'packages/api-server/src/routes/sales-ops.ts')
  )) as typeof import('../packages/api-server/src/routes/sales-ops.js');
  const { normalizeE164 } = mod;

  check(
    'a plain 10-digit number with a leading + is accepted as-is',
    normalizeE164('+18328804970') === '+18328804970',
  );
  check(
    'a bare digit string gets a + prepended',
    normalizeE164('18328804970') === '+18328804970',
  );
  check(
    'spaces, dashes, and parens are stripped before validation',
    normalizeE164('(832) 880-4970') === '+8328804970',
  );
  check('too-short input is rejected (null)', normalizeE164('12345') === null);
  check('non-numeric input is rejected (null)', normalizeE164('not-a-number') === null);
  check('empty/undefined input is rejected (null)', normalizeE164(undefined) === null && normalizeE164('') === null);

  if (failures > 0) {
    console.error(`\n${failures} sales-ops-sms check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll sales-ops-sms checks passed.');
}

main();
