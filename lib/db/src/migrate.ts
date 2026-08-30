// Postgres (Supabase) migration entrypoint.
// The actual DDL lives in client.ts (single source of truth, uses the
// postgres-js tagged-template client directly rather than drizzle's SQLite-only
// db.run()/db.all() helpers, which don't exist on the Postgres driver).
//
// IMPORTANT: application runtime credentials are data-plane authority, not
// schema-management authority. Legacy runtime code may still import migrate(),
// so this boundary fails closed unless migration execution was deliberately
// enabled for a separately authorized migration operation.
import { db, schema, migrate as runMigration } from './client.js';

export { db, schema };

function migrationsExplicitlyAuthorized(): boolean {
  return ['1', 'true', 'on', 'enabled', 'yes'].includes(
    (process.env.APEX_SCHEMA_MIGRATIONS_ENABLED ?? '').trim().toLowerCase(),
  );
}

export async function migrate(): Promise<void> {
  if (!migrationsExplicitlyAuthorized()) {
    throw new Error(
      'Schema migration refused: set APEX_SCHEMA_MIGRATIONS_ENABLED=true only for an explicitly authorized migration operation',
    );
  }
  await runMigration();
}
