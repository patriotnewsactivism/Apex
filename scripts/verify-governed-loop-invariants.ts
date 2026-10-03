import fs from 'node:fs';
import path from 'node:path';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
let failures = 0;

const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const check = (label: string, ok: boolean) => {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label}`);
  if (!ok) failures++;
};

const registry = read('packages/core/src/tool-registry.ts');
const provenance = read('packages/core/src/runtime-provenance.ts');
const guard = read('packages/core/src/outbound-compliance-guard.ts');
const compliance = read('packages/core/src/revenue-ops/compliance.ts');
const email = read('packages/core/src/email-delivery.ts');
const cartesia = read('packages/api-server/src/routes/cartesia-sales.ts');
const salesOps = read('packages/api-server/src/routes/sales-ops.ts');
const telnyxAssistant = read('packages/api-server/src/routes/telnyx-assistant.ts');
const telnyxVoice = read('packages/api-server/src/telnyx-voice-guardrails.ts');
const envExample = read('.env.example');

console.log('── runtime provenance: evidence must precede autonomous writes ──');
check(
  'tool registry invokes the runtime provenance gate centrally',
  registry.includes("ensureRuntimeProvenance") &&
    registry.includes("runtimeProvenanceRequiresGate") &&
    registry.includes("Runtime provenance gate blocked"),
);
for (const field of [
  'repo_root',
  'git_commit',
  'branch',
  'package_root',
  'runtime_entrypoint',
  'resolved_workspace_package',
  'artifact_root',
  'database_target',
  'environment_name',
]) {
  check(`provenance records ${field}`, provenance.includes(field));
}
check(
  'nested/shadow workspaces are rejected',
  provenance.includes('shadow/nested workspace') &&
    provenance.includes('target_workspace_root'),
);
check(
  'shell cd/git-clone paths are inspected for shadow checkouts',
  provenance.includes("toolName === 'runShell'") &&
    provenance.includes('known shadow QA checkout path detected') &&
    provenance.includes('git clone inside the canonical runtime tree is forbidden'),
);
check(
  'node_modules writes are rejected',
  provenance.includes('writes into node_modules are forbidden'),
);
check(
  'production requires a known deployed SHA',
  provenance.includes("APEX_BUILD_SHA") &&
    provenance.includes("missing/unknown in production"),
);
check(
  'provenance is persisted to the durable audit chain',
  provenance.includes("runtime.provenance_verified") &&
    provenance.includes("runtime.provenance_failed") &&
    provenance.includes("auditEvents"),
);
check(
  'unknown tools are treated as state-changing by default',
  provenance.includes('Unknown tools are treated as state-changing') &&
    /return true;/.test(provenance),
);

console.log('\n── outbound compliance: one fail-closed evaluator for all channels ──');
check(
  'unified guard uses revenue-ops compliance evaluator',
  guard.includes("from './revenue-ops/compliance.js'") &&
    !guard.includes("from './compliance/evaluator.js'"),
);
check(
  'missing consent-linked contact/org blocks live outreach',
  guard.includes('a consent-linked revenue-ops contact and organization are required'),
);
check(
  'evaluator failure blocks instead of falling back',
  guard.includes('evaluator unavailable') &&
    !guard.includes('using legacy suppression only'),
);
check(
  'phone, SMS and email all require explicit consent in the evaluator',
  compliance.includes("const CONSENT_REQUIRED_CHANNELS: OutboundChannel[] = ['sms', 'email', 'phone']"),
);
check(
  'pending outreach gate blocks instead of falling through',
  compliance.includes('if (!gate.allowed)') &&
    compliance.includes('OUTREACH_GATE_PENDING'),
);
check(
  'destination-specific suppression is checked',
  compliance.includes('eq(suppressions.email') &&
    compliance.includes('eq(suppressions.phoneE164'),
);
check(
  'phone/SMS local window and cross-channel cadence are enforced',
  compliance.includes('OUTSIDE_CALLING_WINDOW') &&
    compliance.includes('CADENCE_EXCEEDED') &&
    compliance.includes('interactions'),
);

console.log('\n── send safeguard sits in front of every live provider call ──');
check(
  'shared email delivery calls assertSendAllowed before Resend',
  email.includes('assertSendAllowed') &&
    email.indexOf('assertSendAllowed') < email.indexOf('fetch(RESEND_API_URL'),
);
check(
  'operator SMS calls assertSendAllowed before Telnyx',
  salesOps.includes('assertSendAllowed') &&
    salesOps.indexOf('assertSendAllowed') < salesOps.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
);
check(
  'front-desk confirmation SMS calls assertSendAllowed before Telnyx',
  telnyxAssistant.includes('assertSendAllowed') &&
    telnyxAssistant.indexOf('assertSendAllowed') < telnyxAssistant.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
);
check(
  'checkout SMS calls assertSendAllowed before Telnyx',
  telnyxVoice.includes('assertSendAllowed') &&
    telnyxVoice.indexOf('assertSendAllowed') < telnyxVoice.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
);
const bookingFnStart = cartesia.indexOf('async function submitCalBooking');
const bookingFn = bookingFnStart >= 0 ? cartesia.slice(bookingFnStart) : '';
check(
  'Cal.com consultation booking asserts before the bookings POST',
  bookingFn.includes('assertSendAllowed') &&
    bookingFn.indexOf('assertSendAllowed') < bookingFn.indexOf("calRequest('bookings'"),
);

console.log('\n── irreversible send paths cannot bypass the evaluator ──');
check(
  'shared email delivery calls assertOutboundAllowed before Resend',
  email.includes("assertOutboundAllowed") &&
    email.indexOf('assertOutboundAllowed') < email.indexOf("fetch(RESEND_API_URL"),
);
check(
  'one-off email passes lead identity into compliance',
  registry.includes("channel: 'email', destination: toEmail, leadId, purpose: 'send_email'"),
);
check(
  'campaign email passes lead identity into shared delivery',
  registry.includes("leadId: row.leadId ?? null") &&
    registry.includes("purpose: 'send_email_campaign_batch'"),
);
check(
  'outbound call passes lead identity into compliance',
  registry.includes("channel: 'phone', destination: customerNumber, leadId, purpose: 'make_outbound_call'"),
);
check(
  'explicit demo-link SMS is persisted as consent before evaluator call',
  cartesia.includes('recordExplicitSmsConsent') &&
    cartesia.includes("channel: 'sms'") &&
    cartesia.includes("status: 'granted'") &&
    cartesia.includes('evaluateOutboundAction'),
);
check(
  'SMS provider call happens only after evaluator allow decision',
  cartesia.indexOf('evaluateOutboundAction({') <
    cartesia.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
);
check(
  'operator SMS uses unified compliance before Telnyx',
  salesOps.includes("assertOutboundAllowed") &&
    salesOps.indexOf("purpose: 'operator_sms'") <
      salesOps.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
);
check(
  'front-desk confirmation SMS uses unified compliance before Telnyx',
  telnyxAssistant.includes("assertOutboundAllowed") &&
    telnyxAssistant.indexOf("purpose: 'front_desk_confirmation'") <
      telnyxAssistant.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
);
check(
  'checkout-link SMS is compliance-gated before Stripe/provider side effects',
  telnyxVoice.includes("assertOutboundAllowed") &&
    telnyxVoice.indexOf("purpose: 'requested_checkout_link'") <
      telnyxVoice.indexOf("https://api.stripe.com/v1/checkout/sessions") &&
    telnyxVoice.indexOf("purpose: 'requested_checkout_link'") <
      telnyxVoice.indexOf("fetch('https://api.telnyx.com/v2/messages'"),
);
check(
  'internal owner-notification SMS remains a deliberate non-prospect exception',
  telnyxVoice.includes('Owner notification SMS') &&
    telnyxVoice.includes('TELNYX_OWNER_NUMBER'),
);

console.log('\n── configuration source of truth ──');
check(
  'documented paid fallback switch is the authoritative ENABLED variant',
  envExample.includes('APEX_PAID_FALLBACK_ENABLED=') &&
    !/^APEX_PAID_FALLBACK=/m.test(envExample),
);

console.log(`\n${failures === 0 ? '✅ Governed-loop invariants hold.' : `❌ ${failures} governed-loop invariant(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
