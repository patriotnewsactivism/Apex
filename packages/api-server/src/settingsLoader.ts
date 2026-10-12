/**
 * Settings Loader — applies DB-persisted integration settings into process.env
 * before agents start. Values are never logged.
 */

import { db, integrationSettings } from '@workspace/db';
import { resolveDirectoryProviderKey } from '@workspace/core';

// Railway/platform values are the operator's emergency safety boundary. A stale
// dashboard row must never re-enable paid providers or restore bursty
// concurrency after the operator deliberately tightened production.
//
// The QwenCloud BYOK credentials belong here too, and for the same reason: they
// are held on the platform. Without them a dashboard row saved months earlier
// (a key issued for a different Qwen host, an older model slug) silently
// replaced the platform credential at boot. The lane then answered every call
// with "Incorrect API key provided", the last metered route failed, and the
// whole workforce parked on "All LLM providers failed" while Railway's
// variables still looked correct — the app was reading values no operator
// could see in the dashboard. Credentials the operator sets on the platform
// are authoritative; a row for them must not win.
const PLATFORM_AUTHORITATIVE_KEYS = new Set([
  'APEX_PAID_FALLBACK_ENABLED',
  'APEX_QWEN_BYOK_ENABLED',
  'APEX_GROQ_BYOK_ENABLED',
  'APEX_GEMINI_BYOK_ENABLED',
  // QwenCloud BYOK routing target: key, host and model must move together.
  'QWEN_API_KEY',
  'QWEN_API_KEY_2',
  'QWEN_BASE_URL',
  'APEX_QWEN_BASE_URL',
  'QWEN_MODEL',
  'APEX_MAX_CONCURRENT_LLM_CALLS',
  'APEX_LEAD_RESEARCH_CONCURRENCY',
  'APEX_QWEN_REQUEST_CAP',
  'APEX_QWEN_REQUEST_RATE_PER_MIN',
  'APEX_QWEN_REQUEST_PACING_BURST',
  'APEX_REQUEST_CAP_TOTAL',
  'APEX_EMERGENCY_REQUEST_CAP_TOTAL',
  'APEX_REQUEST_RATE_PER_MIN',
  'APEX_REQUEST_PACING_BURST',
  'APEX_AUTONOMOUS_OPEN_TASK_CAP',
]);

export async function loadSettingsIntoEnv(): Promise<void> {
  try {
    const rows = await db.select().from(integrationSettings);
    const platformOverrides = new Set(
      [...PLATFORM_AUTHORITATIVE_KEYS].filter((key) => {
        const value = process.env[key];
        return typeof value === 'string' && value.trim().length > 0;
      }),
    );

    let applied = 0;
    let skippedPlatformOverrides = 0;
    for (const row of rows) {
      if (platformOverrides.has(row.key)) {
        skippedPlatformOverrides++;
        continue;
      }
      if (row.value) {
        process.env[row.key] = row.value;
        applied++;
      }
    }

    if (applied > 0) {
      console.log(`[settings] Applied ${applied} DB-persisted integration setting(s) into process.env at boot.`);
    }
    if (skippedPlatformOverrides > 0) {
      console.log(
        `[settings] Preserved ${skippedPlatformOverrides} platform safety override(s) over stale DB settings.`,
      );
    }
  } catch (err) {
    console.warn(
      '[settings] Failed to load integration settings from DB (continuing with platform env vars only):',
      err instanceof Error ? err.message : err,
    );
  }

  // Check the directory provider keys once, now that DB settings are in
  // process.env. A missing or malformed key logs one
  // "[lead-provider] <provider> disabled: …" line here and the provider is
  // skipped silently afterwards (lead-provider-keys.ts). Never logs a key.
  for (const provider of ['yelp', 'google'] as const) resolveDirectoryProviderKey(provider);
}
