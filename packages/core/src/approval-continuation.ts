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

// ─── Approval yield (Phase 3 of the autonomous-OS upgrade) ──────────────────
//
// requestHumanApproval used to poll in-process for up to five minutes,
// holding a concurrency slot and racing the ten-minute hard task timeout the
// entire time — the exact pattern that makes "continue working while the
// owner is offline" fail the moment a decision takes longer than five
// minutes to arrive. It now persists the pending approval and throws this
// signal immediately: the task is already durably `awaiting_approval` in
// Postgres by the time this is thrown, so unwinding the execution here loses
// no state. executeTask's outer catch recognizes it and returns cleanly
// (neither success nor failure — see task-checkpoint.ts's soft-yield for the
// same reasoning), the same way it already special-cases an LLM capacity
// pause rather than treating every thrown error as a task failure.
export class ApprovalYieldSignal extends Error {
  constructor(
    public readonly taskId: string,
    public readonly approvalId: string,
  ) {
    super(`Task ${taskId} yielded cleanly to await human decision on approval ${approvalId} — not a failure.`);
    this.name = 'ApprovalYieldSignal';
  }
}

export function isApprovalYieldSignal(err: unknown): err is ApprovalYieldSignal {
  return err instanceof ApprovalYieldSignal;
}

// ─── Durable approval expiry (replaces the old in-process wait timeout) ─────
//
// The removed 5-minute poll had an incidental side effect beyond blocking
// execution: it also gave every approval a hard 5-minute expiry, auto-
// rejecting anything nobody clicked in time. That is far too short for a
// human who is, by the premise of this whole upgrade, expected to sometimes
// be offline for hours. A gated approval now waits durably until a human
// decides OR this much time has passed, whichever comes first — auto-REJECT
// only (never auto-approve), preserving the fail-closed default while
// stopping a task from sitting `awaiting_approval` forever unanswered.
// 0 or a non-finite value disables the expiry entirely (wait indefinitely).
const DEFAULT_APPROVAL_AUTO_REJECT_HOURS = 24;

export function resolveApprovalAutoRejectMs(): number {
  const raw = Number(process.env.APEX_APPROVAL_AUTO_REJECT_HOURS ?? DEFAULT_APPROVAL_AUTO_REJECT_HOURS);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw * 60 * 60 * 1000;
}
