/** Deterministic guard: the new outbound email/inbound-calling tools
 * (2026-09-06 — send_email, send_email_campaign_batch, provision_inbound_number,
 * configure_inbound_assistant) are wired into BOTH gates the way
 * make_outbound_call already is, and the enqueue/read-only tools around them
 * are NOT accidentally over-gated:
 *
 *   1. ToolDefinition.requiresApproval === true  → the ordinary human-approval
 *      gate (asks a real person before every real send/call/purchase).
 *   2. approval-policy.HARD_GATED_TOOLS           → the autonomy-mode gate
 *      (Phase 5.5) — even a project running under full_autonomous mode with
 *      these tools listed in its autoapproveTools can NEVER skip approval.
 *
 * Both matter independently: (1) alone doesn't survive a future project being
 * switched to full autonomy; (2) alone doesn't help if requiresApproval were
 * ever accidentally flipped to false on the tool itself. A tool that drifts
 * out of sync between the two — approval-required in the registry but absent
 * from HARD_GATED_TOOLS, say — is exactly the kind of gap this script exists
 * to catch before it reaches production, not after.
 *
 * Pure — no DB: tool registration builds the in-memory definitions only;
 * execute() is never called.
 *
 * Usage: pnpm --filter @workspace/core exec tsx ../../scripts/verify-email-call-outreach-safety.ts
 */
import { getToolRegistry } from '../packages/core/src/tool-registry.js';
import { HARD_GATED_TOOLS } from '../packages/core/src/approval-policy.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label} ${detail !== undefined ? JSON.stringify(detail) : ''}`);
  if (!ok) failures++;
};

// Tools that send/call/spend real money against a real external party. Every
// one of these MUST require human approval AND be hard-gated against
// autonomy-mode bypass — no exceptions, regardless of how "safe" a future
// change might make them look.
const MUST_BE_HARD_GATED = [
  'make_outbound_call',
  'send_email',
  'send_email_campaign_batch',
  'provision_inbound_number',
  'configure_inbound_assistant',
];

// Tools that only read state or write to APEX's own DB (never reach a real
// inbox/phone/number by themselves). These must stay ungated, or the Sales
// agent can't even check pipeline status without an operator in the loop.
const MUST_NOT_BE_HARD_GATED = [
  'get_call_status',
  'get_email_status',
  'start_email_campaign', // enqueues rows only — see send_email_campaign_batch for the actual send
  'get_email_campaign_status',
  'add_email_suppression',
  'get_inbound_call_config',
];

function main(): void {
  const registry = getToolRegistry(process.cwd());
  const getDef = (name: string) => registry.get(name);

  console.log('── externally-visible send/call/provision tools are hard-gated in BOTH places ──');
  for (const name of MUST_BE_HARD_GATED) {
    const def = getDef(name);
    check(`${name} is registered`, Boolean(def), def);
    if (def) {
      check(`${name}.requiresApproval === true`, def.requiresApproval === true, def);
    }
    check(`${name} ∈ HARD_GATED_TOOLS (survives autonomy-mode allowlisting)`, HARD_GATED_TOOLS.has(name));
  }

  console.log('\n── read-only / enqueue-only tools are NOT over-gated ──');
  for (const name of MUST_NOT_BE_HARD_GATED) {
    const def = getDef(name);
    check(`${name} is registered`, Boolean(def), def);
    if (def) {
      check(`${name}.requiresApproval === false`, def.requiresApproval === false, def);
    }
    check(`${name} ∉ HARD_GATED_TOOLS`, !HARD_GATED_TOOLS.has(name));
  }

  console.log(`\n${failures === 0 ? '✅ All checks passed.' : `❌ ${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
