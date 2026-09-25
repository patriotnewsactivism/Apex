import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import express from 'express';
import type { BuildInfo } from '@workspace/core';
import {
  collectSensitiveHealthKeys,
  registerHealthDetailRoute,
  sendPublicHealth,
  toPublicHealthBody,
} from '../public-health.js';

if (!process.env.APEX_ADMIN_TOKEN?.trim()) {
  process.env.APEX_ADMIN_TOKEN = 'public-health-test-token';
}

const build: BuildInfo = {
  sha: 'abc123def456',
  builtAt: '2026-09-25T00:00:00.000Z',
  startedAt: '2026-09-25T00:01:00.000Z',
  uptimeSeconds: 12,
};

const sensitiveDetail = {
  status: 'ok' as const,
  build,
  agents: 13,
  agentStatusCounts: { idle: 13 },
  taskQueue: { verdict: 'ok', consecutiveFailures: 0 },
  llmCapacity: { state: 'available', pausedProviders: [], workforceParkedUntil: null },
  providerCredits: {
    uniqueAccounts: 2,
    loadedKeys: 3,
    sharedQuota: true,
    accounts: [{ env: 'OPENROUTER_API_KEY', account: 'oracct_deadbeef', remaining: 12.5, totalCredits: 20, totalUsage: 7.5 }],
  },
  llmSpend: { spentUsd: 1.25 },
  embeddings: { ready: true },
  llmRequests: {
    cap: 2000,
    configuredCap: 2900,
    emergencyCap: 4500,
    accounts: [{ openRouterAccount: 'oracct_deadbeef', requests: 10, cap: 1000 }],
  },
  workforce: { alive: 13 },
  workerHeartbeats: { workers: [{ workerId: 'worker-1' }] },
  autonomy: { tasksSoftYielded: 0 },
  websocketTickets: { active: 0 },
  memory: { rssMb: 100 },
};

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
    server.on('error', reject);
  });
}

describe('public /health', () => {
  it('returns only status and build identity', () => {
    const body = toPublicHealthBody({ broken: false, build });
    expect(body).toEqual({
      status: 'ok',
      build: {
        sha: 'abc123def456',
        version: 'abc123def456',
        builtAt: build.builtAt,
        startedAt: build.startedAt,
        uptimeSeconds: 12,
      },
    });
    expect(Object.keys(body).sort()).toEqual(['build', 'status']);
    expect(collectSensitiveHealthKeys(body).size).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/oracct_|OPENROUTER_|worker-1|spentUsd|workforceParkedUntil/);
  });

  it('keeps a broken task queue degraded without adding operational fields', () => {
    const body = toPublicHealthBody({ broken: true, build });
    expect(body.status).toBe('degraded');
    expect(collectSensitiveHealthKeys(body).size).toBe(0);
    expect(collectSensitiveHealthKeys(sensitiveDetail).size).toBeGreaterThan(0);
  });

  it('answers 200 when ready and 503 when the queue is broken', async () => {
    const app = express();
    let broken = false;
    app.get('/health', (_req, res) => {
      sendPublicHealth(res, { broken, build });
    });
    const server = await listen(app);
    try {
      const ok = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(ok.status).toBe(200);
      expect(collectSensitiveHealthKeys(await ok.json()).size).toBe(0);

      broken = true;
      const degraded = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(degraded.status).toBe(503);
      const payload = await degraded.json() as { status: string };
      expect(payload.status).toBe('degraded');
      expect(collectSensitiveHealthKeys(payload).size).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('serves the operational snapshot only behind admin auth', async () => {
    if (!process.env.APEX_ADMIN_TOKEN?.trim()) {
      process.env.APEX_ADMIN_TOKEN = 'public-health-test-token';
    }
    const token = process.env.APEX_ADMIN_TOKEN;
    const { requireAdminAuth } = await import('../middleware/auth.js');

    const app = express();
    app.get('/health', (_req, res) => {
      sendPublicHealth(res, { broken: false, build });
    });
    app.use('/api', requireAdminAuth);
    const router = express.Router();
    registerHealthDetailRoute(router, async () => sensitiveDetail);
    app.use('/api/health', router);

    const server = await listen(app);
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/api/health/detail`);
      expect(missing.status).toBe(401);
      expect(collectSensitiveHealthKeys(await missing.json()).size).toBe(0);

      const wrong = await fetch(`http://127.0.0.1:${server.port}/api/health/detail`, {
        headers: { Authorization: 'Bearer not-the-admin-token' },
      });
      expect(wrong.status).toBe(401);

      const authed = await fetch(`http://127.0.0.1:${server.port}/api/health/detail`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(authed.status).toBe(200);
      const body = await authed.json() as typeof sensitiveDetail;
      expect(body.llmRequests.accounts[0]?.openRouterAccount).toBe('oracct_deadbeef');
      expect(body.workerHeartbeats.workers[0]?.workerId).toBe('worker-1');
      expect(body.providerCredits.accounts[0]?.env).toBe('OPENROUTER_API_KEY');
    } finally {
      await server.close();
    }
  });

  it('returns 503 from the detail route when the snapshot is degraded', async () => {
    if (!process.env.APEX_ADMIN_TOKEN?.trim()) {
      process.env.APEX_ADMIN_TOKEN = 'public-health-test-token';
    }
    const token = process.env.APEX_ADMIN_TOKEN;
    const { requireAdminAuth } = await import('../middleware/auth.js');
    const app = express();
    app.use('/api', requireAdminAuth);
    const router = express.Router();
    registerHealthDetailRoute(router, async () => ({ ...sensitiveDetail, status: 'degraded' }));
    app.use('/api/health', router);
    const server = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health/detail`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(503);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('degraded');
    } finally {
      await server.close();
    }
  });

  it('wires the production public probe and the authenticated detail route', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const healthRoute = readFileSync(new URL('../routes/health.ts', import.meta.url), 'utf8');
    expect(index).toMatch(
      /app\.get\('\/health', \(_req, res\) => \{\s*sendPublicHealth\(res, \{ broken: isTaskQueueBroken\(\), build: getBuildInfo\(\) \}\);\s*\}\);/,
    );
    const authAt = index.indexOf("app.use('/api', requireAdminAuth)");
    const mountAt = index.indexOf('createHealthRouter(healthMonitor, alertManager, () => buildRuntimeHealthDetail())');
    expect(authAt).toBeGreaterThan(0);
    expect(mountAt).toBeGreaterThan(authAt);
    expect(healthRoute).toContain('registerHealthDetailRoute(router, runtimeDetail)');
    expect(index).toContain('runtimeHealthDetail: () => buildRuntimeHealthDetail()');
  });
});
