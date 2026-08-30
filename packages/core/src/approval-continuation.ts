export const APPROVAL_WAIT_MAX_MS = 5 * 60 * 1000;
export const APPROVAL_RECOVERY_GRACE_MS = 60 * 1000;
export const APPROVAL_RECOVERY_STALE_MS = APPROVAL_WAIT_MAX_MS + APPROVAL_RECOVERY_GRACE_MS;

export type ApprovalDecision = 'approved' | 'rejected';
export type ConsumedApprovalStatus = 'consumed_approved' | 'consumed_rejected';

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeJsonValue(record[key])]),
    );
  }
  return value;
}

/** Canonical JSON used only for exact approval-payload equality checks. */
export function canonicalApprovalPayload(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

export function approvalPayloadsEqual(left: unknown, right: unknown): boolean {
  return canonicalApprovalPayload(left) === canonicalApprovalPayload(right);
}

export function consumedApprovalStatus(decision: ApprovalDecision): ConsumedApprovalStatus {
  return decision === 'approved' ? 'consumed_approved' : 'consumed_rejected';
}

export function isApprovalDecision(value: string): value is ApprovalDecision {
  return value === 'approved' || value === 'rejected';
}
