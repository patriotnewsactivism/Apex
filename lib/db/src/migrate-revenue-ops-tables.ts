/**
 * Revenue Ops migration entrypoint.
 *
 * The original ad-hoc migration in this file drifted from schema-revenue-ops.ts
 * (notably UUID organization/mission ids vs the current text project/goal ids)
 * and is intentionally retired.
 *
 * Canonical schema:
 *   lib/db/src/schema-revenue-ops.ts
 *
 * Validated Neon migration:
 *   lib/db/drizzle/20260918_revenue_ops_neon.sql
 *
 * Do not add schema DDL here. Generate/update the SQL migration from the current
 * Drizzle schema and validate it on a Neon branch before production.
 */
export async function migrateRevenueOpsTables(): Promise<void> {
  throw new Error(
    'migrateRevenueOpsTables() is retired. Apply lib/db/drizzle/20260918_revenue_ops_neon.sql after Neon branch validation.',
  );
}

if (process.argv?.includes('migrate-revenue-ops-tables')) {
  migrateRevenueOpsTables().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
