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
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  check('POST /ai-first exists', /router\.post\('\/ai-first', async/.test(route));
  check('POST /:id/join exists', /router\.post\('\/:id\/join', async/.test(route));
  check(
    'a supervisor leg cannot end the conference',
    /end_conference_on_exit: params\.supervisorRole \? false : params\.endConferenceOnExit/.test(route),
  );

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
    /dialBridgeLeg\(\{\s*to: operatorNumber,\s*role: 'operator',\s*sessionId: id,\s*endConferenceOnExit: true,?/.test(startBody),
  );

  const webhookAnsweredSection = webhookBody + route.slice(webhookIdx + 400, route.indexOf("call.hangup'", webhookIdx) + 2000);
  check(
    "the customer's leg (dialed from the webhook once the operator answers) also sets end_conference_on_exit: true",
    // Tolerate the fields that follow it (operatorInitiated). The earlier
    // version of this guard demanded `}\)` immediately after
    // end_conference_on_exit and had been failing since that dial grew a
    // field — a red guard that guards nothing is worse than no guard.
    /dialBridgeLeg\(\{\s*to: session\.customerNumber,\s*role: 'customer',\s*sessionId: session\.id,\s*endConferenceOnExit: true,/.test(webhookAnsweredSection),
  );

  const bringInAiIdx = route.indexOf("router.post('/:id/bring-in-ai'");
  const bringInAiEndIdx = route.indexOf("router.post('/:id/end'");
  const bringInAiBody = route.slice(bringInAiIdx, bringInAiEndIdx);
  const aiLegIdx = route.indexOf('async function dialAiLegMuted');
  const aiLegBody = route.slice(aiLegIdx, route.indexOf('const assistantIdByLine', aiLegIdx));
  check(
    "the AI's leg sets end_conference_on_exit: false — the AI must NEVER be able to end a live customer call by leaving",
    /role: 'ai',\s*sessionId: session\.id,\s*endConferenceOnExit: false,/.test(aiLegBody),
  );
  check(
    'bringing the AI in is only allowed once the call is active (operator + customer already connected)',
    /if \(session\.status !== 'active'\) \{\s*res\.status\(409\)/.test(bringInAiBody),
  );

  // ── The takeover is a conference mute, not a third-party attach ─────────────
  // The property: the AI reaches the bridge as its OWN conference leg, muted,
  // and is handed the call by unmuting it. The rejected alternative —
  // ai_assistant_start on the customer's already-conferenced leg — returns 200
  // and then ends its own conversation about a second later (production session
  // 89b6c4c7: conversation created 16:16:19.17, call.conversation.ended
  // 16:16:20.19, zero messages on GET /v2/ai/conversations/{id}/messages), so
  // the operator hears the customer and no AI at all.
  check('POST /:id/takeover exists (hand the AI the call)', /router\.post\('\/:id\/takeover', async/.test(route));
  check('POST /:id/hand-back exists (take the call back)', /router\.post\('\/:id\/hand-back', async/.test(route));
  check(
    "the AI's leg joins the conference MUTED unless the operator is taking over in the same breath",
    /mute: !unmuteNow,/.test(aiLegBody),
  );
  check(
    'dialBridgeLeg forwards mute into conference_config',
    /\.\.\.\(params\.mute \? \{ mute: true \} : \{\}\)/.test(route),
  );
  check(
    "the AI's leg never starts a conference of its own",
    /params\.role === 'ai' \? \{ start_conference_on_enter: false \}/.test(route),
  );
  check(
    'takeover unmutes through the conference API, addressing one participant by call_control_id',
    /conferences\/\$\{encodeURIComponent\(conferenceName\)\}\/actions\/\$\{action\}/.test(route) &&
      /call_control_ids: \[callControlId\]/.test(route) &&
      /const action = muted \? 'mute' : 'unmute'/.test(route),
  );
  check(
    'the conference-leg transport is the production default (the legacy attach path is rollback-only)',
    /export function aiLegTransport\(\): 'leg' \| 'attach' \{\s*return process\.env\.APEX_BRIDGE_AI_TRANSPORT === 'attach' \? 'attach' : 'leg';/.test(route),
  );
  check(
    'a dial the API accepted never claims the AI joined — the leg waits for the conference event',
    aiLegBody.indexOf('status: \'ai_dialing\'') !== -1 && !/'ai_joined'/.test(aiLegBody),
  );
  check(
    'the AI-join signal comes from conference.participant.joined, not call.answered',
    /conference\.participant\.joined/.test(route) &&
      /eventType\.startsWith\('conference\.participant\.'\)/.test(route) &&
      /if \(aiLegTransport\(\) === 'attach'\) \{\s*\n\s*await db\.update\(callBridgeSessions\)\.set\(\{ status: 'ai_joined'/.test(route),
  );

  // ── The operator dictates the call, the line, and the agent ────────────────
  check(
    'POST /start accepts the caller ID, the AI line, the assistant and the call topic',
    /fromNumber\?: string;/.test(startBody) &&
      /assistantLine\?: string;/.test(startBody) &&
      /assistantId\?: string;/.test(startBody) &&
      /topic\?: string;/.test(startBody),
  );
  check(
    'an operator-chosen caller ID is refused unless APEX already approved it',
    /!approvedCallerIdNumbers\(\)\.includes\(requestedFrom\)/.test(startBody),
  );
  check(
    'an operator-chosen AI line is refused unless APEX already approved it',
    /!approvedAssistantLines\(\)\.includes\(requestedLine\)/.test(startBody),
  );
  check(
    'autoJoinAi puts the AI on the bridge before the operator leg is dialed (before the customer can ring)',
    /if \(autoJoinAi\) \{[\s\S]{0,300}dialAiLegMuted\(/.test(startBody) &&
      startBody.indexOf('await dialAiLegMuted(') < startBody.indexOf("to: operatorNumber"),
  );
  check(
    'a per-session caller ID reaches every leg it should (operator and AI)',
    /fromNumber: requestedFrom,[\s\S]{0,200}operatorInitiated: true,/.test(startBody) &&
      /fromNumber: session\.fromNumber \?\? null,/.test(aiLegBody),
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
  check('schema.ts stores per-session assistant greetings', /assistantGreeting: text\('assistant_greeting'\)/.test(schema));
  check('schema.ts stores per-session assistant instructions', /assistantInstructions: text\('assistant_instructions'\)/.test(schema));
  check(
    'client.ts bootstrap DDL creates call_bridge_sessions (fresh databases must not 42P01 on first boot)',
    /CREATE TABLE IF NOT EXISTS call_bridge_sessions/.test(client),
  );
  check('client.ts bootstrap DDL adds assistant_greeting for upgraded databases', /ADD COLUMN IF NOT EXISTS assistant_greeting text/.test(client));
  check('client.ts bootstrap DDL adds assistant_instructions for upgraded databases', /ADD COLUMN IF NOT EXISTS assistant_instructions text/.test(client));
  // The mute state and the operator's per-call choices must survive a
  // redeploy on an existing database, or the dashboard shows a listening AI as
  // one that is talking (and vice versa) after every deploy.
  for (const [column, pattern] of [
    ['ai_muted', /ADD COLUMN IF NOT EXISTS ai_muted boolean NOT NULL DEFAULT true/],
    ['ai_auto_join', /ADD COLUMN IF NOT EXISTS ai_auto_join boolean NOT NULL DEFAULT false/],
    ['assistant_id', /ADD COLUMN IF NOT EXISTS assistant_id text/],
    ['assistant_line', /ADD COLUMN IF NOT EXISTS assistant_line text/],
    ['assistant_topic', /ADD COLUMN IF NOT EXISTS assistant_topic text/],
    ['from_number', /ADD COLUMN IF NOT EXISTS from_number text/],
    ['ai_takeover_at', /ADD COLUMN IF NOT EXISTS ai_takeover_at timestamptz/],
  ] as const) {
    check(`client.ts bootstrap DDL adds call_bridge_sessions.${column}`, pattern.test(client));
    check(`schema.ts declares call_bridge_sessions.${column}`, new RegExp(`${column.replace(/_(.)/g, (_, c) => c.toUpperCase())}`).test(schema));
  }
  check('the AI is muted by default in the schema', /aiMuted: boolean\('ai_muted'\)\.notNull\(\)\.default\(true\)/.test(schema));

  // ── Frontend + env docs ─────────────────────────────────────────────────────
  const apiClient = read('packages/dashboard/src/lib/api.ts');
  check(
    'lib/api.ts exposes callBridge.start/status/bringInAi/takeover/handBack/end',
    /callBridge: \{/.test(apiClient) &&
      /bringInAi: \(id: string, unmute = false\)/.test(apiClient) &&
      /takeover: \(id: string\)/.test(apiClient) &&
      /handBack: \(id: string\)/.test(apiClient),
  );
  const panel = read('packages/dashboard/src/components/CallBridgePanel.tsx');
  check(
    'the panel exposes the takeover button, the take-back button and the silent pre-join choice',
    /Take over — let the AI talk/.test(panel) &&
      /Take back — mute the AI/.test(panel) &&
      /autoJoinAi/.test(panel) &&
      /What this call is about/.test(panel),
  );
  const salesOpsPanel = read('packages/dashboard/src/components/SalesOperationsPanel.tsx');
  check(
    'CallBridgePanel is imported and rendered on the Calls sub-tab',
    /import \{ CallBridgePanel \} from '\.\/CallBridgePanel\.js';/.test(salesOpsPanel) && /<CallBridgePanel \/>/.test(salesOpsPanel),
  );
  check(
    '.env.example documents the new connection id and webhook secret',
    /TELNYX_CALL_BRIDGE_CONNECTION_ID=/.test(env) && /TELNYX_CALL_BRIDGE_WEBHOOK_SECRET=/.test(env),
  );
  check(
    '.env.example documents the approved APEX outbound caller ID',
    /APEX_FRONT_DESK_NUMBER=\+18329757665/.test(env),
  );
  check(
    '.env.example documents the AI takeover transport, the extra caller IDs and the extra AI lines',
    /APEX_BRIDGE_AI_TRANSPORT=/.test(env) &&
      /APEX_BRIDGE_CALLER_ID_NUMBERS=/.test(env) &&
      /APEX_BRIDGE_AI_LINES=/.test(env) &&
      /APEX_BRIDGE_AI_ASSISTANT_ID=/.test(env),
  );

  // ── Approved caller ID guard ───────────────────────────────────────────────
  check('call-bridge exports the approved APEX outbound number', /APPROVED_APEX_OUTBOUND_NUMBER = '\+18329757665'/.test(route));
  check(
    'dialBridgeLeg falls back to configuredApexOutboundNumber when the operator picked no caller ID',
    /const from = params\.fromNumber \?\? configuredApexOutboundNumber\(\)/.test(route),
  );
  check(
    'dialBridgeLeg config error names the exact required APEX_FRONT_DESK_NUMBER',
    /APEX_FRONT_DESK_NUMBER=\$\{APPROVED_APEX_OUTBOUND_NUMBER\}/.test(route),
  );
  check(
    'assistant copy replaces FIRST NAME and {{first_name}} before Telnyx receives it',
    /function sanitizeAssistantCopy/.test(route) &&
      /replace\(\/\\\{\\\{\\s\*first_\?name/.test(route) &&
      /replace\(\/\\bFIRST\\s\+NAME\\b/.test(route),
  );
  check(
    'Telnyx receives explicit session dynamic variables',
    /dynamic_variables: dynamicVariables/.test(route) && /function assistantDynamicVariablesForSession/.test(route),
  );
  check(
    'transcription setup begins before the AI-start request completes',
    /const transcriptionPromise = telnyxCommand\(session\.customerCallControlId, 'transcription_start'/.test(route) &&
      route.indexOf('const transcriptionPromise = telnyxCommand') < route.indexOf("const assistantId = process.env.TELNYX_AI_ASSISTANT_ID"),
  );

  // ── Pure helpers: run them, don't just read them ────────────────────────────
  const mod = (await import(
    pathToFileURL(path.join(root, 'packages/api-server/src/routes/call-bridge.ts')).href
  )) as typeof import('../packages/api-server/src/routes/call-bridge.js');
  const {
    encodeClientState,
    decodeClientState,
    verifyCallBridgeKey,
    dialBridgeLeg,
    configuredApexOutboundNumber,
    bridgeTakeoverBriefing,
    assistantArmVariablesForBridge,
    aiLegTransport,
  } = mod;

  // Executed, not pattern-matched: the transport default is the whole point.
  const priorTransport = process.env.APEX_BRIDGE_AI_TRANSPORT;
  try {
    delete process.env.APEX_BRIDGE_AI_TRANSPORT;
    check('with nothing configured, the AI takeover uses the conference leg', aiLegTransport() === 'leg');
    process.env.APEX_BRIDGE_AI_TRANSPORT = 'attach';
    check('APEX_BRIDGE_AI_TRANSPORT=attach still selects the legacy path (rollback stays available)', aiLegTransport() === 'attach');
  } finally {
    if (priorTransport === undefined) delete process.env.APEX_BRIDGE_AI_TRANSPORT;
    else process.env.APEX_BRIDGE_AI_TRANSPORT = priorTransport;
  }

  // ── The AI's brief and the arming map: run them, don't pattern-match ───────
  const bridgeState = {
    id: 'sess-brief',
    customerNumber: '+183****4970',
    assistantTopic: 'Ask who authorised the June road closure.',
  } as unknown as Parameters<typeof assistantArmVariablesForBridge>[0];
  const brief = bridgeTakeoverBriefing(bridgeState.assistantTopic);
  check(
    'the brief tells the inbound assistant this is not a tip call',
    /NOT an inbound tip call/.test(brief) && /do not open with "How can I help you\?"/.test(brief),
  );
  check("the brief forbids the assistant from hanging up the operator's call", /do not use the Hangup tool/.test(brief));
  check("the brief carries the operator's topic verbatim", brief.includes('Ask who authorised the June road closure.'));
  check(
    'a topic-free call still gets a usable brief (no empty instruction)',
    /Follow what has actually been said on the line\./.test(bridgeTakeoverBriefing('   ')),
  );
  const armed = assistantArmVariablesForBridge(bridgeState, {
    dynamicVariables: { office: 'Harris County Records', question_list: 'Q1; Q2' },
  });
  check(
    'arming writes the briefing and the campaign office onto the assistant',
    armed['caller_context'] === brief && armed['office'] === 'Harris County Records',
  );
  check("the operator's topic wins over the campaign fact and is never dropped", armed['fact'] === bridgeState.assistantTopic);
  check(
    'arming replaces the whole map, so no stale script key survives unset',
    Object.keys(armed).length === 7 && armed['question_list'] === 'Q1; Q2',
  );

  const state = { sessionId: 'sess-123', role: 'operator' as const };
  const encoded = encodeClientState(state);
  check('encodeClientState produces a valid base64 string', /^[A-Za-z0-9+/]+=*$/.test(encoded));
  check('decodeClientState round-trips what encodeClientState produced', JSON.stringify(decodeClientState(encoded)) === JSON.stringify(state));
  check('decodeClientState rejects garbage rather than throwing', decodeClientState('not-valid-base64-json!!!') === null);
  check('decodeClientState rejects a payload with an unknown role', decodeClientState(Buffer.from(JSON.stringify({ sessionId: 'x', role: 'supervisor' })).toString('base64')) === null);
  const monitor = { sessionId: 'sess-123', role: 'monitor' as const };
  check('decodeClientState accepts a listen-in leg', JSON.stringify(decodeClientState(encodeClientState(monitor))) === JSON.stringify(monitor));
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

  const savedApprovedFrom = process.env.APEX_FRONT_DESK_NUMBER;
  try {
    process.env.APEX_FRONT_DESK_NUMBER = '+1 (832) 975-7665';
    check('configuredApexOutboundNumber accepts only the approved caller ID, normalized', configuredApexOutboundNumber() === '+18329757665');
    process.env.APEX_FRONT_DESK_NUMBER = '+11234567890';
    check('configuredApexOutboundNumber rejects the old placeholder/1234-style caller ID', configuredApexOutboundNumber() === null);
    delete process.env.APEX_FRONT_DESK_NUMBER;
    check('configuredApexOutboundNumber fails closed when no caller ID is configured', configuredApexOutboundNumber() === null);
  } finally {
    if (savedApprovedFrom === undefined) delete process.env.APEX_FRONT_DESK_NUMBER;
    else process.env.APEX_FRONT_DESK_NUMBER = savedApprovedFrom;
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
