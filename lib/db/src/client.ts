import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema.js';
import { migrate as runMigration } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve relative to the monorepo root (which is 3 levels up from lib/db/src/client.ts)
const rootDir = join(__dirname, '../../..');

let dbPath = process.env.DATABASE_PATH ?? '.local/apex.db';
if (!isAbsolute(dbPath)) {
  dbPath = join(rootDir, dbPath);
}

const client = createClient({ url: `file:${dbPath}` });

export const db = drizzle(client, {
  schema,
  logger: process.env.DB_LOGGING === 'true',
});

export async function migrate() {
  await runMigration(db, { migrationsFolder: './lib/db/drizzle' });
}

export { schema };
export * from './schema.js';
