/**
 * Mission-first share of APEX's daily LLM budget.
 *
 * Production 2026-10-23: self-referential internal loops (CEO/CTO delegation
 * verdicts, "VERIFY …" re-checks, PATCH verification, review/closeout tasks)
 * consumed the whole daily allowance by 01:20 CT, and the first capacity
 * pause parked every agent — including the revenue mission's execution task
 * (4fb48c15, apex-coo-001), which was deferred 13 times without doing work.
 *
 * This module splits the EXISTING daily caps by work class. It never raises a
 * cap, never adds a provider, and never admits anything the underlying ledgers
 * would refuse; it only refuses *earlier* for lower-priority work:
 *
 *   operator   — Command chat. Never restricted here (own lane, see operator-lane.ts).
 *   mission    — tasks linked to a revenue mission or lead campaign. Restricted
 *                only by the existing hard caps, so it gets first claim.
 *   internal   — delegation / verification / review loops. Capped at
 *                APEX_INTERNAL_LOOP_MAX_PCT (default 25%) of each daily cap, and
 *                the same normalized task is backed off after
 *                APEX_INTERNAL_LOOP_REPEAT_MAX runs per window.
 *   background — everything else.
 *
 * internal + background together may use at most
 * (100 − APEX_MISSION_RESERVE_PCT)% (default 40%) of each daily cap, so the
 * mission reserve (default 60%) cannot be eaten by non-mission work.
 *
 * Usage is booked from the admission estimate (conservative) per UTC day, in
 * process memory — the same process-local scope as the spend reservations.
 */

export type WorkClass = 'operator' | 'mission' | 'internal' | 'background';
export type BudgetResource = 'requests' | 'tokens' | 'spend_micros';

const RESOURCES: BudgetResource[] = ['requests', 'tokens', 'spend_micros'];
const UTC_DAY_MS = 86_400_000;

function envPct(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** Share of each daily cap that non-mission work may not touch. Default 60. */
export function missionReservePct(): number {
  return envPct('APEX_MISSION_RESERVE_PCT', 60);
}

/** Max share of each daily cap internal delegation/verification may use. Default 25. */
export function internalLoopMaxPct(): number {
  return envPct('APEX_INTERNAL_LOOP_MAX_PCT', 25);
}

/** Runs of the same normalized internal task allowed per window. Default 2. */
export function internalLoopRepeatMax(): number {
  return envInt('APEX_INTERNAL_LOOP_REPEAT_MAX', 2, 1, 100);
}

/** Backoff window for repeated internal tasks, minutes. Default 360 (6h). */
export function internalLoopWindowMinutes(): number {
  return envInt('APEX_INTERNAL_LOOP_WINDOW_MINUTES', 360, 1, 1440);
}

// ─── Classification ──────────────────────────────────────────────────────────

export interface WorkClassInput {
  title?: string | null;
  description?: string | null;
  context?: Record<string, unknown> | null;
  operatorLane?: boolean;
}

const MISSION_CONTEXT_KEYS = ['missionId', 'campaignId', 'leadCampaignId', 'emailCampaignId'];
const MISSION_TEXT = /^(execute mission:|execute mission \(|lead[- ]gen|lead search|lead research|find (\d+\s+)?leads|campaign segment|territory hunt)/i;
const MISSION_DESCRIPTION = /^\s*EXECUTE MISSION \(/;
const INTERNAL_TEXT =
  /^(\s*(urgent|priority|safety net|wave-\d+)?[:\s-]*)?(ceo|cto|coo|cfo|judge)?[\s:-]*(verify|verify-only|re-?verify|verification|delegation verdict|delegation status|review|re-?review|closeout|close-?out|consolidat|confirm|audit|blocker|re-?attempt|follow[- ]?up on|check (on|whether)|collect swarm|task [0-9a-f]{6,} failed)/i;
const INTERNAL_ANYWHERE = /\b(get_delegation_status|collectSwarmResults|PATCH (fix|guard|verification)|claim-vs-artifact|delegating is not delivering)\b/i;

export function classifyWorkClass(input: WorkClassInput): WorkClass {
  if (input.operatorLane) return 'operator';
  const ctx = input.context ?? {};
  for (const key of MISSION_CONTEXT_KEYS) {
    const v = ctx[key];
    if (typeof v === 'string' && v.trim()) return 'mission';
  }
  if (ctx.missionType === 'revenue_ops' || ctx.workClass === 'mission') return 'mission';
  const title = (input.title ?? '').trim();
  const description = input.description ?? '';
  if (MISSION_TEXT.test(title) || MISSION_DESCRIPTION.test(description)) return 'mission';
  if (ctx.workClass === 'internal') return 'internal';
  if (INTERNAL_TEXT.test(title) || INTERNAL_ANYWHERE.test(title) || INTERNAL_ANYWHERE.test(description.slice(0, 600))) {
    return 'internal';
  }
  return 'background';
}

/** Stable signature for "the same verification again": lowercased title with
 *  ids, hashes, numbers and punctuation removed. */
export function internalLoopSignature(title: string): string {
  return title
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '')
    .replace(/\b[0-9a-f]{6,}\b/g, '')
    .replace(/\d+/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .slice(0, 160);
}

// ─── Daily per-class usage ───────────────────────────────────────────────────

type Usage = Record<WorkClass, number>;
const emptyUsage = (): Usage => ({ operator: 0, mission: 0, internal: 0, background: 0 });

let dayKey = '';
let usage: Record<BudgetResource, Usage> = {
  requests: emptyUsage(),
  tokens: emptyUsage(),
  spend_micros: emptyUsage(),
};
/** signature → run start times (ms) for internal-loop backoff. */
const internalRuns = new Map<string, number[]>();
/** taskIds already counted as a run for their signature. */
const countedTasks = new Set<string>();

function rollover(at: number): void {
  const key = new Date(at).toISOString().slice(0, 10);
  if (key === dayKey) return;
  dayKey = key;
  usage = { requests: emptyUsage(), tokens: emptyUsage(), spend_micros: emptyUsage() };
}

function nextUtcMidnightIso(at: number): string {
  const d = new Date(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + UTC_DAY_MS).toISOString();
}

export interface ShareDecision {
  allowed: boolean;
  workClass: WorkClass;
  resource?: BudgetResource;
  reason?: string;
  resumeAt?: string;
}

/**
 * Would booking `requested` units of `resource` for `workClass` stay inside its
 * share of `cap`? cap <= 0 means "no cap configured" → no share applies.
 */
export function checkWorkClassShare(
  resource: BudgetResource,
  workClass: WorkClass,
  cap: number,
  requested: number,
  at: number = Date.now(),
): ShareDecision {
  rollover(at);
  if (workClass === 'operator' || workClass === 'mission') return { allowed: true, workClass };
  if (!Number.isFinite(cap) || cap <= 0) return { allowed: true, workClass };
  const req = Math.max(0, requested);
  const u = usage[resource];
  const nonMissionCeiling = (cap * (100 - missionReservePct())) / 100;
  const nonMissionUsed = u.internal + u.background;
  if (nonMissionUsed + req > nonMissionCeiling) {
    return {
      allowed: false,
      workClass,
      resource,
      resumeAt: nextUtcMidnightIso(at),
      reason: `non-mission work has used ${Math.round(nonMissionUsed)} of its ${Math.round(nonMissionCeiling)} ${resource} (APEX_MISSION_RESERVE_PCT=${missionReservePct()} held for mission/campaign tasks)`,
    };
  }
  if (workClass === 'internal') {
    const internalCeiling = (cap * internalLoopMaxPct()) / 100;
    if (u.internal + req > internalCeiling) {
      return {
        allowed: false,
        workClass,
        resource,
        resumeAt: nextUtcMidnightIso(at),
        reason: `internal delegation/verification has used ${Math.round(u.internal)} of its ${Math.round(internalCeiling)} ${resource} (APEX_INTERNAL_LOOP_MAX_PCT=${internalLoopMaxPct()})`,
      };
    }
  }
  return { allowed: true, workClass };
}

/** Book admitted usage. Call only after the underlying ledger admitted it. */
export function recordWorkClassUsage(
  resource: BudgetResource,
  workClass: WorkClass,
  units: number,
  at: number = Date.now(),
): void {
  rollover(at);
  if (!Number.isFinite(units) || units <= 0) return;
  usage[resource][workClass] += units;
}

/**
 * Backoff/dedupe for repeated internal work. The first LLM call of a task
 * counts as one run of its signature; once a signature has run
 * APEX_INTERNAL_LOOP_REPEAT_MAX times inside the window, further tasks with
 * that signature are deferred until the oldest run leaves the window.
 * Calls from a task that was already admitted are never cut off mid-run.
 */
export function checkInternalLoopRepeat(
  taskId: string | undefined,
  title: string | undefined,
  at: number = Date.now(),
): ShareDecision {
  if (!taskId || !title) return { allowed: true, workClass: 'internal' };
  if (countedTasks.has(taskId)) return { allowed: true, workClass: 'internal' };
  const sig = internalLoopSignature(title);
  if (!sig) return { allowed: true, workClass: 'internal' };
  const windowMs = internalLoopWindowMinutes() * 60_000;
  const runs = (internalRuns.get(sig) ?? []).filter((t) => t > at - windowMs);
  if (runs.length >= internalLoopRepeatMax()) {
    internalRuns.set(sig, runs);
    return {
      allowed: false,
      workClass: 'internal',
      reason: `same internal task ran ${runs.length}x in the last ${internalLoopWindowMinutes()}m (APEX_INTERNAL_LOOP_REPEAT_MAX=${internalLoopRepeatMax()}): "${sig.slice(0, 80)}"`,
      resumeAt: new Date(Math.min(...runs) + windowMs).toISOString(),
    };
  }
  runs.push(at);
  internalRuns.set(sig, runs);
  countedTasks.add(taskId);
  if (countedTasks.size > 5_000) countedTasks.clear();
  return { allowed: true, workClass: 'internal' };
}

/** Marker carried in the capacity-pause error so BaseAgent defers only this
 *  task instead of latching a workspace-wide pause (which would park mission
 *  work behind an internal-loop limit). */
export const WORK_CLASS_DEFERRAL_MARKER = 'work-class share';

export function formatWorkClassDeferral(decision: ShareDecision): string {
  const resumeAt = decision.resumeAt ?? new Date(Date.now() + 60_000).toISOString();
  return `APEX LLM capacity paused. resume-at=${resumeAt} | ${WORK_CLASS_DEFERRAL_MARKER} (${decision.workClass}): ${decision.reason ?? 'limit reached'}`;
}

export function isWorkClassDeferral(message: string | null | undefined): boolean {
  // Only a deferral raised by this gate itself (first segment), not a mixed
  // provider-capacity failure that merely mentions a share-limited paid route.
  return typeof message === 'string' && /^APEX LLM capacity paused\. resume-at=\S+ \| work-class share \(/.test(message);
}

export interface WorkClassUsageSnapshot {
  day: string;
  missionReservePct: number;
  internalLoopMaxPct: number;
  internalLoopRepeatMax: number;
  internalLoopWindowMinutes: number;
  usage: Record<BudgetResource, Usage>;
}

export function getWorkClassUsageSnapshot(at: number = Date.now()): WorkClassUsageSnapshot {
  rollover(at);
  return {
    day: dayKey,
    missionReservePct: missionReservePct(),
    internalLoopMaxPct: internalLoopMaxPct(),
    internalLoopRepeatMax: internalLoopRepeatMax(),
    internalLoopWindowMinutes: internalLoopWindowMinutes(),
    usage: Object.fromEntries(RESOURCES.map((r) => [r, { ...usage[r] }])) as Record<BudgetResource, Usage>,
  };
}

/** Test seam. */
export function __resetWorkClassBudgetForTest(): void {
  dayKey = '';
  usage = { requests: emptyUsage(), tokens: emptyUsage(), spend_micros: emptyUsage() };
  internalRuns.clear();
  countedTasks.clear();
}
