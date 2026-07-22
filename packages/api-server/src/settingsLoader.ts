/**
 * Settings Loader — applies DB-persisted integration API keys into
 * process.env at boot.
 *
 * llm-client.ts reads provider API keys via a plain `process.env[envKey]`
 * lookup with zero knowledge of any database. Rather than threading a DB
 * dependency through the LLM client, this loader does the simplest safe
 * thing: at server boot, read every row from `integration_settings` and set
 * `process.env[row.key] = row.value` for each one BEFORE any agent/LLM
 * client code runs. From that point on, llm-client.ts's existing
 * `process.env[provider.apiKeyEnv]` reads just work — no core code changes
 * needed. The settings route (routes/settings.ts) does the same
 * `process.env[key] = value` assignment live on save, so a key set via the
 * dashboard takes effect immediately without waiting for a restart.
 *
 * Values already set as real Railway/platform-level env vars are left
 * alone if there's no DB override row for that key — the DB is additive,
 * never destructive to platform-level config.
 */

import { db, integrationSettings } from '@workspace/db';

export async function loadSettingsIntoEnv(): Promise<void> {
  try {
    const rows = await db.select().from(integrationSettings);
    let applied = 0;
    for (const row of rows) {
      if (row.value) {
        process.env[row.key] = row.value;
        applied++;
      }
    }
    if (applied > 0) {
      console.log(`[settings] Applied ${applied} DB-persisted integration key(s) into process.env at boot.`);
    }
  } catch (err) {
    // Non-fatal — if this fails, the server still boots with whatever
    // platform-level env vars are already set (same behavior as before
    // this loader existed).
    console.warn('[settings] Failed to load integration settings from DB (continuing with platform env vars only):', err instanceof Error ? err.message : err);
  }
}
