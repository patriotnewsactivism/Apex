/**
 * Opt-in real Postgres test for cooldown persistence. Only a disposable local
 * test database is accepted. No provider or production credentials are used.
 *
 * The source-pattern guard (verify-cooldown-persistence.ts) proves the code
 * SHAPE. This proves the BEHAVIOUR the analyst asked for: trigger a cooldown,
 * confirm its database record, simulate a worker restart (clear the in-memory
 * maps), re-hydrate, and confirm the still-valid cooldown is restored while an
 * expired one is not.
 */
import assert from 'node:assert/strict';

const target = process.env.APEX_COOLDOWN_TEST_DATABASE_URL;
if (!target) throw new Error('Set APEX_COOLDOWN_TEST_DATABASE_URL to a disposable local test database');
const url = new URL(target);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.startsWith('/cooldown_test')) {
  throw new Error('Refusing a non-local or non-test database');
}
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';

async function main(): Promise<void> {
  const { db, migrate, integrationSettings } = await import('../lib/db/src/index.js');
  const { eq } = await import('../lib/db/node_modules/drizzle-orm/index.js');
  const llm = await import('../packages/core/src/llm-client.js');
  await migrate();

  const provider = 'groq-gpt-oss-120b-byok' as const;
  const liveCredential = 'groq-gpt-oss-120b-byok:GROQ_API_KEY';
  const expiredCredential = 'gemini-3-8-flash-byok:GEMINI_API_KEY';
  const now = Date.now();
  const providerUntil = now + 10 * 60 * 1000;
  const liveCredentialUntil = now + 5 * 60 * 1000;
  const expiredUntil = now - 60 * 1000;

  // 1. Trigger a controlled cooldown and persist it.
  llm.__testSeedProviderCooldown(provider, providerUntil);
  llm.__testSeedCredentialCooldown(liveCredential, {
    until: liveCredentialUntil,
    capacityPause: true,
    reason: 'test 429',
  });
  llm.__testSeedCredentialCooldown(expiredCredential, {
    until: expiredUntil,
    capacityPause: false,
    reason: 'test expired',
  });
  await llm.__testFlushCooldowns();

  // 2. Confirm the database record — and that the expired entry was NOT written.
  const [row] = await db
    .select()
    .from(integrationSettings)
    .where(eq(integrationSettings.key, llm.__testCooldownSettingsKey))
    .limit(1);
  assert.ok(row, 'the cooldown row is written to integration_settings');
  const stored = JSON.parse(row.value) as {
    providers?: Array<[string, number]>;
    credentials?: Array<[string, { until: number }]>;
  };
  assert.ok(
    (stored.providers ?? []).some(([name, until]) => name === provider && until === providerUntil),
    'the live provider cooldown is in the persisted payload',
  );
  assert.ok(
    (stored.credentials ?? []).some(([id, cooldown]) => id === liveCredential && cooldown.until === liveCredentialUntil),
    'the live credential cooldown is in the persisted payload',
  );
  assert.ok(
    !(stored.credentials ?? []).some(([id]) => id === expiredCredential),
    'an expired cooldown is not persisted',
  );

  // 3. Simulate a worker restart: drop all in-memory state, then boot-hydrate.
  llm.__testClearCooldownMaps();
  assert.equal(llm.__testGetProviderCooldown(provider), undefined, 'in-memory state is gone before hydrate');
  const hydrated = await llm.initializeProviderCooldowns();
  assert.equal(hydrated, true, 'hydration reports success');

  // 4. The still-valid cooldowns are back; the expired one stays absent.
  assert.equal(
    llm.__testGetProviderCooldown(provider),
    providerUntil,
    'the provider cooldown survived the simulated restart',
  );
  assert.equal(
    llm.__testGetCredentialCooldown(liveCredential)?.until,
    liveCredentialUntil,
    'the credential cooldown survived the simulated restart',
  );
  assert.equal(
    llm.__testGetCredentialCooldown(expiredCredential),
    undefined,
    'an expired cooldown is not restored',
  );

  // 5. A provider under a live cooldown is reported unavailable until it expires.
  const readyAt = llm.__testGetProviderCooldown(provider)!;
  assert.ok(readyAt > Date.now(), 'the cooldown is in the future, so the provider is still resting');

  await db.delete(integrationSettings).where(eq(integrationSettings.key, llm.__testCooldownSettingsKey));
  console.log('✅ Cooldown persistence survives a simulated restart: written, restored while live, expired entries dropped.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
