/**
 * Behavioral coverage for the guarded tasks PATCH (amendment 092a1729).
 *
 * Guards the exact defect class from the P1 incident (silent cancellation of
 * task 55109e1b): a bare status write could stamp a terminal row without
 * attribution. This suite proves the guarded route:
 *
 *   1. Rejects silent cancellation (status='cancelled' with no actor/reason).
 *   2. Requires complete attribution, including actor attestation.
 *   3. Returns 404 for an unknown id.
 *   4. Enforces terminal immutability — no write to done/failed/cancelled rows.
 *   5. A done write does NOT set cancellation fields.
 *   6. A cancelled write stamps completedAt + self-describing errorMessage
 *      (a cancellation is never representable as four NULLs).
 *   7. `blocked` requires the same attribution (reason + actor) but is NOT
 *      terminal: completedAt stays null.
 *   8. PATCH against an already-terminal row → 409, row untouched.
 *
 * The HTTP surface is a local express app wired exactly like src/index.ts
 * (`app.use('/api', requireAdminAuth)`), so the guards are proven under the
 * real auth posture.
 *
 * Fail-closed by construction: this suite writes rows, so it is gated on a
 * *safe* database (localhost or *_test) and skips otherwise — it never touches
 * a production database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

// Fail-closed DB gate (same shape as lead-status-transition.test.ts).
function isSafeTestDatabase(url: string | undefined): boolean {
  const raw = url?.trim();
  if (!raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const testDb = /_test$|^test_|^apex_test/.test(dbName);
  return local || testDb;
}
const hasDatabase = isSafeTestDatabase(process.env.DATABASE_URL);
const suite = hasDatabase ? describe : describe.skip;

const ADMIN_TOKEN = 'tasks-patch-test-token';
process.env.APEX_ADMIN_TOKEN = ADMIN_TOKEN;

suite('guarded tasks PATCH (amendment 092a1729)', () => {
  let db: typeof import('@workspace/db').db;
  let tasks: typeof import('@workspace/db').tasks;
  let server: Server;
  let base: string;
  const createdTaskIds: string[] = [];

  beforeAll(async () => {
    ({ db, tasks } = await import('@workspace/db'));
    const { createTasksRouter } = await import('../routes/tasks.js');
    const { requireAdminAuth } = await import('../middleware/auth.js');

    const app = express();
    app.use(express.json());
    app.use('/api', requireAdminAuth);
    app.use('/api/tasks', createTasksRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    base = `http://127.0.0.1:${address.port}/api/tasks`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (createdTaskIds.length) {
      await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    }
  });

  /** Insert an isolated task at a given status. */
  async function seedTask(status: string): Promise<string> {
    const id = randomUUID();
    createdTaskIds.push(id);
    await db.insert(tasks).values({
      id,
      title: `Guarded PATCH ${id.slice(0, 8)}`,
      description: 'behavioral test task',
      status,
      priority: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    return id;
  }

  const patch = async (
    taskId: string,
    body: Record<string, unknown>,
    authorization = `Bearer ${ADMIN_TOKEN}`,
  ) => {
    const res = await fetch(`${base}/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const readRow = async (taskId: string) => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row;
  };

  it('rejects silent cancellation: status=cancelled without actor/reason → 400', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, { status: 'cancelled' });
    expect(res.status).toBe(400);
    // The row must be untouched — no null-audit cancellation stamping.
    const row = await readRow(id);
    expect(row?.status).toBe('in_progress');
    expect(row?.cancelledBy ?? null).toBeNull();
    expect(row?.cancelReason ?? null).toBeNull();
    expect(row?.cancelledAt ?? null).toBeNull();
  });

  it('requires complete attribution including actor attestation → 400 when actor missing', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, { status: 'cancelled', cancelReason: 'superseded by CEO ruling' });
    expect(res.status).toBe(400);
    const row = await readRow(id);
    expect(row?.status).toBe('in_progress');
  });

  it('requires complete attribution including reason → 400 when reason missing', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, { status: 'cancelled', cancelledBy: 'apex-cto-001' });
    expect(res.status).toBe(400);
    const row = await readRow(id);
    expect(row?.status).toBe('in_progress');
  });

  it('cancels with full attribution and persists actor/reason/at', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, {
      status: 'cancelled',
      cancelledBy: 'apex-cto-001',
      cancelReason: 'superseded by CEO ruling 092a1729',
    });
    expect(res.status).toBe(200);
    // The route returns the full updated row (id + status + attribution).
    expect(res.json).toMatchObject({ id, status: 'cancelled' });
    const row = await readRow(id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('apex-cto-001');
    expect(row?.cancelReason).toContain('092a1729');
    expect(row?.cancelledAt).toBeInstanceOf(Date);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await patch(randomUUID(), { status: 'in_progress' });
    expect(res.status).toBe(404);
  });

  it('enforces terminal immutability: no write to a done row → 409', async () => {
    const id = await seedTask('done');
    const res = await patch(id, { status: 'in_progress' });
    expect(res.status).toBe(409);
    const row = await readRow(id);
    expect(row?.status).toBe('done');
  });

  it('enforces terminal immutability: no write to a failed row → 409', async () => {
    const id = await seedTask('failed');
    const res = await patch(id, { status: 'cancelled', cancelledBy: 'apex-cto-001', cancelReason: 'late' });
    expect(res.status).toBe(409);
    const row = await readRow(id);
    expect(row?.status).toBe('failed');
    expect(row?.cancelledBy ?? null).toBeNull();
  });

  it('enforces terminal immutability: no write to a cancelled row → 409', async () => {
    const id = await seedTask('cancelled');
    const res = await patch(id, { status: 'in_progress' });
    expect(res.status).toBe(409);
    const row = await readRow(id);
    expect(row?.status).toBe('cancelled');
  });

  it('a done write does NOT set cancellation fields', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, { status: 'done' });
    expect(res.status).toBe(200);
    const row = await readRow(id);
    expect(row?.status).toBe('done');
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(row?.cancelledBy ?? null).toBeNull();
    expect(row?.cancelReason ?? null).toBeNull();
    expect(row?.cancelledAt ?? null).toBeNull();
  });

  it('reconciles the PATCH enum with failed: status=failed without errorMessage → 400', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, { status: 'failed' });
    expect(res.status).toBe(400);
    const row = await readRow(id);
    expect(row?.status).toBe('in_progress');
  });

  it('marks failed with errorMessage+completedAt and does NOT set cancel fields', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, { status: 'failed', errorMessage: 'executor reported non-recoverable error' });
    expect(res.status).toBe(200);
    const row = await readRow(id);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toContain('non-recoverable');
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(row?.cancelledBy ?? null).toBeNull();
    expect(row?.cancelReason ?? null).toBeNull();
    expect(row?.cancelledAt ?? null).toBeNull();
  });

  it('cancelled write stamps completedAt + self-describing errorMessage (never four NULLs)', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, {
      status: 'cancelled',
      cancelledBy: 'apex-cto-001',
      cancelReason: 'superseded by CEO ruling 092a1729',
    });
    expect(res.status).toBe(200);
    const row = await readRow(id);
    expect(row?.status).toBe('cancelled');
    // A cancellation must never be representable as four NULLs: completedAt and
    // errorMessage are required on the same write (spec: attribution + observability).
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(row?.errorMessage).toContain('[cancelled]');
    expect(row?.errorMessage).toContain('actor=apex-cto-001');
    expect(row?.errorMessage).toContain('reason=superseded by CEO ruling 092a1729');
    expect(row?.cancelledBy).toBe('apex-cto-001');
    expect(row?.cancelReason).toContain('092a1729');
    expect(row?.cancelledAt).toBeInstanceOf(Date);
  });

  it('blocked without reason → 400 and row unchanged', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, { status: 'blocked', cancelledBy: 'apex-cto-001' });
    expect(res.status).toBe(400);
    const row = await readRow(id);
    expect(row?.status).toBe('in_progress');
    expect(row?.cancelledBy ?? null).toBeNull();
    expect(row?.cancelReason ?? null).toBeNull();
    expect(row?.cancelledAt ?? null).toBeNull();
    expect(row?.errorMessage ?? null).toBeNull();
  });

  it('blocked without actor → 400 and row unchanged', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, { status: 'blocked', cancelReason: 'quarantined for manual review' });
    expect(res.status).toBe(400);
    const row = await readRow(id);
    expect(row?.status).toBe('in_progress');
  });

  it('blocked with attribution stamps actor/reason/at + errorMessage but NOT completedAt', async () => {
    const id = await seedTask('in_progress');
    const res = await patch(id, {
      status: 'blocked',
      cancelledBy: 'apex-qa-001',
      cancelReason: 'quarantined for manual review',
    });
    expect(res.status).toBe(200);
    const row = await readRow(id);
    expect(row?.status).toBe('blocked');
    expect(row?.cancelledBy).toBe('apex-qa-001');
    expect(row?.cancelReason).toContain('quarantined');
    expect(row?.cancelledAt).toBeInstanceOf(Date);
    // Blocked is a quarantine, not terminal: completedAt stays null.
    expect(row?.completedAt ?? null).toBeNull();
    expect(row?.errorMessage).toContain('[blocked]');
    expect(row?.errorMessage).toContain('actor=apex-qa-001');
    expect(row?.errorMessage).toContain('reason=quarantined');
  });

  it('PATCH against an already-terminal row → 409, row untouched', async () => {
    const id = await seedTask('cancelled');
    const res = await patch(id, {
      status: 'cancelled',
      cancelledBy: 'apex-cto-001',
      cancelReason: 'attempted re-cancel',
    });
    expect(res.status).toBe(409);
    const row = await readRow(id);
    // The row must be untouched — no resurrection, no re-stamp.
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy ?? null).toBeNull();
    expect(row?.cancelReason ?? null).toBeNull();
    expect(row?.cancelledAt ?? null).toBeNull();
    expect(row?.completedAt ?? null).toBeNull();
    expect(row?.errorMessage ?? null).toBeNull();
  });
});