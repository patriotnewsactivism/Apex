/** Deterministic Phase-5.5 guard: autonomy approval policy.
 *
 * Pure — no DB: asserts the hard-gated set can never auto-approve (even when
 * a project lists a hard-gated tool in autoapproveTools), that every
 * autonomy-eligible tool follows the mode+allowlist path, and that the gate
 * fails closed on every ambiguous input.
 *
 * Usage: pnpm --filter @workspace/core exec tsx scripts/verify-approval-policy.ts
 */
// Force the BuildMyBot/CaseBuddy connectors to register their tool
// definitions even in an environment with no real credentials configured, so
// the "registry consistency" check below actually inspects the real
// requiresApproval flags on buildmybot_dispatch_engineering /
// casebuddy_dispatch_engineering instead of skipping them with an unverified
// "policy still blocks it" claim -- that unverified claim is exactly what let
// the 2026-09-07 requiresApproval:false drift on both of those tools ship
// unnoticed. These are dummy values only used to satisfy the *Configured()
// url-shape checks; no network call happens at registration time.
// NOTE: these env vars are set here but static `import` statements below are
// hoisted per ES module semantics -- they evaluate before ANY of this file's
// own top-level statements run, textual order notwithstanding. Since
// tool-registry-with-base44.ts calls ensureBase44Registered() at its own
// module top level (building + caching the singleton ToolRegistry on first
// touch), a static import here would build that singleton BEFORE these env
// vars exist, permanently caching a registry with the connectors
// unconfigured -- silently defeating the whole point of setting them. Using
// dynamic import() below (inside main(), after these lines have already run)
// avoids that: dynamic import() is a runtime expression, not hoisted.
process.env.BUILDMYBOT_SUPABASE_URL ||= 'https://guard-script-dummy.supabase.co';
process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY ||= 'guard-script-dummy-key';
process.env.CASEBUDDY_SUPABASE_URL ||= 'https://guard-script-dummy.supabase.co';
process.env.CASEBUDDY_SUPABASE_SERVICE_KEY ||= 'guard-script-dummy-key';

type ApprovalPolicyModule = typeof import('../packages/core/src/approval-policy.js');
type ToolRegistryModule = typeof import('../packages/core/src/tool-registry-with-base44.js');
let evaluatePolicy: ApprovalPolicyModule['evaluatePolicy'];
let HARD_GATED_TOOLS: ApprovalPolicyModule['HARD_GATED_TOOLS'];
let AUTONOMY_ELIGIBLE_TOOLS: ApprovalPolicyModule['AUTONOMY_ELIGIBLE_TOOLS'];
let AUTONOMY_MODES: ApprovalPolicyModule['AUTONOMY_MODES'];
let getToolRegistry: ToolRegistryModule['getToolRegistry'];

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label} ${detail !== undefined ? JSON.stringify(detail) : ''}`);
  if (!ok) failures++;
};

const AUTONOMOUS = 'full_autonomous';

async function main(): Promise<void> {
  // Dynamic imports, deliberately AFTER the env vars above have already run
  // (see the note at the top of this file) -- this is what actually makes
  // the registry build with BuildMyBot/CaseBuddy connectors registered.
  const approvalPolicy = await import('../packages/core/src/approval-policy.js');
  ({ evaluatePolicy, HARD_GATED_TOOLS, AUTONOMY_ELIGIBLE_TOOLS, AUTONOMY_MODES } = approvalPolicy);
  ({ getToolRegistry } = await import('../packages/core/src/tool-registry-with-base44.js'));

  const allowAll = [...AUTONOMY_ELIGIBLE_TOOLS, ...HARD_GATED_TOOLS];

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
  let unregisteredHardGated = 0;
  for (const tool of [...HARD_GATED_TOOLS]) {
    const registered = registry.get(tool);
    if (registered) {
      // This must be a real assertion, not an advisory note: the 2026-09-07
      // incident was exactly a hard-gated tool registered with
      // requiresApproval:false, which used to only get a soft "ℹ️" here
      // instead of a hard ❌. It's now caught below AND ToolRegistry.execute
      // no longer depends on this flag for hard-gated tools at all -- this
      // check exists to catch drift in the metadata itself, defense-in-depth.
      check(`${tool} (hard-gated) requires human approval`, registered.requiresApproval === true, registered);
    } else {
      unregisteredHardGated++;
    }
  }
  if (unregisteredHardGated > 0) {
    console.log(`  ℹ️  ${unregisteredHardGated} hard-gated tool(s) not registered in this run (connector unconfigured) — central HARD_GATED_TOOLS check in ToolRegistry.execute() still blocks them regardless of registration or requiresApproval metadata`);
  }

  console.log('\n── live execute() enforcement: hard gate fires before any side effect ──');
  // Real functional check, not just a metadata read: calls the actual
  // ToolRegistry.execute() against a mock context whose requestApproval
  // rejects, and confirms (a) requestApproval was actually invoked for the
  // hard-gated tool, and (b) execute() returned the rejection WITHOUT ever
  // reaching the tool's own side-effecting execute() body (which for
  // buildmybot_dispatch_engineering/casebuddy_dispatch_engineering would
  // otherwise insert a real row into the tasks table). This is what would
  // have caught the 2026-09-07 drift directly: that incident's actual
  // failure mode was requestApproval never being called at all.
  for (const tool of [...HARD_GATED_TOOLS]) {
    const registered = registry.get(tool);
    if (!registered) continue;
    let approvalRequestedFor: string | null = null;
    const result = await registry.execute(tool, buildMinimalValidArgs(registered), {
      agentId: 'guard-script-test-agent',
      workspaceRoot: process.cwd(),
      requestApproval: async (toolName) => {
        approvalRequestedFor = toolName;
        return false; // reject — must short-circuit before any real side effect
      },
    });
    check(
      `${tool}: requestApproval was actually invoked (not skipped via requiresApproval)`,
      approvalRequestedFor === tool,
      { approvalRequestedFor },
    );
    check(
      `${tool}: rejected approval blocks execution (no side effect ran)`,
      result.success === false && result.error === 'Action rejected by user',
      result,
    );
  }

  console.log('\n── generic regression: a hard-gated tool with requiresApproval:false is still blocked ──');
  // Reproduces the exact 2026-09-07 incident shape generically, with a
  // synthetic tool, so this guard keeps catching the pattern even for
  // hard-gated tools that don't exist yet -- not just the two that already
  // got fixed (which could otherwise silently make this guard toothless the
  // next time the same mistake happens on a brand-new tool).
  {
    const registry = getToolRegistry(process.cwd());
    const fakeToolName = '__guard_script_synthetic_hard_gated_tool__';
    let sideEffectRan = false;
    let approvalRequestedFor: string | null = null;
    registry.register({
      name: fakeToolName,
      description: 'Synthetic tool for the approval-policy guard script only.',
      // Avoiding a real `zod` import here — this pnpm workspace layout
      // doesn't hoist it to a path resolvable from scripts/, only into
      // individual packages' own node_modules. execute() only ever calls
      // schema.safeParse(rawArgs), so a minimal object satisfying that shape
      // is sufficient and keeps this script dependency-free.
      schema: { safeParse: () => ({ success: true, data: {} }) } as unknown as import('zod').ZodObject<Record<string, never>>,
      requiresApproval: false, // incorrectly false, on purpose — this is the incident shape
      async execute() {
        sideEffectRan = true; // must never run once the tool is added to HARD_GATED_TOOLS below
        return {};
      },
    });
    HARD_GATED_TOOLS.add(fakeToolName);
    try {
      const result = await registry.execute(fakeToolName, {}, {
        agentId: 'guard-script-test-agent',
        workspaceRoot: process.cwd(),
        requestApproval: async (toolName) => {
          approvalRequestedFor = toolName;
          return false;
        },
      });
      check(
        'synthetic hard-gated tool with requiresApproval:false still triggers requestApproval',
        approvalRequestedFor === fakeToolName,
        { approvalRequestedFor },
      );
      check(
        'synthetic hard-gated tool with requiresApproval:false never runs its side effect',
        sideEffectRan === false && result.success === false,
        { sideEffectRan, result },
      );
    } finally {
      HARD_GATED_TOOLS.delete(fakeToolName); // clean up — must not leak into other checks/processes
    }
  }

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Build a minimal plausible args object satisfying a tool's zod schema well
 * enough to pass safeParse and reach the approval gate. Doesn't need to be
 * semantically valid -- execute() must reject on the approval check before
 * any of these values are ever used for a real side effect.
 */
function buildMinimalValidArgs(tool: { schema: unknown }): Record<string, unknown> {
  const shape = (tool.schema as { shape?: Record<string, unknown> })?.shape;
  if (!shape) return {};
  const args: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const typeName = (fieldSchema as { _def?: { typeName?: string } })?._def?.typeName;
    const def = (fieldSchema as { _def?: { typeName?: string; values?: unknown[]; innerType?: unknown } })?._def;
    switch (typeName) {
      case 'ZodString':
        args[key] = 'guard-script-test-value';
        break;
      case 'ZodNumber':
        args[key] = 1;
        break;
      case 'ZodBoolean':
        args[key] = false;
        break;
      case 'ZodArray':
        args[key] = [];
        break;
      case 'ZodEnum':
        // z.enum(['a','b']) — use its first declared option so safeParse
        // accepts it; any value works since this never reaches tool.execute.
        args[key] = Array.isArray(def?.values) ? def.values[0] : 'guard-script-test-value';
        break;
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
        break; // omit — optional/defaulted fields don't need a value to pass safeParse
      default:
        args[key] = 'guard-script-test-value';
    }
  }
  return args;
}
