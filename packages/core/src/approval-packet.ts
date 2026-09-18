import { AUTONOMY_ELIGIBLE_TOOLS, HARD_GATED_TOOLS } from './approval-policy.js';

export type PacketRecommendation = 'approve' | 'reject' | 'review';

export interface ApprovalDecisionPacket {
  action: string;
  why: string;
  evidence: string[];
  blastRadius: string;
  rollback: string;
  recommendation: PacketRecommendation;
  hardGated: boolean;
  eligibleForAutonomy: boolean;
  batchKey: string;
}

function clip(value: unknown, max = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function approvalBatchKey(input: {
  kind?: string | null;
  toolName: string;
  reason: string;
}): string {
  const kind = input.kind === 'escalation' ? 'escalation' : 'approval';
  const reason = input.reason.replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
  return `${kind}|${input.toolName}|${reason}`;
}

/** Deterministic operator packet. Never invents facts that are not on the row. */
export function buildApprovalPacket(input: {
  toolName: string;
  reason: string;
  toolArgs?: Record<string, unknown> | null;
  kind?: string | null;
}): ApprovalDecisionPacket {
  const hardGated = HARD_GATED_TOOLS.has(input.toolName);
  const eligibleForAutonomy = AUTONOMY_ELIGIBLE_TOOLS.has(input.toolName);
  const kind = input.kind === 'escalation' ? 'escalation' : 'approval';
  const argKeys = Object.keys(input.toolArgs ?? {}).slice(0, 8);
  const evidence = [
    `Tool: ${input.toolName}`,
    `Kind: ${kind}`,
    input.reason ? `Agent reason: ${clip(input.reason, 240)}` : 'No agent reason recorded',
    argKeys.length > 0 ? `Args present: ${argKeys.join(', ')}` : 'No tool args recorded',
  ];

  if (kind === 'escalation') {
    return {
      action: `Acknowledge escalation from ${input.toolName}`,
      why: 'An agent asked for a decision and kept working. Nothing is blocked.',
      evidence,
      blastRadius: 'None. Acknowledging only clears the message.',
      rollback: 'Not required. Re-open by asking the agent to escalate again if needed.',
      recommendation: 'approve',
      hardGated: false,
      eligibleForAutonomy: false,
      batchKey: approvalBatchKey(input),
    };
  }

  if (hardGated) {
    return {
      action: `Authorize ${input.toolName}`,
      why: 'This tool is hard-gated. No autonomy mode can skip a human decision.',
      evidence,
      blastRadius: 'External, irreversible, or production-control-plane effect.',
      rollback: 'Depends on the tool. Do not approve unless the rollback path is obvious from the args.',
      recommendation: 'review',
      hardGated: true,
      eligibleForAutonomy: false,
      batchKey: approvalBatchKey(input),
    };
  }

  if (eligibleForAutonomy) {
    return {
      action: `Authorize ${input.toolName}`,
      why: 'This tool may be auto-approved on a project whose allowlist includes it. It is waiting because this task is not covered by that policy.',
      evidence,
      blastRadius: 'Bounded engineering effect (repo/PR/workstream/artifact). Not a production deploy, shell, call, or email.',
      rollback: 'Revert the git/workstream/artifact change if the result is wrong.',
      recommendation: 'approve',
      hardGated: false,
      eligibleForAutonomy: true,
      batchKey: approvalBatchKey(input),
    };
  }

  return {
    action: `Authorize ${input.toolName}`,
    why: 'This tool is gated and is not in the autonomy-eligible set.',
    evidence,
    blastRadius: 'Unknown until the args are read. Treat as review-required.',
    rollback: 'Inspect args before approving.',
    recommendation: 'review',
    hardGated: false,
    eligibleForAutonomy: false,
    batchKey: approvalBatchKey(input),
  };
}
