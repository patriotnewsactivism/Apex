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
  // Runs last and re-asserts every object the CRM phases create. A statement in an
  // earlier file that fails leaves the rest of that file unapplied (no transaction), so
  // the repair pass is what makes the next boot finish the job. It is also where the
  // phase 2 and phase 3 tables are re-asserted, so this file stands on its own.
  '20261014_crm_repair.sql',
] as const;

/**
 * Objects every CRM migration must have produced. Checked after the statements run:
 * a half-applied CRM schema is worse than a boot that refuses, because it fails later,
 * in a request, as a 500 nobody connects to the migration.
 */
export const CRM_REQUIRED_OBJECTS: Array<{ kind: 'table' | 'column'; name: string; table?: string }> = [
  { kind: 'table', name: 'crm_tasks' },
  { kind: 'table', name: 'crm_lead_imports' },
  { kind: 'table', name: 'crm_lead_import_rows' },
  { kind: 'table', name: 'crm_migration_markers' },
  { kind: 'column', table: 'contacts', name: 'lifecycle_stage' },
  { kind: 'column', table: 'suppressions', name: 'lifted_at' },
];

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
    const statements = crmMigrationStatements(file);
    for (const [index, statement] of statements.entries()) {
      try {
        await client.unsafe(statement);
      } catch (error) {
        // Name the file, the statement and its first line. Without this a failing
        // statement stops the file silently, and the app serves a CRM whose tables
        // are missing until a request happens to touch one.
        const head = statement.split('\n')[0]?.slice(0, 120) ?? '';
        console.error(
          `[crm-migration] ${file} statement ${index + 1}/${statements.length} failed: `
          + `${error instanceof Error ? error.message : String(error)} :: ${head}`,
        );
        throw error;
      }
    }
  }
  await verifyCrmSchema(client);
}

/**
 * Confirm the objects the migration promised actually exist. A miss throws, so the
 * boot fails where the cause is legible instead of answering 500s later.
 */
export async function verifyCrmSchema(client: {
  unsafe: (query: string) => Promise<unknown>;
}): Promise<{ ok: true } | never> {
  const missing: string[] = [];
  for (const object of CRM_REQUIRED_OBJECTS) {
    const query = object.kind === 'table'
      ? `SELECT to_regclass('public.${object.name}') AS present`
      : `SELECT 1 AS present FROM information_schema.columns WHERE table_name = '${object.table}' AND column_name = '${object.name}' LIMIT 1`;
    try {
      const rows = (await client.unsafe(query)) as Array<Record<string, unknown>>;
      const present = object.kind === 'table' ? rows[0]?.present != null : rows.length > 0;
      if (!present) missing.push(object.kind === 'table' ? object.name : `${object.table}.${object.name}`);
    } catch (error) {
      missing.push(`${object.kind === 'table' ? object.name : `${object.table}.${object.name}`} (check failed: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`[crm-migration] the CRM schema is incomplete after migrating: ${missing.join(', ')}`);
  }
  return { ok: true };
}
