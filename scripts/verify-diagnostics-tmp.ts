/**
 * Guard the diagnostics /tmp measurement.
 *
 * statfs('/tmp') reports usage of the filesystem containing /tmp, not the
 * contents of /tmp itself. On Railway that produced a false ~900GB critical
 * alert while the actual directory held only a few MB of compiler caches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');
const source = fs.readFileSync(
  path.join(root, 'packages/api-server/src/routes/diagnostics.ts'),
  'utf8',
);

let failures = 0;
function check(label: string, ok: boolean) {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures += 1;
    console.error(`  ❌ ${label}`);
  }
}

console.log('Verifying diagnostics /tmp measurement...');

check(
  'diagnostics no longer imports or uses statfsSync for /tmp size',
  !/statfsSync/.test(source),
);
check(
  'diagnostics measures actual directory contents',
  /function directoryUsageBytes\(/.test(source) &&
    /readdirSync\(dir, \{ withFileTypes: true \}\)/.test(source),
);
check(
  'directory walk does not follow symlinks',
  /child\.isSymbolicLink\(\)/.test(source),
);
check(
  'directory walk is bounded',
  /maxEntries = 25_000/.test(source) &&
    /stopAfterBytes = 2 \* 1024 \* 1024 \* 1024/.test(source),
);
check(
  'Railway-specific wording no longer claims /tmp is Cloud Run RAM',
  /runtimePlatform\(\)/.test(source) &&
    /platform === 'cloud-run'/.test(source),
);

if (failures > 0) {
  console.error(`\n❌ ${failures} diagnostics tmp guard(s) failed.`);
  process.exit(1);
}
console.log('\n✅ DIAGNOSTICS TMP GUARDS PASSED');
