/**
 * Settings Loader — applies DB-persisted integration settings into process.env
 * before agents start. Values are never logged.
 */

import { db, integrationSettings } from '@workspace/db';

export async function loadSettingsIntoEnv(): Promise<void> {
  try {
    const rows = await db.select().from(integrationSettings);
    const platformResearchConcurrency = process.env.APEX_LEAD_RESEARCH_CONCURRENCY?.trim();
    let applied = 0;
    for (const row of rows) {
      // The platform setting is an emergency capacity ceiling. A stale
      // dashboard value must not override the operator's explicit limit.
      if (row.key === 'APEX_LEAD_RESEARCH_CONCURRENCY' && platformResearchConcurrency) continue;
      if (row.value) {
        process.env[row.key] = row.value;
        applied++;
      }
    }

    if (applied > 0) {
      console.log(`[settings] Applied ${applied} DB-persisted integration setting(s) into process.env at boot.`);
    }
  } catch (err) {
    console.warn(
      '[settings] Failed to load integration settings from DB (continuing with platform env vars only):',
      err instanceof Error ? err.message : err,
    );
  }
}
