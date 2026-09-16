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
      return { autoApprove: false, reason: 'task has no goal (unscoped task); failing closed' };
    }

    const [goal] = await db.select({ projectId: goals.projectId }).from(goals).where(eq(goals.id, resolvedGoalId)).limit(1);
    if (!goal?.projectId) {
      return { autoApprove: false, reason: `goal ${resolvedGoalId} has no project; failing closed` };
    }

    const [project] = await db
      .select({ autonomyLevel: projects.autonomyLevel, autoapproveTools: projects.autoapproveTools })
      .from(projects)
      .where(eq(projects.id, goal.projectId))
      .limit(1);
    if (!project) {
      return { autoApprove: false, reason: `project ${goal.projectId} not found; failing closed` };
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