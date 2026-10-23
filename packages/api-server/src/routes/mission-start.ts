// Pure decision for POST /api/missions/:missionId/start. Kept DB-free so the
// gating rules are unit-tested directly.
//
// A mission submitted for validation gets an approval row
// (toolName 'submit_mission_for_validation'), but approving it only requeues
// the validation task — nothing ever moved the mission itself from
// 'validating' to 'running'. This is that missing operator step.

export type MissionStartInput = {
  goalStatus: string;
  missionStatus: string;
  /** Statuses of the mission's submit_mission_for_validation approvals. */
  validationApprovalStatuses: string[];
};

export type MissionStartDecision =
  | { ok: true }
  | { ok: false; httpStatus: 400 | 409; error: string };

export function decideMissionStart(input: MissionStartInput): MissionStartDecision {
  if (input.missionStatus !== 'validating') {
    return {
      ok: false,
      httpStatus: 400,
      error: `Mission is not validating (current: ${input.missionStatus}). Only validating missions can be started.`,
    };
  }
  if (input.goalStatus !== 'active') {
    return {
      ok: false,
      httpStatus: 400,
      error: `Mission goal is not active (current: ${input.goalStatus}). Reactivate the goal before starting.`,
    };
  }
  if (!input.validationApprovalStatuses.includes('approved')) {
    return {
      ok: false,
      httpStatus: 409,
      error: input.validationApprovalStatuses.length === 0
        ? 'Mission has no validation approval. Submit it for validation first.'
        : 'Mission validation approval is not approved yet. Approve it before starting.',
    };
  }
  return { ok: true };
}

export function executeMissionTaskTitle(goalTitle: string): string {
  return `Execute mission: ${goalTitle}`;
}

/** Agent queues only claim tasks assigned to them, so an unassigned task would
 *  never run. Default to the COO — the same agent the work-generation job
 *  hands goal execution to. */
export const DEFAULT_MISSION_EXECUTION_AGENT = 'apex-coo-001';

export function missionExecutionAgent(assignedAgentId: string | null | undefined): string {
  return assignedAgentId && assignedAgentId.trim() ? assignedAgentId : DEFAULT_MISSION_EXECUTION_AGENT;
}
