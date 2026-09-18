import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const eventPath = process.env.GITHUB_EVENT_PATH;
const eventName = process.env.GITHUB_EVENT_NAME;
const head = process.env.GITHUB_SHA || 'HEAD';

if (!eventPath || !fs.existsSync(eventPath)) {
  console.log('schema-drift: no GitHub event payload; skipping');
  process.exit(0);
}

const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
let base = null;

if (eventName === 'pull_request') {
  base = event.pull_request?.base?.sha ?? null;
} else if (eventName === 'push') {
  base = event.before ?? null;
  if (base && /^0+$/.test(base)) base = null;
}

if (!base) {
  console.log('schema-drift: no comparison base; skipping');
  process.exit(0);
}

try {
  execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { stdio: 'ignore' });
} catch {
  execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base], { stdio: 'inherit' });
}

const changed = execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' })
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const schemaFiles = new Set([
  'lib/db/src/schema.ts',
  'lib/db/src/schema-revenue-ops.ts',
]);

const schemaChanged = changed.some((file) => schemaFiles.has(file));
if (!schemaChanged) {
  console.log('schema-drift: no canonical schema changes');
  process.exit(0);
}

const migrationChanged = changed.some((file) =>
  (file.startsWith('lib/db/drizzle/') && file.endsWith('.sql')) ||
  file === 'packages/api-server/src/outcome-ledger/migrate.ts'
);

if (!migrationChanged) {
  console.error('Schema changed without a migration artifact.');
  console.error('Changed schema files:', changed.filter((file) => schemaFiles.has(file)).join(', '));
  console.error('Add/update lib/db/drizzle/*.sql or the explicit Outcome Ledger migration.');
  process.exit(1);
}

console.log('schema-drift: canonical schema change is accompanied by a migration artifact');
