/**
 * Guard: a credential the operator sets on the platform must not be replaced by
 * a dashboard row at boot.
 *
 * Why this exists (2026-10-12): the whole workforce parked on "All LLM
 * providers failed" while Railway's variables looked correct. The QwenCloud
 * BYOK lane — the last metered route, the one that is supposed to survive an
 * exhausted free pool — was answering every call with HTTP 401 "Incorrect API
 * key provided". The app was not reading Railway. `loadSettingsIntoEnv` copies
 * every `integration_settings` row into process.env at boot, and QWEN_API_KEY /
 * QWEN_BASE_URL / QWEN_MODEL were not protected, so a dashboard row saved weeks
 * earlier (a key issued for a different Qwen host, an older model slug)
 * overrode the platform credential. A key and a host that do not belong to the
 * same Qwen host family produce a 401, not a 404, so the failure looked like a
 * bad credential and the operator had no reason to suspect precedence.
 *
 * The invariant: every env name that the QwenCloud BYOK route reads for its
 * credential, host or model is a PLATFORM_AUTHORITATIVE_KEY.
 *
 * This is a source-level guard on purpose. The defect IS the source of
 * precedence, and both sides of it (the protected set, the route's env names)
 * are declarations, so asserting the declarations is asserting the behaviour:
 * a behavioral test would have to stub Postgres to notice the difference.
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
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail).slice(0, 600)}`);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

const SETTINGS_LOADER = 'packages/api-server/src/settingsLoader.ts';
const LLM_CLIENT = 'packages/core/src/llm-client.ts';
const SETTINGS_ROUTE = 'packages/api-server/src/routes/settings.ts';

/** Members of the PLATFORM_AUTHORITATIVE_KEYS literal. */
function protectedKeys(source: string): Set<string> {
  const match = source.match(/PLATFORM_AUTHORITATIVE_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!match) return new Set();
  return new Set([...match[1].matchAll(/'([A-Z0-9_]+)'/g)].map((entry) => entry[1]));
}

/** The provider spec block for `name`, from its `name:` line to the next entry. */
function providerBlock(source: string, name: string): string | null {
  const start = source.indexOf(`name: '${name}'`);
  if (start === -1) return null;
  const rest = source.slice(start);
  const nextEntry = rest.indexOf('\n  {');
  const nextFactory = rest.indexOf('\n  freeOpenRouterSpec(');
  const candidates = [nextEntry, nextFactory].filter((index) => index > 0);
  const end = candidates.length ? Math.min(...candidates) : rest.length;
  return rest.slice(0, end);
}

/** Every env name the route reads: key slots, host override, model override. */
function routeEnvNames(block: string): Set<string> {
  const names = new Set<string>();
  const apiKeyEnvs = block.match(/apiKeyEnvs:\s*\[([^\]]*)\]/);
  if (apiKeyEnvs) {
    for (const entry of apiKeyEnvs[1].matchAll(/'([A-Z0-9_]+)'/g)) names.add(entry[1]);
  }
  const modelOverride = block.match(/modelOverrideEnv:\s*'([A-Z0-9_]+)'/);
  if (modelOverride) names.add(modelOverride[1]);
  for (const entry of block.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(entry[1]);
  return names;
}

function main(): void {
  console.log('Verifying platform credentials cannot be shadowed by dashboard rows...\n');

  const loader = read(SETTINGS_LOADER);
  const client = read(LLM_CLIENT);
  const settingsRoute = read(SETTINGS_ROUTE);
  const protectedSet = protectedKeys(loader);

  check('PLATFORM_AUTHORITATIVE_KEYS parsed with members', protectedSet.size > 0, {
    parsed: protectedSet.size,
  });

  const block = providerBlock(client, 'qwen-dashscope-byok');
  check('qwen-dashscope-byok provider spec found', Boolean(block));

  const envNames = block ? routeEnvNames(block) : new Set<string>();
  check('qwen route declares its credential and host env names', envNames.size >= 3, {
    found: [...envNames],
  });

  const unprotected = [...envNames].filter((name) => !protectedSet.has(name)).sort();
  check(
    'every env name the qwen route reads is platform-authoritative',
    unprotected.length === 0,
    { unprotected },
  );

  // The host the route resolves for a PAYG key and the host a Token Plan key
  // belongs to are not interchangeable, so the host override is part of the
  // credential. Both spellings the route accepts must be protected.
  for (const name of ['QWEN_API_KEY', 'QWEN_BASE_URL', 'APEX_QWEN_BASE_URL', 'QWEN_MODEL']) {
    check(`${name} is platform-authoritative`, protectedSet.has(name));
  }

  // A route env name that no operator can set through the dashboard cannot be
  // shadowed by a dashboard row, so it needs no protection. Checking this keeps
  // the guard honest: it fails if the qwen route ever moves to a name outside
  // the catalog and the protection above starts guarding a stale spelling.
  const catalogMissing = [...envNames]
    .filter((name) => !settingsRoute.includes(`'${name}'`))
    .sort();
  check('every qwen route env name is settable through the dashboard', catalogMissing.length === 0, {
    catalogMissing,
  });

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
