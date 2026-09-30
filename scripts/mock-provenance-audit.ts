/** Test-only audit sink for guards that intentionally run without Postgres.
 * This leaves the real provenance evaluator in place and allows no other
 * database inserts. Never import this helper from production code. */
import assert from 'node:assert/strict';

export async function withMockProvenanceAudit<T>(run: () => Promise<T>): Promise<T> {
  const { db, auditEvents } = await import('../lib/db/src/index.js');
  const originalInsert = db.insert;
  db.insert = ((table: unknown) => {
    assert.equal(table, auditEvents, 'guard attempted a non-provenance database write');
    return {
      values(record: { action: string; metadata: { reasons: unknown[] } }) {
        assert.equal(record.action, 'runtime.provenance_verified', 'guard must satisfy real provenance checks');
        assert.deepEqual(record.metadata.reasons, []);
        return { onConflictDoNothing: async () => undefined };
      },
    };
  }) as typeof db.insert;
  try {
    return await run();
  } finally {
    db.insert = originalInsert;
  }
}
