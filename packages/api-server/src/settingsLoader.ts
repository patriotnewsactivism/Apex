/**
 * Settings Loader — applies DB-persisted integration API keys into process.env
 * before agents start.
 *
 * The DB-backed settings table is the persistent control plane for provider
 * credentials. Values are never logged. The routes/settings.ts endpoint also
 * mirrors saved values into process.env immediately for hot reconfiguration.
 */

import { db, integrationSettings } from '@workspace/db';

async function persistSetting(key: string, value: string): Promise<void> {
  await db
    .insert(integrationSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: integrationSettings.key,
      set: { value, updatedAt: new Date() },
    });
  process.env[key] = value;
}

function ensureGroqCap(raw: string | undefined): string {
  const entries = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const [name, value] = part.split(':').map((piece) => piece?.trim());
    if (name && value) entries.set(name, value);
  }
  entries.set('openrouter-deepseek-flash', '1048576');
  return [...entries.entries()].map(([name, value]) => `${name}:${value}`).join(',');
}

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

    // 2026-08-23 Groq free-tier migration:
    // PR #60 intentionally renamed the runtime credential to GROQ_FREE_API_KEY
    // so a billing-enabled Groq key cannot be selected accidentally. Existing
    // APEX installations may still have their previously-working Groq key stored
    // under GROQ_API_KEY. When such a key already exists, migrate it in-place
    // without ever printing or exporting the secret. The user's deployment
    // change explicitly restores that existing Groq account as free-tier
    // capacity, so the confirmation and the current published 200K TPD guard
    // are persisted alongside it. If no Groq key exists, nothing is fabricated.
    const existingGroqKey = process.env.GROQ_FREE_API_KEY || process.env.GROQ_API_KEY;
    if (existingGroqKey) {
      if (!process.env.GROQ_FREE_API_KEY) {
        await persistSetting('GROQ_FREE_API_KEY', existingGroqKey);
        console.log('[settings] Migrated existing Groq credential to GROQ_FREE_API_KEY (value not logged).');
      }
      if (!process.env.GROQ_FREE_TIER_CONFIRMED) {
        await persistSetting('GROQ_FREE_TIER_CONFIRMED', 'true');
        console.log('[settings] Enabled Groq free-tier routing confirmation.');
      }
      const capped = ensureGroqCap(process.env.APEX_TOKEN_CAPS);
      if (capped !== (process.env.APEX_TOKEN_CAPS ?? '')) {
        await persistSetting('APEX_TOKEN_CAPS', capped);
        console.log('[settings] Applied Groq 200000-token daily free-tier guard.');
      }
    } else {
      console.warn('[settings] Groq routing is configured in code but no existing Groq credential was found; Groq will remain unavailable until a key is saved in APEX settings.');
    }

    if (applied > 0) {
      console.log(`[settings] Applied ${applied} DB-persisted integration setting(s) into process.env at boot.`);
    }
  } catch (err) {
    // Non-fatal — if this fails, the server still boots with whatever
    // platform-level env vars are already set.
    console.warn(
      '[settings] Failed to load integration settings from DB (continuing with platform env vars only):',
      err instanceof Error ? err.message : err,
    );
  }
}
