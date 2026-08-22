import { Router } from 'express';
import { db, integrationSettings } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  getIntegrationCatalog,
  getKnownApiKeyEnvs,
  findIntegrationByKey,
  probeIntegrationKey,
  isRecoverableLLMProviderFailure,
} from '@workspace/core';
import type { BaseAgent } from '@workspace/core';
import { CronParser } from '@workspace/background-jobs';

/**
 * Integration Settings API — real server-side persistence for the
 * dashboard's "Save" button (see settingsLoader.ts for the full context).
 *
 * Target state (post single-catalog refactor): the server no longer keeps its
 * own allowlist. The catalog in @workspace/core/integration-catalog.ts is the
 * single source of truth — the Settings screen fetches it, and this route
 * derives its allowlist from it via getKnownApiKeyEnvs().
 *
 * Security posture:
 *  - Mounted under /api, which is entirely behind requireAdminAuth
 *    (see index.ts) — same trust boundary as every other admin route.
 *  - The `key` a client can set/clear is strictly allowlisted against the
 *    catalog's active entries (the real env var names the runtime reads).
 *  - GET never returns the plaintext value, only configured:boolean.
 *  - Saving a key returns a real provider probe (Connected / Rate Limited /
 *    Invalid Key / Billing Required) instead of merely "configured".
 */
export function createSettingsRouter(workforce: Map<string, BaseAgent>): Router {
  const router = Router();

  // GET /api/settings/integrations/catalog — the full single-source-of-truth
  // catalog, with `configured` computed live per env var. Disabled entries
  // are included so the UI can grey them out rather than silently dropping
  // or misrepresenting them.
  router.get('/integrations/catalog', async (_req, res) => {
    try {
      const catalog = getIntegrationCatalog().map((integration) => ({
        ...integration,
        envVars: integration.envVars.map((v) => ({
          ...v,
          configured: Boolean(process.env[v.key]),
        })),
      }));
      res.json({ catalog });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/settings/integrations — status only, never the actual value.
  // Retained for backward compatibility; the dashboard now uses /catalog.
  router.get('/integrations', async (_req, res) => {
    try {
      const knownKeys = getKnownApiKeyEnvs();
      const status = knownKeys.map((key) => ({ key, configured: Boolean(process.env[key]) }));
      res.json({ integrations: status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/settings/integrations  { key, value }
  router.post('/integrations', async (req, res) => {
    try {
      const { key, value } = req.body ?? {};
      if (typeof key !== 'string' || typeof value !== 'string' || !value.trim()) {
        res.status(400).json({ error: 'key and non-empty value are required' });
        return;
      }

      const match = findIntegrationByKey(key);
      if (!match) {
        const knownKeys = getKnownApiKeyEnvs();
        res.status(400).json({
          error: `Unknown integration key '${key}' — not part of the APEX integration catalog.`,
          knownKeys,
        });
        return;
      }
      if (match.integration.state !== 'active') {
        res.status(400).json({
          error: `'${key}' belongs to "${match.integration.name}", which is not wired into the APEX runtime. ${match.integration.stateReason ?? ''}`.trim(),
        });
        return;
      }

      await db
        .insert(integrationSettings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: integrationSettings.key,
          set: { value, updatedAt: new Date() },
        });

      // Apply immediately so the currently-running process picks it up
      // without waiting for a restart/redeploy.
      process.env[key] = value;

      // Probe the provider now that the key is live, so the UI can show the
      // real result (Connected / Rate Limited / Invalid Key / Billing
      // Required) rather than merely "configured".
      const probe = await probeIntegrationKey(match.integration, key, value);

      res.json({ ok: true, key, configured: true, probe });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/settings/integrations/:key — clears the DB override only.
  // If the same var is ALSO set as a real platform-level env var, this cannot
  // remove that — only the DB-sourced override.
  router.delete('/integrations/:key', async (req, res) => {
    try {
      const { key } = req.params;
      const knownKeys = getKnownApiKeyEnvs();
      if (!knownKeys.includes(key)) {
        res.status(400).json({ error: `Unknown integration key '${key}'` });
        return;
      }
      await db.delete(integrationSettings).where(eq(integrationSettings.key, key));
      delete process.env[key];
      res.json({ ok: true, key, configured: false });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/settings/recover-workforce — operator-triggered recovery after
  // LLM capacity is restored. Requeues tasks that died on "All LLM providers
  // failed" and resets agents stuck in the error state.
  router.post('/recover-workforce', async (_req, res) => {
    try {
      const { tasks } = await import('@workspace/db');

      const failed = await db
        .select({ id: tasks.id, errorMessage: tasks.errorMessage })
        .from(tasks)
        .where(eq(tasks.status, 'failed'));

      const recoverable = failed.filter((t) => isRecoverableLLMProviderFailure(t.errorMessage));
      let requeued = 0;
      for (const task of recoverable) {
        await db
          .update(tasks)
          .set({
            status: 'pending',
            retryCount: 0,
            errorMessage: null,
            nextRetryAt: null,
            leasedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));
        requeued++;
      }

      // Reset agents stuck in the error state — both the DB row and the live
      // instance (so the red ERROR clears and the loop picks work back up).
      const { agents } = await import('@workspace/db');
      const errored = await db.select({ id: agents.id }).from(agents).where(eq(agents.status, 'error'));
      let resetAgents = 0;
      for (const agent of errored) {
        await db
          .update(agents)
          .set({ status: 'idle', lastActiveAt: new Date() })
          .where(eq(agents.id, agent.id));
        const live = workforce.get(agent.id);
        if (live) live.recover();
        resetAgents++;
      }

      res.json({ ok: true, requeuedTasks: requeued, resetAgents });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── System Settings (autonomy, behavior dials) ──────────────────────────
  // Stored in integration_settings with 'system:' prefix — no schema change
  // needed (key is a text column, value is text). Applied at runtime for
  // immediate effect.

  const SYSTEM_KEYS = ['system:autonomy_level'] as const;
  const AUTONOMY_PRESETS: Record<string, { cron: string; label: string }> = {
    conservative: { cron: '*/30 * * * *', label: 'Conservative — goal review every 30 min, lower throughput' },
    balanced: { cron: '*/15 * * * *', label: 'Balanced — goal review every 15 min (default)' },
    aggressive: { cron: '*/10 * * * *', label: 'Aggressive — goal review every 10 min, max throughput' },
  };

  // GET /api/settings/system — current system-level settings
  router.get('/system', async (_req, res) => {
    try {
      const rows = await db.select().from(integrationSettings);
      const systemRows = rows.filter((r) => r.key.startsWith('system:'));
      const settings: Record<string, string> = {};
      for (const r of systemRows) {
        settings[r.key.replace('system:', '')] = r.value;
      }
      // Apply env overrides (e.g., APEX_APPROVAL_MODE) if not in DB
      if (!settings.autonomy_level) {
        settings.autonomy_level = process.env.APEX_APPROVAL_MODE === 'normal' ? 'balanced' : 'balanced';
      }
      res.json({ settings });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /api/settings/system — update system-level settings
  router.put('/system', async (req, res) => {
    try {
      const { autonomy_level } = req.body ?? {};
      const updates: Array<{ key: string; value: string }> = [];

      if (autonomy_level && AUTONOMY_PRESETS[autonomy_level]) {
        updates.push({ key: 'system:autonomy_level', value: autonomy_level });

        // Adjust the goal review cron frequency to match the autonomy level
        const newCron = AUTONOMY_PRESETS[autonomy_level].cron;
        const { scheduledJobs } = await import('@workspace/db');
        const [reviewJob] = await db.select().from(scheduledJobs)
          .where(eq(scheduledJobs.id, 'system-ceo-goal-review')).limit(1);
        if (reviewJob) {
          const nextRunAt = CronParser.nextRun(newCron, new Date()) ?? new Date(Date.now() + 60_000);
          await db.update(scheduledJobs).set({
            cronExpression: newCron,
            nextRunAt,
            status: 'active',
            retryCount: 0,
          }).where(eq(scheduledJobs.id, 'system-ceo-goal-review'));
        }
      }

      for (const { key, value } of updates) {
        await db.insert(integrationSettings)
          .values({ key, value, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: integrationSettings.key,
            set: { value, updatedAt: new Date() },
          });
      }

      res.json({ ok: true, updated: updates });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}