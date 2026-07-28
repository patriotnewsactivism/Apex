import { Router } from 'express';
import { db, integrationSettings } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { getKnownApiKeyEnvs } from '@workspace/core';
import { CronParser } from '@workspace/background-jobs';

/**
 * Integration Settings API — real server-side persistence for the
 * dashboard's "Save" button, replacing the previous localStorage-only
 * no-op (see settingsLoader.ts for the full context).
 *
 * Security posture:
 *  - Mounted under /api, which is entirely behind requireAdminAuth
 *    (see index.ts) — same trust boundary as every other admin route.
 *  - The `key` a client can set/clear is strictly allowlisted against
 *    getKnownApiKeyEnvs() (the real provider env var names llm-client.ts
 *    reads) — a request can never set an arbitrary environment variable.
 *  - GET never returns the plaintext value, only configured:boolean —
 *    consistent with secrets-hygiene: reference by name, never echo value.
 */
export function createSettingsRouter(): Router {
  const router = Router();

  // GET /api/settings/integrations — status only, never the actual value.
  // "configured" is true whether the source is this DB table OR a
  // platform-level (Railway) env var — process.env is the single source
  // of truth once loadSettingsIntoEnv() has run at boot.
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
      const knownKeys = getKnownApiKeyEnvs();
      if (!knownKeys.includes(key)) {
        res.status(400).json({ error: `Unknown integration key '${key}' — must be one of: ${knownKeys.join(', ')}` });
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

      res.json({ ok: true, key, configured: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/settings/integrations/:key — clears the DB override only.
  // If the same var is ALSO set as a real platform-level env var on
  // Railway, this cannot remove that — only the DB-sourced override.
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
