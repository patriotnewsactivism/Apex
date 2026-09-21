import { createHash } from 'node:crypto';
import type { Task } from '@workspace/db';

export const MAX_BUNDLE_ITEMS = 20;
export const MAX_BUNDLE_CHARS = 12_000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function bundleWindowMs(): number {
  const raw = Number(process.env.APEX_BUNDLE_WINDOW_MS ?? 10_000);
  return Number.isFinite(raw) ? Math.max(0, Math.min(60_000, Math.floor(raw))) : 10_000;
}

export interface WorkBundle {
  version: 1;
  scope: string;
  closesAt: string;
  itemIds: string[];
}

/** Explicit opt-in only. Exact context equality includes project, campaign,
 * role-specific instructions and permissions; goal/parent/creator also match.
 * One returned task ID owns the entire bundle, including approval/checkpoint
 * state. Existing independently queued tasks are never merged or terminalized. */
export function prepareWorkBundle(task: Task, now = Date.now()): Task {
  const context = task.context ?? {};
  // Never accept caller-supplied internal bundle bookkeeping.
  const { workBundle: _discard, bundleKey, ...rest } = context;
  const clean = { ...task, context: rest };
  const window = bundleWindowMs();
  if (process.env.APEX_WORK_BUNDLES_ENABLED !== 'true' || window === 0 ||
      typeof bundleKey !== 'string' || !bundleKey.trim() || bundleKey.length > 128 ||
      task.priority <= 2 || rest.interactive === true || rest.urgent === true ||
      rest.runtime === 'job' || rest.checkpoint || rest.deterministicRead ||
      task.description.length + task.title.length > MAX_BUNDLE_CHARS - 100) return clean;
  const scope = createHash('sha256').update(JSON.stringify(canonical({
    key: bundleKey, context: rest, agent: task.assignedAgentId,
    creator: task.createdByAgentId, goal: task.goalId, parent: task.parentTaskId,
    priority: task.priority,
  }))).digest('hex');
  const closesAt = new Date(now + window).toISOString();
  const workBundle: WorkBundle = { version: 1, scope, closesAt, itemIds: [task.id] };
  return {
    ...clean,
    description: `Work item ${task.id}: ${task.title}\n${task.description}`,
    context: { ...rest, workBundle },
    nextRetryAt: new Date(closesAt),
  };
}

export function readWorkBundle(context: Record<string, unknown> | null): WorkBundle | null {
  const raw = context?.workBundle as Partial<WorkBundle> | undefined;
  if (!raw || raw.version !== 1 || typeof raw.scope !== 'string' ||
      typeof raw.closesAt !== 'string' || !Number.isFinite(Date.parse(raw.closesAt)) ||
      !Array.isArray(raw.itemIds) || raw.itemIds.length === 0 ||
      raw.itemIds.length > MAX_BUNDLE_ITEMS || !raw.itemIds.every(id => typeof id === 'string')) return null;
  return raw as WorkBundle;
}

export function appendWorkBundle(existing: Task, incoming: Task, now = Date.now()): Task | null {
  const current = readWorkBundle(existing.context);
  const next = readWorkBundle(incoming.context);
  if (!current || !next || current.scope !== next.scope || existing.status !== 'pending' ||
      existing.startedAt || existing.retryCount !== 0 || existing.context?.checkpoint ||
      Date.parse(current.closesAt) <= now || current.itemIds.length >= MAX_BUNDLE_ITEMS) return null;
  const description = `${existing.description}\n\n${incoming.description}`;
  if (description.length > MAX_BUNDLE_CHARS) return null;
  return {
    ...existing, description, updatedAt: new Date(now),
    context: { ...existing.context, workBundle: { ...current, itemIds: [...current.itemIds, incoming.id] } },
  };
}

// Deliberately process-scoped: durable billing remains in request-ledger. These
// counters reset on restart/UTC rollover and never claim estimated requests saved.
const startedAt = new Date().toISOString();
let day = startedAt.slice(0, 10);
const counts = { requests: 0, successfulTools: 0, failedTools: 0, bundlesCreated: 0,
  itemsCoalesced: 0, deterministicTasks: 0, completedTasks: 0 };
export function recordTurnEconomy(kind: keyof typeof counts): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
    day = today;
  }
  counts[kind]++;
}
export function getTurnEconomySnapshot() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
    day = today;
  }
  return { scope: 'process' as const, since: startedAt > `${day}T00:00:00.000Z` ? startedAt : `${day}T00:00:00.000Z`,
    ...counts, successfulToolsPerRequest: counts.requests ? counts.successfulTools / counts.requests : null,
    requestsPerCompletedTask: counts.completedTasks ? counts.requests / counts.completedTasks : null,
    bundlingEnabled: process.env.APEX_WORK_BUNDLES_ENABLED === 'true', bundleWindowMs: bundleWindowMs() };
}

export function missingBundleItems(context: Record<string, unknown>, output: string): string[] {
  return readWorkBundle(context)?.itemIds.filter(id => !output.includes(id)) ?? [];
}

export function resolveDeterministicRead(
  context: Record<string, unknown>, allowedTools: readonly string[], approvalRequired = false,
): { tool: 'campaign_snapshot'; args: unknown } | null {
  if (context.deterministicRead === undefined) return null;
  const request = context.deterministicRead as { tool?: unknown; args?: unknown } | null;
  if (!request || request.tool !== 'campaign_snapshot' ||
      !allowedTools.includes('campaign_snapshot') || approvalRequired) {
    throw new Error('Unsupported or unauthorized deterministic read');
  }
  return { tool: 'campaign_snapshot', args: request.args ?? {} };
}
