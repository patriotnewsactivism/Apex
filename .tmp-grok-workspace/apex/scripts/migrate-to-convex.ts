/**
 * M7: Data Migration — Postgres (Drizzle) → Convex
 *
 * Exports all business data from the old Postgres database to JSON files,
 * ready for import into the Convex backend.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx ../../scripts/migrate-to-convex.ts
 *
 * Output: .local/migration/{table}.json files
 */

import { db } from '@workspace/db';
import {
  agents, goals, tasks, logs, messages, memories,
  researchedLeads, approvals, scheduledJobs,
  taskOutcomes, learningInsights, strategyRecommendations,
  integrationSettings,
} from '@workspace/db';
import { desc } from 'drizzle-orm';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const OUTPUT_DIR = join(process.cwd(), '.local', 'migration');

async function exportTable(name: string, query: any) {
  try {
    const rows = await query;
    const file = join(OUTPUT_DIR, `${name}.json`);
    writeFileSync(file, JSON.stringify(rows, null, 2));
    console.log(`  ${name}: ${rows.length} rows → ${file}`);
    return rows.length;
  } catch (err) {
    console.error(`  ${name}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`\n━━━ APEX Data Migration: Postgres → JSON ━━━`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  let total = 0;

  // ── Core tables ──────────────────────────────────────────────────────────
  total += await exportTable('agents', db.select().from(agents));
  total += await exportTable('goals', db.select().from(goals).orderBy(desc(goals.createdAt)));
  total += await exportTable('tasks', db.select().from(tasks).orderBy(desc(tasks.createdAt)));
  total += await exportTable('logs', db.select().from(logs).orderBy(desc(logs.timestamp)).limit(10000));
  total += await exportTable('messages', db.select().from(messages).orderBy(desc(messages.createdAt)).limit(5000));
  total += await exportTable('memories', db.select().from(memories));

  // ── Lead pipeline ─────────────────────────────────────────────────────────
  total += await exportTable('researchedLeads', db.select().from(researchedLeads).orderBy(desc(researchedLeads.createdAt)));

  // ── Approvals ─────────────────────────────────────────────────────────────
  total += await exportTable('approvals', db.select().from(approvals));

  // ── Scheduled jobs ────────────────────────────────────────────────────────
  total += await exportTable('scheduledJobs', db.select().from(scheduledJobs));

  // ── Learning system ───────────────────────────────────────────────────────
  total += await exportTable('taskOutcomes', db.select().from(taskOutcomes).orderBy(desc(taskOutcomes.createdAt)).limit(5000));
  total += await exportTable('learningInsights', db.select().from(learningInsights));
  total += await exportTable('strategyRecommendations', db.select().from(strategyRecommendations));

  // ── Settings ──────────────────────────────────────────────────────────────
  total += await exportTable('integrationSettings', db.select().from(integrationSettings));

  console.log(`\n━━━ Export complete: ${total} total rows ━━━\n`);
  console.log(`Next step: Import these JSON files into Convex using:`);
  console.log(`  pnpm --filter @workspace/convex-backend exec tsx convex/_scripts/import-json.ts`);
  console.log(`(import script to be created when Convex backend has bulk-import mutations)\n`);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
