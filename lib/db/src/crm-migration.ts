import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * CRM migrations, applied in order. Each file is additive and idempotent, and a
 * new phase is a new file rather than an edit to a file already applied on a
 * running database.
 */
export const CRM_MIGRATION_FILES = [
  '20261003_crm.sql',
  '20261011_crm_phase1.sql',
  '20261012_crm_phase2.sql',
  '20261013_crm_phase3.sql',
] as const;

/**
 * Apply one additive CRM migration. Statements are separated by a
 * "-- STATEMENT" marker so dollar-quoted trigger bodies stay intact.
 */
export function crmMigrationStatements(file: string = CRM_MIGRATION_FILES[0]): string[] {
  const sqlPath = fileURLToPath(new URL(`../drizzle/${file}`, import.meta.url));
  const raw = readFileSync(sqlPath, 'utf8');
  return raw
    .split(/\n-- STATEMENT\n/)
    .map((part) => part.replace(/^--[^\n]*\n/gm, '').trim())
    .filter((part) => part.length > 0 && !part.startsWith('--'));
}

export async function applyCrmMigration(client: { unsafe: (query: string) => Promise<unknown> }): Promise<void> {
  for (const file of CRM_MIGRATION_FILES) {
    for (const statement of crmMigrationStatements(file)) {
      await client.unsafe(statement);
    }
  }
}
