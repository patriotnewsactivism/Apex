/** Deterministic Phase-5.5 guard: autonomy approval policy.
 *
 * Pure — no DB: asserts the hard-gated set can never auto-approve (even when
 * a project lists a hard-gated tool in autoapproveTools), that every
 * autonomy-eligible tool follows the mode+allowlist path, and that the gate
 * fails closed on every ambiguous input.
 *
 * Usage: pnpm --filter @workspace/core exec tsx scripts/verify-approval-policy.ts
 */
import {
  evaluatePolicy,
  HARD_GATED_TOOLS,
  AUTONOMY_ELIGIBLE_TOOLS,
  AUTONOMY_MODES,
} from '../packages/core/src/approval-policy.js';
import { getToolRegistry } from '../packages/core/src/tool-registry-with-base44.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label} ${detail !== undefined ? JSON.stringify(detail) : ''}`);
  if (!ok) failures++;
};

const AUTONOMOUS = 'full_autonomous';
const allowAll = [...AUTONOMY_ELIGIBLE_TOOLS, ...HARD_GATED_TOOLS];

function main(): void {
  console.log('── hard-gated tools are NEVER auto-approvable ──');
  for (const tool of HARD_GATED_TOOLS) {
    const decision = evaluatePolicy({
      toolName: tool,
      projectAutonomyLevel: AUTONOMOUS,
      projectAutoapproveTools: allowAll,
      taskBelongsToProject: true,
    });
    check(`${tool} stays gated even when listed`, decision.autoApprove === false, decision);
  }

  console.log('\n── autonomy-eligible tools follow mode + allowlist ──');
  for (const tool of AUTONOMY_ELIGIBLE_TOOLS) {
    let decision = evaluatePolicy({
      toolName: tool,
      projectAutonomyLevel: AUTONOMOUS,
      projectAutoapproveTools: [tool],
      taskBelongsToProject: true,
    });
    check(`${tool} auto-approves under autonomy mode + allowlist`, decision.autoApprove === true, decision);

    decision = evaluatePolicy({
      toolName: tool,
      projectAutonomyLevel: 'supervisor',
      projectAutoapproveTools: [tool],
      taskBelongsToProject: true,
    });
    check(`${tool} stays gated under supervisor mode`, decision.autoApprove === false);

    decision = evaluatePolicy({
      toolName: tool,
      projectAutonomyLevel: AUTONOMOUS,
      projectAutoapproveTools: [],
      taskBelongsToProject: true,
    });
    check(`${tool} stays gated when not in allowlist`, decision.autoApprove === false);
  }

  console.log('\n── fail-closed on ambiguous inputs ──');
  const eligible = [...AUTONOMY_ELIGIBLE_TOOLS][0];
  check('no autonomy level → gated', evaluatePolicy({
    toolName: eligible, projectAutonomyLevel: null, projectAutoapproveTools: [eligible], taskBelongsToProject: true,
  }).autoApprove === false);
  check('unknown gated tool → gated (not in eligible set)', evaluatePolicy({
    toolName: 'some_future_gated_tool', projectAutonomyLevel: AUTONOMOUS, projectAutoapproveTools: ['some_future_gated_tool'], taskBelongsToProject: true,
  }).autoApprove === false);
  check('task outside project → gated', evaluatePolicy({
    toolName: eligible, projectAutonomyLevel: AUTONOMOUS, projectAutoapproveTools: [eligible], taskBelongsToProject: false,
  }).autoApprove === false);
  check('null allowlist → gated', evaluatePolicy({
    toolName: eligible, projectAutonomyLevel: AUTONOMOUS, projectAutoapproveTools: null, taskBelongsToProject: true,
  }).autoApprove === false);

  console.log('\n── registry consistency ──');
  const registry = getToolRegistry(process.cwd());
  check('AUTONOMY_MODES contains full_autonomous', AUTONOMY_MODES.has('full_autonomous'));
  for (const tool of AUTONOMY_ELIGIBLE_TOOLS) {
    const registered = registry.get(tool);
    check(`${tool} (autonomy-eligible) exists and is gated`, Boolean(registered) && registered?.requiresApproval === true, registered ? undefined : 'missing');
  }
  for (const tool of [...HARD_GATED_TOOLS]) {
    const registered = registry.get(tool);
    if (registered) {
      check(`${tool} (hard-gated) requires human approval`, registered.requiresApproval === true);
    } else {
      console.log(`  ℹ️  ${tool} is hard-gated in policy but not registered as a tool (connector may be unconfigured) — policy still blocks it`);
    }
  }

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main();