// Postgres (Supabase) migration entrypoint.
// The actual DDL lives in client.ts (single source of truth, uses the
// postgres-js tagged-template client directly rather than drizzle's SQLite-only
// db.run()/db.all() helpers, which don't exist on the Postgres driver).
export { db, schema, migrate } from './client.js';
