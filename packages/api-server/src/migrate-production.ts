import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { runOutcomeLedgerMigration } from './outcome-ledger/migrate.js';

interface MigrationRow { migration_id: string }

async function ensureMigrationLedger(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS _apex_schema_migrations (
      migration_id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      release_sha text,
      notes text
    )
  `));
}

async function isApplied(id: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT migration_id
    FROM _apex_schema_migrations
    WHERE migration_id = ${id}
    LIMIT 1
  `);
  return Array.from(result as unknown as Iterable<MigrationRow>).length > 0;
}

async function record(id: string, checksum: string, notes: string): Promise<void> {
  const releaseSha = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null;
  await db.execute(sql`
    INSERT INTO _apex_schema_migrations (migration_id, checksum, release_sha, notes)
    VALUES (${id}, ${checksum}, ${releaseSha}, ${notes})
    ON CONFLICT (migration_id) DO NOTHING
  `);
}

function splitSql(source: string): string[] {
  return source
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !statement.startsWith('--') || statement.includes('\n'));
}

async function applySqlFile(id: string, fileUrl: URL, notes: string): Promise<void> {
  await ensureMigrationLedger();
  if (await isApplied(id)) {
    console.log(`[db:migrate] ${id} already applied; skipping`);
    return;
  }

  const source = await readFile(fileUrl, 'utf8');
  const checksum = createHash('sha256').update(source).digest('hex');
  const statements = splitSql(source);

  await db.transaction(async (tx) => {
    for (const statement of statements) {
      await tx.execute(sql.raw(statement));
    }
  });

  await record(id, checksum, notes);
  console.log(`[db:migrate] applied ${id} (${statements.length} statements)`);
}

async function main(): Promise<void> {
  await applySqlFile(
    '20260918_revenue_ops_neon',
    new URL('../../../lib/db/drizzle/20260918_revenue_ops_neon.sql', import.meta.url),
    'Revenue Ops schema aligned to Neon/Postgres and current Drizzle types',
  );

  await runOutcomeLedgerMigration();

  await applySqlFile(
    '20260918_outcome_backfill_v1',
    new URL('../../../lib/db/drizzle/20260918_outcome_backfill.sql', import.meta.url),
    'Historical task outcomes and researched leads backfilled into the Outcome Ledger',
  );
}

main()
  .then(() => {
    console.log('[db:migrate] production migrations complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[db:migrate] failed', error);
    process.exit(1);
  });
