/**
 * Guard: every APEX outbound SALES call resolves the same canonical Cartesia
 * agent and the same approved caller ID. The old Receptionist/Telnyx agent and
 * legacy Telnyx conference bridge may continue to exist, but they must never
 * become an implicit fallback for make_outbound_call/campaigns/rehearsal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');
let failures = 0;

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}
function check(label: string, ok: boolean): void {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label}`);
  if (!ok) failures += 1;
}

console.log('Verifying canonical Cartesia sales routing...\n');

const client = read('packages/core/src/cartesia-sales-client.ts');
const registry = read('packages/core/src/tool-registry.ts');
const salesOps = read('packages/api-server/src/routes/sales-ops.ts');
const salesFloor = read('packages/api-server/src/routes/sales-floor.ts');
const reconciler = read('packages/api-server/src/cartesia-sales-reconciler.ts');
const playbooks = read('packages/core/src/sales-playbooks.ts');
const index = read('packages/api-server/src/index.ts');

check(
  'canonical agent name is a single source of truth',
  /CARTESIA_SALES_AGENT_NAME = 'APEX Sales — BuildMyBot'/.test(client) &&
    /CARTESIA_SALES_AGENT_NAME/.test(registry) &&
    /CARTESIA_SALES_AGENT_NAME/.test(reconciler),
);
check(
  'approved outbound caller ID is pinned to +18329757665',
  /APEX_CARTESIA_CALLER_NUMBER = '\+18329757665'/.test(client) &&
    /resolveCartesiaOutboundNumberId/.test(client),
);
check(
  'agent resolution requires exactly one exact-name match and fails closed otherwise',
  /agent\.name === CARTESIA_SALES_AGENT_NAME/.test(client) &&
    /matches\.length !== 1/.test(client) &&
    /Multiple Cartesia agents/.test(client),
);
check(
  'caller ID resolution requires exactly one exact-number match and fails closed otherwise',
  /normalizeE164\(phone\.number\) === APEX_CARTESIA_CALLER_NUMBER/.test(client) &&
    /Approved APEX caller ID/.test(client) &&
    /appears more than once/.test(client),
);

const makeStart = registry.indexOf("name: 'make_outbound_call'");
const makeEnd = registry.indexOf("name: 'get_call_status'", makeStart);
const makeBody = makeStart >= 0 && makeEnd > makeStart ? registry.slice(makeStart, makeEnd) : '';
check('make_outbound_call exists', Boolean(makeBody));
check(
  'make_outbound_call calls canonical Cartesia helper and no live Telnyx/Vapi dial endpoint',
  /startCartesiaSalesCall\(\{/.test(makeBody) &&
    !/api\.telnyx\.com\/v2\/calls/.test(makeBody) &&
    !/api\.vapi\.ai\/call/.test(makeBody),
);
check(
  'make_outbound_call remains approval/compliance gated',
  /requiresApproval:\s*true/.test(makeBody) &&
    /assertOutboundAllowed\(\{\s*channel:\s*'phone'/.test(makeBody),
);
check(
  'campaign linkage is carried into the canonical call',
  /leadId:\s*z\.string\(\)\.optional/.test(makeBody) &&
    /campaignId:\s*z\.string\(\)\.optional/.test(makeBody) &&
    /playbookId:\s*z\.string\(\)\.optional/.test(makeBody),
);

check(
  'Sales Ops self-pitch uses the same canonical Cartesia helper',
  /router\.post\('\/audit-call'/.test(salesOps) &&
    /startCartesiaSalesCall\(\{/.test(salesOps) &&
    !/audit-call[\s\S]{0,6000}startAiFirstSession/.test(salesOps),
);
check(
  'Sales Floor rehearsal uses the same canonical Cartesia helper',
  /router\.post\('\/rehearsal'/.test(salesFloor) &&
    /startCartesiaSalesCall\(\{/.test(salesFloor) &&
    !/rehearsal[\s\S]{0,10000}startAiFirstSession/.test(salesFloor),
);

check(
  'startup reconciles the canonical agent before running diagnostics',
  /reconcileCartesiaSalesAgent/.test(index) &&
    index.indexOf('reconcileCartesiaSalesAgent') < index.lastIndexOf('diagnoseCartesiaRuntime'),
);
check(
  'routine Cartesia agent reconciliation never sends a version description for an unchanged config',
  !/version_description:\s*'Reconcile APEX canonical outbound sales configuration'/.test(reconciler),
);
check(
  'reconciler creates/updates six APEX webhook tools and attaches the event webhook',
  /desiredTools/.test(reconciler) &&
    /lookup_lead_info/.test(reconciler) &&
    /capture_and_qualify_lead/.test(reconciler) &&
    /check_calendar_availability/.test(reconciler) &&
    /book_consultation/.test(reconciler) &&
    /send_demo_link/.test(reconciler) &&
    /record_call_outcome/.test(reconciler) &&
    /webhook_id: webhookId/.test(reconciler),
);
check(
  'Cartesia-injected dynamic/constant tool fields are never emitted in JSON Schema required',
  /const modelRequired = required\.filter/.test(reconciler) &&
    /'dynamic_variable' in record/.test(reconciler) &&
    /'constant_value' in record/.test(reconciler) &&
    /\.\.\.\(modelRequired\.length \? \{ required: modelRequired \} : \{\}\)/.test(reconciler),
);
check(
  'existing Cartesia webhook tools are reused without an unsupported startup PATCH',
  /Treat an exact[\s\S]{0,300}immutable\/reusable at startup/.test(reconciler) &&
    /ids\.push\(matches\[0\]!\.id!\)/.test(reconciler),
);
check(
  'reconciler uses the documented Cartesia phone-number endpoints and SIP import shape',
  /\/agents\/phone-numbers\?q=/.test(reconciler) &&
    /\/agents\/phone-numbers\/providers/.test(reconciler) &&
    /request<PhoneNumberSummary>\('\/agents\/phone-numbers'/.test(reconciler) &&
    /provider: \{ id: providerId \}/.test(reconciler) &&
    /number: APEX_CARTESIA_CALLER_NUMBER/.test(reconciler),
);
check(
  'Telnyx carrier integration requires an explicit outbound SIP trunk and does not redirect inbound calls',
  /CARTESIA_SIP_TRUNK_PROVIDER_ID/.test(reconciler) &&
    /provider\.type === 'sip_trunk'/.test(reconciler) &&
    !/resolveOrCreateTelnyxProvider/.test(reconciler) &&
    !/JSON\.stringify\(\{ agent_id: agentId \}\)/.test(reconciler),
);
check(
  'reconciler never targets the pre-existing Receptionist/Telnyx agent by name or id',
  !/Cartesia Receptionist \(Telnyx\)/.test(reconciler) &&
    !/agent_4Pr3KQCk39EeDx43s7ArAZ/.test(reconciler),
);

check(
  'outbound sales stays silent until callee speech, confirms identity, builds rapport, then pitches',
  /initial_message:\s*''/.test(reconciler) &&
    /stay completely silent when the phone connection opens/.test(reconciler) &&
    /After their first audible greeting, say naturally: "Hey, is this \{\{customer_name\}\}\?"/.test(reconciler) &&
    /How’s your day going\?/.test(reconciler) &&
    /Only then transition into the reason for the call using this campaign line/.test(reconciler) &&
    /inactivity_check_in_secs:\s*5/.test(reconciler),
);
check(
  'Cartesia sales voice cadence is slightly slowed to reduce PSTN\/SIP clipping',
  /voice_id:\s*voiceId[\s\S]{0,120}speed:\s*0\.96/.test(reconciler),
);
check(
  'Cartesia sales responses are constrained for lower conversational latency',
  /temperature:\s*0\.2/.test(reconciler) &&
    /max_output_tokens:\s*96/.test(reconciler) &&
    /usually under twelve spoken words/.test(reconciler),
);
check(
  'BuildMyBot sales pitch is conversational and happens after rapport',
  /firstMessage:\s*'Gotcha\. I’ll keep it quick/.test(playbooks) &&
    /What do you normally do with calls that come in when nobody can pick up\?/.test(playbooks) &&
    /Build brief rapport before the pitch/.test(playbooks),
);


const statusStart = registry.indexOf("name: 'get_call_status'");
const statusEnd = registry.indexOf("name: 'send_email'", statusStart);
const statusBody = statusStart >= 0 && statusEnd > statusStart ? registry.slice(statusStart, statusEnd) : '';
check(
  'get_call_status resolves Cartesia IDs before historical bridge/Vapi compatibility',
  statusBody.indexOf('getCartesiaSalesCall') >= 0 &&
    statusBody.indexOf('getCartesiaSalesCall') < statusBody.indexOf('callBridgeSessions') &&
    statusBody.indexOf('callBridgeSessions') < statusBody.indexOf('VAPI_API_KEY'),
);

if (failures > 0) {
  console.error(`\n❌ ${failures} canonical Cartesia routing check(s) failed.\n`);
  process.exit(1);
}
console.log('\n✅ Canonical Cartesia sales routing verified.\n');
