/**
 * Guard: the Call Bridge feature (operator call + live AI takeover).
 *
 * The property that matters most: the operator's and customer's call legs
 * are dialed with conference_config.end_conference_on_exit = true, so if
 * either one hangs up for ANY reason, Telnyx itself hangs up whichever other
 * legs remain — this does not depend on the webhook handler running
 * correctly. The AI leg deliberately does NOT set that flag, so the AI
 * leaving never ends the operator/customer call. Getting this backwards
 * (e.g. the AI's leg ending the call, or the customer's leg not ending it)
 * would either strand a live customer call or let the AI silently end calls
 * it should not be able to end.
 *
 * Source-structural (no live Telnyx account/Postgres in CI) except for the
 * exported pure helpers, which are executed directly.
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
  console.log('Verifying the Call Bridge (operator call + live AI takeover) surface...\n');

  const route = read('packages/api-server/src/routes/call-bridge.ts');
  const index = read('packages/api-server/src/index.ts');
  const schema = read('lib/db/src/schema.ts');
  const client = read('lib/db/src/client.ts');
  const env = read('.env.example');

  // ── Routes exist ──────────────────────────────────────────────────────────
  check('POST /start exists', /router\.post\('\/start', async/.test(route));
  check('POST /:id/bring-in-ai exists', /router\.post\('\/:id\/bring-in-ai', async/.test(route));
  check('POST /:id/end exists', /router\.post\('\/:id\/end', async/.test(route));
  check('GET /:id exists', /router\.get\('\/:id', async/.test(route));
  check('POST /call-bridge-webhook exists', /router\.post\('\/call-bridge-webhook', async/.test(route));

  // ── Mounting: control endpoints behind auth, webhook before it ──────────────
  check('call-bridge.ts is imported in index.ts', /import \{ createCallBridgeRouter, createCallBridgeWebhookRouter \} from '\.\/routes\/call-bridge\.js';/.test(index));
  check('the control router is mounted at /api/call-bridge', /app\.use\('\/api\/call-bridge', createCallBridgeRouter\(\)\)/.test(index));
  check('the webhook router is mounted at /api/telnyx-assistant', /app\.use\('\/api\/telnyx-assistant', createCallBridgeWebhookRouter\(\)\)/.test(index));
  const authGateIndex = index.indexOf("app.use('/api', requireAdminAuth);");
  const webhookMountIndex = index.indexOf("app.use('/api/telnyx-assistant', createCallBridgeWebhookRouter()");
  const controlMountIndex = index.indexOf("app.use('/api/call-bridge'");
  check(
    'the webhook is mounted BEFORE requireAdminAuth (Telnyx cannot send a Bearer token)',
    authGateIndex > -1 && webhookMountIndex > -1 && webhookMountIndex < authGateIndex,
    { webhookMountIndex, authGateIndex },
  );
  check(
    'the control router is mounted AFTER requireAdminAuth (these are operator-facing, not a Telnyx webhook)',
    authGateIndex > -1 && controlMountIndex > -1 && controlMountIndex > authGateIndex,
    { controlMountIndex, authGateIndex },
  );

  // ── The webhook verifies the key before doing anything else ────────────────
  const webhookIdx = route.indexOf("router.post('/call-bridge-webhook'");
  const webhookBody = route.slice(webhookIdx, webhookIdx + 400);
  check(
    'the webhook verifies the key before doing anything else',
    /if \(!verifyCallBridgeKey\(req\.query as Record<string, unknown>\)\) \{\s*res\.status\(403\)/.test(webhookBody),
  );
  check(
    'the key check is timing-safe, not a plain string compare',
    /crypto\.timingSafeEqual\(Buffer\.from\(received\), Buffer\.from\(secret\)\)/.test(route),
  );
  check(
    'a missing configured secret fails closed (rejects) rather than accepting any request',
    /if \(!secret\) \{[\s\S]{0,150}return false;/.test(route),
  );

  // ── The core safety property: who can end the call, and who cannot ─────────
  const startIdx = route.indexOf("router.post('/start'");
  const startEndIdx = route.indexOf("router.post('/:id/bring-in-ai'");
  const startBody = route.slice(startIdx, startEndIdx);
  check(
    "the operator's leg sets end_conference_on_exit: true",
    /dialBridgeLeg\(\{ to: operatorNumber, role: 'operator', sessionId: id, endConferenceOnExit: true \}\)/.test(startBody),
  );

  const webhookAnsweredSection = webhookBody + route.slice(webhookIdx + 400, route.indexOf("call.hangup'", webhookIdx) + 2000);
  check(
    "the customer's leg (dialed from the webhook once the operator answers) also sets end_conference_on_exit: true",
    /dialBridgeLeg\(\{\s*to: session\.customerNumber,\s*role: 'customer',\s*sessionId: session\.id,\s*endConferenceOnExit: true,?\s*\}\)/.test(webhookAnsweredSection),
  );

  const bringInAiIdx = route.indexOf("router.post('/:id/bring-in-ai'");
  const bringInAiEndIdx = route.indexOf("router.post('/:id/end'");
  const bringInAiBody = route.slice(bringInAiIdx, bringInAiEndIdx);
  check(
    "the AI's leg sets end_conference_on_exit: false — the AI must NEVER be able to end a live customer call by leaving",
    /dialBridgeLeg\(\{ to: frontDeskNumber, role: 'ai', sessionId: session\.id, endConferenceOnExit: false \}\)/.test(bringInAiBody),
  );
  check(
    'bringing the AI in is only allowed once the call is active (operator + customer already connected)',
    /if \(session\.status !== 'active'\) \{\s*res\.status\(409\)/.test(bringInAiBody),
  );

  // ── The customer is dialed only after the operator answers, not eagerly ────
  check(
    '/start does NOT dial the customer — only the operator',
    !/dialBridgeLeg\(\{ to: customerNumber/.test(startBody),
  );
  check(
    'the customer is dialed from the webhook, gated on role === \'operator\' and event === call.answered',
    /eventType === 'call\.answered'/.test(route) &&
      /state\.role === 'operator'/.test(route) &&
      route.indexOf("state.role === 'operator'") < route.indexOf('customerNumber', route.indexOf("eventType === 'call.answered'")),
  );

  // ── A customer who never answers does not strand or drop the operator ──────
  check(
    "a customer no-answer is handled by checking status === 'dialing_customer' specifically, not a bare role check",
    /state\.role === 'customer' && session\.status === 'dialing_customer'/.test(route),
  );
  check(
    'the no-answer branch does not touch operatorCallControlId (the operator stays connected)',
    !/lastError: `Customer did not answer[\s\S]{0,120}operatorCallControlId/.test(route),
  );

  // ── AI leaving reverts to active, it does not end the session ──────────────
  const hangupIdx = route.lastIndexOf("eventType === 'call.hangup'");
  const hangupBody = route.slice(hangupIdx);
  check(
    "the AI hangup branch sets status back to 'active' (or leaves 'ended' alone), never 'ended' from a fresh active call",
    /state\.role === 'ai'[\s\S]{0,400}status: session\.status === 'ended' \? 'ended' : 'active'/.test(hangupBody),
  );

  // ── Schema + bootstrap DDL agree on the call_bridge_sessions table ──────────
  check('schema.ts declares callBridgeSessions', /export const callBridgeSessions = pgTable\('call_bridge_sessions'/.test(schema));
  check(
    'client.ts bootstrap DDL creates call_bridge_sessions (fresh databases must not 42P01 on first boot)',
    /CREATE TABLE IF NOT EXISTS call_bridge_sessions/.test(client),
  );

  // ── Frontend + env docs ─────────────────────────────────────────────────────
  const apiClient = read('packages/dashboard/src/lib/api.ts');
  check('lib/api.ts exposes callBridge.start/status/bringInAi/end', /callBridge: \{/.test(apiClient) && /bringInAi: \(id: string\)/.test(apiClient));
  const salesOpsPanel = read('packages/dashboard/src/components/SalesOperationsPanel.tsx');
  check(
    'CallBridgePanel is imported and rendered on the Calls sub-tab',
    /import \{ CallBridgePanel \} from '\.\/CallBridgePanel\.js';/.test(salesOpsPanel) && /<CallBridgePanel \/>/.test(salesOpsPanel),
  );
  check(
    '.env.example documents the new connection id and webhook secret',
    /TELNYX_CALL_BRIDGE_CONNECTION_ID=/.test(env) && /TELNYX_CALL_BRIDGE_WEBHOOK_SECRET=/.test(env),
  );

  // ── Pure helpers: run them, don't just read them ────────────────────────────
  const mod = (await import(
    path.join(root, 'packages/api-server/src/routes/call-bridge.ts')
  )) as typeof import('../packages/api-server/src/routes/call-bridge.js');
  const { encodeClientState, decodeClientState, verifyCallBridgeKey, dialBridgeLeg } = mod;

  const state = { sessionId: 'sess-123', role: 'operator' as const };
  const encoded = encodeClientState(state);
  check('encodeClientState produces a valid base64 string', /^[A-Za-z0-9+/]+=*$/.test(encoded));
  check('decodeClientState round-trips what encodeClientState produced', JSON.stringify(decodeClientState(encoded)) === JSON.stringify(state));
  check('decodeClientState rejects garbage rather than throwing', decodeClientState('not-valid-base64-json!!!') === null);
  check('decodeClientState rejects a payload with an unknown role', decodeClientState(Buffer.from(JSON.stringify({ sessionId: 'x', role: 'supervisor' })).toString('base64')) === null);
  check('decodeClientState rejects undefined/non-string input', decodeClientState(undefined) === null && decodeClientState(42) === null);

  const savedSecret = process.env.TELNYX_CALL_BRIDGE_WEBHOOK_SECRET;
  try {
    delete process.env.TELNYX_CALL_BRIDGE_WEBHOOK_SECRET;
    check('verifyCallBridgeKey fails closed when no secret is configured', verifyCallBridgeKey({ key: 'anything' }) === false);
    process.env.TELNYX_CALL_BRIDGE_WEBHOOK_SECRET = 'a-real-secret-value';
    check('verifyCallBridgeKey rejects a wrong key', verifyCallBridgeKey({ key: 'wrong' }) === false);
    check('verifyCallBridgeKey rejects a missing key', verifyCallBridgeKey({}) === false);
    check('verifyCallBridgeKey accepts the correct key', verifyCallBridgeKey({ key: 'a-real-secret-value' }) === true);
  } finally {
    if (savedSecret === undefined) delete process.env.TELNYX_CALL_BRIDGE_WEBHOOK_SECRET;
    else process.env.TELNYX_CALL_BRIDGE_WEBHOOK_SECRET = savedSecret;
  }

  // dialBridgeLeg must fail closed on missing config WITHOUT making a network
  // call — this is the one behavior of it that is safe and meaningful to test
  // without a live Telnyx account.
  const savedApiKey = process.env.TELNYX_API_KEY;
  const savedConnId = process.env.TELNYX_CALL_BRIDGE_CONNECTION_ID;
  const savedFrom = process.env.APEX_FRONT_DESK_NUMBER;
  try {
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_CALL_BRIDGE_CONNECTION_ID;
    delete process.env.APEX_FRONT_DESK_NUMBER;
    const result = await dialBridgeLeg({ to: '+18328804970', role: 'operator', sessionId: 'sess-1', endConferenceOnExit: true });
    check(
      'dialBridgeLeg reports a clear config error (not a crash or a silent no-op) when unconfigured',
      'error' in result && typeof result.error === 'string' && result.error.length > 0,
      result,
    );
  } finally {
    if (savedApiKey === undefined) delete process.env.TELNYX_API_KEY; else process.env.TELNYX_API_KEY = savedApiKey;
    if (savedConnId === undefined) delete process.env.TELNYX_CALL_BRIDGE_CONNECTION_ID; else process.env.TELNYX_CALL_BRIDGE_CONNECTION_ID = savedConnId;
    if (savedFrom === undefined) delete process.env.APEX_FRONT_DESK_NUMBER; else process.env.APEX_FRONT_DESK_NUMBER = savedFrom;
  }

  if (failures > 0) {
    console.error(`\n${failures} call-bridge check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll call-bridge checks passed.');
}

main();
