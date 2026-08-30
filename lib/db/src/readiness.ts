import { db } from './client.js';
import { agents, approvals, scheduledJobs, tasks } from './schema.js';

export type DurableDatabaseReadiness = {
  ready: boolean;
  checkedAt: string;
  latencyMs: number;
  databaseUrlConfigured: boolean;
  reason: string | null;
};

export type DatabaseReadinessOptions = {
  /** Production runtime must never treat the local development fallback as authoritative. */
  requireConfiguredUrl?: boolean;
  timeoutMs?: number;
};

const DEFAULT_READINESS_TIMEOUT_MS = 10_000;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function authoritativeSchemaProbe(): Promise<void> {
  // These tables cover the core durable execution loop: workforce identity,
  // task claiming, human side-effect gates, and autonomous scheduling. A bare
  // SELECT 1 would prove only that Postgres answered, not that the APEX durable
  // state required by the runtime is actually present.
  await Promise.all([
    db.select({ id: agents.id }).from(agents).limit(1),
    db.select({ id: tasks.id }).from(tasks).limit(1),
    db.select({ id: approvals.id }).from(approvals).limit(1),
    db.select({ id: scheduledJobs.id }).from(scheduledJobs).limit(1),
  ]);
}

export async function probeDurableDatabaseReadiness(
  options: DatabaseReadinessOptions = {},
): Promise<DurableDatabaseReadiness> {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const databaseUrlConfigured = Boolean(process.env.DATABASE_URL?.trim());
  const requireConfiguredUrl = options.requireConfiguredUrl ?? process.env.NODE_ENV === 'production';
  const timeoutMs = Math.max(500, Math.min(30_000, options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS));

  if (requireConfiguredUrl && !databaseUrlConfigured) {
    return {
      ready: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      databaseUrlConfigured,
      reason: 'DATABASE_URL is not configured for the production runtime',
    };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      authoritativeSchemaProbe(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`database readiness probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
    return {
      ready: true,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      databaseUrlConfigured,
      reason: null,
    };
  } catch (error) {
    return {
      ready: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      databaseUrlConfigured,
      reason: detail(error).slice(0, 500),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function assertDurableDatabaseReady(
  options: DatabaseReadinessOptions = {},
): Promise<DurableDatabaseReadiness> {
  const readiness = await probeDurableDatabaseReadiness(options);
  if (!readiness.ready) {
    throw new Error(`Durable database readiness check failed: ${readiness.reason ?? 'unknown database failure'}`);
  }
  return readiness;
}
