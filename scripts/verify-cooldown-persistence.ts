/**
 * Guard: provider/credential cooldowns survive a container replacement.
 *
 * 2026-10-10: cooldowns lived only in memory, so every deploy wiped them and
 * the 13 agents immediately re-hammered providers that were still resting —
 * a deferral storm (three deploys, three reinit batches, zero completions).
 * They are now persisted to the `integration_settings` Postgres row
 * `apex.llm.cooldowns` and hydrated at boot.
 *
 * This asserts the four properties the fix must hold, from the source the
 * runtime actually runs:
 *   1. Write on cooldown — every cooldown set/clear schedules a persist.
 *   2. Restore before execution — the bootstrap hydrates cooldowns before the
 *      agent loops start requesting models.
 *   3. Respect expiration — only entries whose absolute `until` is still in the
 *      future are persisted and restored.
 *   4. Shared state — one Map per provider/credential, so concurrent agents
 *      share the cooldown instead of each firing its own failed request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${detail}`);
}

const client = fs.readFileSync(path.join(root, 'packages/core/src/llm-client.ts'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'packages/api-server/src/runtime-bootstrap.ts'), 'utf8');

console.log('Verifying provider/credential cooldown persistence...\n');

check(
  '1. cooldowns are written to Postgres on set and on clear',
  /scheduleCooldownsPersist\(\);\s*\n\}\s*\n\s*\n?function clearCredentialCooldown/.test(client) &&
    /function clearCredentialCooldown\(id: string\): void \{\s*\n\s*credentialCooldowns\.delete\(id\);\s*\n\s*scheduleCooldownsPersist\(\);/.test(client),
);
check(
  '1b. the provider-wide cooldown also schedules a persist',
  /providerCooldowns\.set\(\s*\n\s*provider\.name,[\s\S]{0,120}\);\s*\n\s*scheduleCooldownsPersist\(\);/.test(client),
);
check(
  '1c. the persist is debounced so a burst cannot cause a write storm',
  /let cooldownsPersistTimer[\s\S]{0,200}setTimeout\(\s*\(\) => \{[\s\S]{0,200}persistCooldowns\(\)[\s\S]{0,80}\}, 1_000\)/.test(client),
);

check(
  '2. the bootstrap hydrates cooldowns before the agent loops run',
  bootstrap.indexOf('initializeProviderCooldowns()') !== -1 &&
    // Compare against the CALL, not the import at the top of the file.
    bootstrap.indexOf('initializeProviderCooldowns()') < bootstrap.indexOf('superviseAgentLoop(agent'),
);
check(
  '2b. the hydration result is reported at boot',
  /durableCooldowns[\s\S]{0,160}hydrated from Postgres/.test(bootstrap),
);

check(
  '3. only unexpired cooldowns are persisted (absolute until > now)',
  /providers: \[\.\.\.providerCooldowns\.entries\(\)\]\.filter\(\(\[, until\]\) => until > now\)/.test(client) &&
    /credentials: \[\.\.\.credentialCooldowns\.entries\(\)\]\.filter\(\(\[, cooldown\]\) => cooldown\.until > now\)/.test(client),
);
check(
  '3b. only unexpired cooldowns are restored',
  /if \(until > now\) providerCooldowns\.set/.test(client) &&
    /if \(cooldown\?\.until > now\) credentialCooldowns\.set/.test(client),
);

check(
  '4. cooldown state is shared: one Map per provider and per credential',
  /const credentialCooldowns = new Map<string, CredentialCooldown>\(\)/.test(client) &&
    /const providerCooldowns = new Map<ApexProviderName, number>\(\)/.test(client) &&
    /const COOLDOWN_SETTINGS_KEY = 'apex\.llm\.cooldowns'/.test(client),
);

console.log(
  failures === 0
    ? '\n✅ Cooldown persistence holds all four properties.\n'
    : `\n❌ ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
