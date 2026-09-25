import type { Response } from 'express';
import type { BuildInfo } from '@workspace/core';

/**
 * Unauthenticated GET /health. Railway healthchecks this path and only needs
 * a real readiness status plus the running commit. Account identity, env
 * names, balances, spend, caps, and worker ids belong on GET /api/health/detail.
 */
export interface PublicHealthBody {
  status: 'ok' | 'degraded';
  build: {
    sha: string;
    /** Commit identity of this process. Same value as `sha`. */
    version: string;
    builtAt: string | null;
    startedAt: string;
    uptimeSeconds: number;
  };
}

/** Keys that must never appear anywhere in the public JSON body. */
export const SENSITIVE_HEALTH_KEYS = [
  'agents',
  'agentStatusCounts',
  'taskQueue',
  'llmCapacity',
  'providerCredits',
  'llmSpend',
  'embeddings',
  'llmRequests',
  'workforce',
  'workerHeartbeats',
  'autonomy',
  'websocketTickets',
  'memory',
  'accounts',
  'openRouterAccount',
  'pausedProviders',
  'workforceParkedUntil',
  'workerId',
  'workers',
  'spentUsd',
  'cap',
  'configuredCap',
  'emergencyCap',
  'env',
  'remaining',
  'totalCredits',
  'totalUsage',
  'uniqueAccounts',
  'loadedKeys',
  'sharedQuota',
] as const;

export function toPublicHealthBody(input: { broken: boolean; build: BuildInfo }): PublicHealthBody {
  return {
    status: input.broken ? 'degraded' : 'ok',
    build: {
      sha: input.build.sha,
      version: input.build.sha,
      builtAt: input.build.builtAt,
      startedAt: input.build.startedAt,
      uptimeSeconds: input.build.uptimeSeconds,
    },
  };
}

export function publicHealthHttpStatus(broken: boolean): 200 | 503 {
  return broken ? 503 : 200;
}

export function sendPublicHealth(
  res: Response,
  input: { broken: boolean; build: BuildInfo },
): void {
  res.status(publicHealthHttpStatus(input.broken)).json(toPublicHealthBody(input));
}

export function collectSensitiveHealthKeys(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveHealthKeys(item, found);
    return found;
  }
  const forbidden = new Set<string>(SENSITIVE_HEALTH_KEYS);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key)) found.add(key);
    collectSensitiveHealthKeys(child, found);
  }
  return found;
}

type DetailRouter = {
  get: (path: string, handler: (req: unknown, res: Response) => Promise<void> | void) => void;
};

/** Same operational snapshot the public route used to return. Caller must mount
 * the router behind requireAdminAuth. */
export function registerHealthDetailRoute(
  router: DetailRouter,
  detail: () => Promise<unknown>,
): void {
  router.get('/detail', async (_req, res) => {
    try {
      const body = await detail();
      const broken =
        Boolean(body) &&
        typeof body === 'object' &&
        (body as { status?: unknown }).status === 'degraded';
      res.status(broken ? 503 : 200).json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
