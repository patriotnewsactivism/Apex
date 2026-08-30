/**
 * Settings Loader — applies DB-persisted integration settings into process.env
 * before agents start. Values are never logged.
 */

import { assertDurableDatabaseReady, db, integrationSettings } from '@workspace/db';

function stripLegacyFreeTierCaps(raw: string | undefined): string {
  const entries = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const [name, value] = part.split(':').map((piece) => piece?.trim());
    if (name && value) entries.set(name, value);
  }

  for (const legacy of ['groq', 'google-gemini', 'cohere', 'poolside', 'qwen', 'kilo', 'mistral']) {
    entries.delete(legacy);
  }

  // This exact cap was injected by the temporary OpenRouter migration. Remove
  // it so production is not artificially parked after ~1M tokens/day. A
  // deliberately configured different OpenRouter cap is preserved.
  if (entries.get('openrouter-deepseek-flash') === '1048576') {
    entries.delete('openrouter-deepseek-flash');
  }

  return [...entries.entries()].map(([name, value]) => `${name}:${value}`).join(',');
}

export async function loadSettingsIntoEnv(): Promise<void> {
  // This function is awaited before workforce construction. Treat it as the
  // HTTP control-plane durable-state gate rather than silently falling back to
  // platform env vars when Postgres is missing. A listener that cannot reach
  // authoritative tasks/approvals/schedules is not a healthy APEX runtime.
  await assertDurableDatabaseReady({ requireConfiguredUrl: process.env.NODE_ENV === 'production' });

  const rows = await db.select().from(integrationSettings);
  let applied = 0;
  for (const row of rows) {
    if (row.value) {
      process.env[row.key] = row.value;
      applied++;
    }
  }

  const currentCaps = process.env.APEX_TOKEN_CAPS ?? '';
  const normalizedCaps = stripLegacyFreeTierCaps(currentCaps);
  if (normalizedCaps !== currentCaps) {
    process.env.APEX_TOKEN_CAPS = normalizedCaps;
    console.log('[settings] Ignored legacy free-tier token caps for the OpenRouter production runtime.');
  }

  if (applied > 0) {
    console.log(`[settings] Applied ${applied} DB-persisted integration setting(s) into process.env at boot.`);
  }
}
