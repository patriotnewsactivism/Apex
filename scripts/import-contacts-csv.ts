/**
 * Import a Newsroom Directory CSV into the CRM contact book.
 * Dry-run is the default. Pass --apply to write. Refuses production databases.
 *
 *   tsx scripts/import-contacts-csv.ts outlets.csv
 *   tsx scripts/import-contacts-csv.ts outlets.csv --apply
 */
import { readFileSync } from 'node:fs';

function refuseProductionDatabase(): void {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    throw new Error('Refusing to import contacts on Railway.');
  }
  const raw = process.env.DATABASE_URL ?? '';
  if (!raw) throw new Error('DATABASE_URL is required and must point at a local database.');
  const lowered = raw.toLowerCase();
  if (lowered.includes('supabase.co') || lowered.includes('railway') || lowered.includes('donmatthews')) {
    throw new Error('Refusing to import contacts against a production database.');
  }
  const host = new URL(raw).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`Refusing non-local database host ${host}.`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const file = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!file) {
    console.error('Usage: tsx scripts/import-contacts-csv.ts <file.csv> [--apply]');
    console.error('Dry-run is the default and changes nothing. --apply writes to the local database.');
    process.exitCode = 1;
    return;
  }
  refuseProductionDatabase();
  const csv = readFileSync(file, 'utf8');
  const { importNewsroomCsv } = await import('../packages/core/src/crm/store.js');
  const result = await importNewsroomCsv(csv, { dryRun: !apply });
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    parsed: result.parsed,
    wouldCreate: result.wouldCreate,
    wouldSkip: result.wouldSkip,
    created: result.created,
    skipped: result.skipped,
    sample: result.rows.slice(0, 25),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
