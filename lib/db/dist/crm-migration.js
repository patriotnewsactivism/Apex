import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/**
 * Apply the additive CRM migration. Statements are separated by a
 * "-- STATEMENT" marker so dollar-quoted trigger bodies stay intact.
 */
export function crmMigrationStatements() {
    const sqlPath = fileURLToPath(new URL('../drizzle/20261003_crm.sql', import.meta.url));
    const raw = readFileSync(sqlPath, 'utf8');
    return raw
        .split(/\n-- STATEMENT\n/)
        .map((part) => part.replace(/^--[^\n]*\n/gm, '').trim())
        .filter((part) => part.length > 0 && !part.startsWith('--'));
}
export async function applyCrmMigration(client) {
    for (const statement of crmMigrationStatements()) {
        await client.unsafe(statement);
    }
}
