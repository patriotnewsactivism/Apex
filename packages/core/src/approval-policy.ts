// ─── Autonomy-Mode Approval Policy ───────────────────────────────────────────
//
// Phase 5.5 of the autonomous-execution scheduler. The single approval gate in
// ToolRegistry.execute consults this policy before asking a human:
//
//   project.autonomyLevel === 'autonomous' style mode
//   && tool ∈ project.autoapproveTools
//   && task belongs to that project
//   && tool ∉ HARD_GATED_TOOLS          → proceed without human approval
//   otherwise                            → existing human-approval gate
//
// Fail-closed by construction: a missing task row, a missing project row, an
// unknown tool, an unset autonomy mode, or a task whose goal is unscoped all
// fall through to the ordinary approval gate. Learning may never weaken this:
// the hard-gated set is a constant; the guard script
// scripts/verify-approval-policy.ts asserts no hard-gated tool can ever be
// auto-approved.

/** Autonomy modes that may consider the autoapproveTools allowlist. */
export const AUTONOMY_MODES = new Set(['full_autonomous', 'autonomous']);

/**
 * Standing operator authorization. Don explicitly authorized APEX to approve
 * all approval-gated actions until further notice. Keep the old hard-gate
 * policy intact underneath this switch so setting the env var to false
 * immediately restores the previous fail-closed behavior without a code
 * rollback.
 *
 * Enabled by default until the operator revokes it. Explicit false-like values
 * are the kill switch.
 */
export function operatorAutoApproveAllEnabled(): boolean {
  const raw = process.env.APEX_OPERATOR_AUTO_APPROVE_ALL?.trim().toLowerCase();
  if (!raw) return true;
  return !new Set(['0', 'false', 'off', 'no', 'disabled']).has(raw);
}

/**
 * Tools that are NEVER auto-approvable, no matter what a project's
 * autoapproveTools says (user-confirmed hard human gates, plan Decisions #3,
 * plus existing externally-visible connector tools).
 */
export const HARD_GATED_TOOLS = new Set<string>([
  // APEX control-plane prod deploy is the operator's own release path.
  'deploy_to_environment',
  'rollback_deployment',
  // Real phone calls to real people.
  'make_outbound_call',
  // Real outbound sales email to real inboxes (2026-09-06). One-off and
  // batch share the same hard gate — a "batch" is just N of these in a row.
  'send_email',
  'send_email_campaign_batch',
  // Provisions a REAL, billed, public phone number (2026-09-06).
  'provision_inbound_number',
  // Updates a PERSISTENT inbound-call assistant in place; if a number is
  // already assigned it takes effect for real callers with no separate
  // activation step (2026-09-06).
  'configure_inbound_assistant',
  // Raw shell execution stays a human gate unless an executor sandbox
  // replaces it (plan Decisions #3).
  'runShell',
  // Registering a NEW deploy hook installs a new external capability /
  // stores a secret reference — operator action, never autonomous.
  'register_deploy_hook',
  // Registry writes and cross-application delegation on the portfolio side.
  'register_application',
  'delegate_to_application',
  // Existing externally-visible BuildMyBot / CaseBuddy connector sends.
  'buildmybot_send_briefing',
  'buildmybot_run_workforce',
  'buildmybot_resolve_error',
  'buildmybot_dispatch_engineering',
  'buildmybot_deploy',
  'buildmybot_push_leads',
  'casebuddy_deploy_firm',
  'casebuddy_dispatch_engineering',
]);

/**
 * Gated tools that a project MAY list in autoapproveTools (the bounded
 * autonomy class from plan Decisions #3: push/PR on APEX-created repos,
 * deploys via registered hooks, executor dispatch, artifact publication).
 * Anything gated but absent here is treated as hard-gated for the purposes
 * of this policy (fail-closed default).
 */
export const AUTONOMY_ELIGIBLE_TOOLS = new Set<string>([
  'push_to_remote',
  'create_pull_request',
  'create_github_repo',
  'deploy_via_hook',
  'create_workstream',
  'run_executor_job',
  'publish_artifact',
]);

/** Default allowlist for the APEX control-plane project. Intentionally omits
 *  deploy_via_hook and run_executor_job until those backends are configured. */
export const DEFAULT_APEX_AUTOAPPROVE_TOOLS = [
  'create_github_repo',
  'push_to_remote',
  'create_pull_request',
  'create_workstream',
  'publish_artifact',
] as const;

export const CONTROL_PLANE_PROJECT_ID = 'apex';

/** Strip hard-gated and unknown tools. Fail closed: empty if nothing eligible remains. */
export function sanitizeAutoapproveTools(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    if (HARD_GATED_TOOLS.has(name)) continue;
    if (!AUTONOMY_ELIGIBLE_TOOLS.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface ApprovalDecision {
  autoApprove: boolean;
  reason: string;
}

/**
 * Evaluate whether a gated tool call may skip human approval for the task's
 * owning project. Pure policy — all lookups happen in the caller wiring
 * (evaluateForTask) so this function is trivially unit-testable.
 */
export function evaluatePolicy(input: {
  toolName: string;
  projectAutonomyLevel: string | null | undefined;
  projectAutoapproveTools: string[] | null | undefined;
  taskBelongsToProject: boolean;
}): ApprovalDecision {
  const { toolName, projectAutonomyLevel, projectAutoapproveTools, taskBelongsToProject } = input;

  if (HARD_GATED_TOOLS.has(toolName)) {
    return { autoApprove: false, reason: `${toolName} is hard-gated and never auto-approvable` };
  }
  if (!AUTONOMY_ELIGIBLE_TOOLS.has(toolName)) {
    return { autoApprove: false, reason: `${toolName} is not in the autonomy-eligible tool set` };
  }
  if (!projectAutonomyLevel || !AUTONOMY_MODES.has(projectAutonomyLevel)) {
    return { autoApprove: false, reason: `project autonomy level '${projectAutonomyLevel ?? 'unset'}' does not permit auto-approval` };
  }
  if (!taskBelongsToProject) {
    return { autoApprove: false, reason: 'task does not belong to the project under policy' };
  }
  const allowlist = projectAutoapproveTools ?? [];
  if (!allowlist.includes(toolName)) {
    return {
      autoApprove: false,
      reason: `${toolName} is gated and not listed in the project's autoapproveTools`,
    };
  }
  return {
    autoApprove: true,
    reason: `autonomy mode '${projectAutonomyLevel}' + autoapproveTools allows ${toolName}`,
  };
}

/**
 * Resolve the task → goal → project chain and evaluate the policy against the
 * real rows. Any lookup failure fails closed (no auto-approval).
 */
export async function evaluateForTask(input: {
  toolName: string;
  taskId?: string;
  goalId?: string;
}): Promise<ApprovalDecision> {
  const { toolName, taskId, goalId } = input;
  try {
    const { db, tasks, goals, projects } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');

    if (!taskId && !goalId) {
      return { autoApprove: false, reason: 'no task or goal context; failing closed' };
    }

    let resolvedGoalId: string | null | undefined = goalId;
    if (taskId) {
      const [task] = await db.select({ goalId: tasks.goalId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (!task) return { autoApprove: false, reason: `task ${taskId} not found; failing closed` };
      resolvedGoalId = task.goalId;
    }

    if (!resolvedGoalId) {
      return evaluateControlPlaneFallback(toolName);
    }

    const [goal] = await db.select({ projectId: goals.projectId }).from(goals).where(eq(goals.id, resolvedGoalId)).limit(1);
    const projectId = goal?.projectId || CONTROL_PLANE_PROJECT_ID;

    const [project] = await db
      .select({ autonomyLevel: projects.autonomyLevel, autoapproveTools: projects.autoapproveTools })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) {
      if (projectId === CONTROL_PLANE_PROJECT_ID) {
        return { autoApprove: false, reason: 'control-plane project apex is not registered; failing closed' };
      }
      return evaluateControlPlaneFallback(toolName);
    }

    return evaluatePolicy({
      toolName,
      projectAutonomyLevel: project.autonomyLevel,
      projectAutoapproveTools: project.autoapproveTools,
      taskBelongsToProject: true,
    });
  } catch (err) {
    return {
      autoApprove: false,
      reason: `policy lookup failed and closed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function evaluateControlPlaneFallback(toolName: string): Promise<ApprovalDecision> {
  try {
    const { db, projects } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');
    const [project] = await db
      .select({ autonomyLevel: projects.autonomyLevel, autoapproveTools: projects.autoapproveTools })
      .from(projects)
      .where(eq(projects.id, CONTROL_PLANE_PROJECT_ID))
      .limit(1);
    if (!project) {
      return { autoApprove: false, reason: 'unscoped work and control-plane project apex is missing; failing closed' };
    }
    return evaluatePolicy({
      toolName,
      projectAutonomyLevel: project.autonomyLevel,
      projectAutoapproveTools: project.autoapproveTools,
      taskBelongsToProject: true,
    });
  } catch (err) {
    return {
      autoApprove: false,
      reason: `control-plane fallback failed closed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}