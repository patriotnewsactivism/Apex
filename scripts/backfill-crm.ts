/**
 * One-time copy of legacy outreach rows into the CRM contact book.
 * Dry-run is the default. Pass --apply to write. Never deletes legacy rows.
 * Refuses production databases.
 *
 *   tsx scripts/backfill-crm.ts
 *   tsx scripts/backfill-crm.ts --apply
 */
function refuseProductionDatabase(): void {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    throw new Error('Refusing to backfill the CRM on Railway.');
  }
  const raw = process.env.DATABASE_URL ?? '';
  if (!raw) throw new Error('DATABASE_URL is required and must point at a local database.');
  const lowered = raw.toLowerCase();
  if (lowered.includes('supabase.co') || lowered.includes('railway') || lowered.includes('donmatthews')) {
    throw new Error('Refusing to backfill the CRM against a production database.');
  }
  const host = new URL(raw).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`Refusing non-local database host ${host}.`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  refuseProductionDatabase();
  const { backfillCrm } = await import('../packages/core/src/crm/backfill.js');
  const result = await backfillCrm({ dryRun: !apply });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
