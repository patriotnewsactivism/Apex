/**
 * Cancellation-audit regression suite (spec 4e22e5ac).
 *
 * Covers the two shapes the incident exposed that tasks.patch.test.ts does not:
 *
 *   1. The duplicate-goal dedup path — a goal cancelled because a duplicate of
 *      it was submitted must carry a reason that names the canonical goal id,
 *      the duplicate goal id, AND the trigger task id, so the audit trail can
 *      be reconstructed end-to-end.
 *   2. The goals PATCH cascade — cancelling a goal must cascade the SAME actor,
 *      reason (containing the goal id), and cancelledAt onto every open child
 *      task (pending / in_progress / blocked), and must NOT touch terminal
 *      children.
 *
 * Also re-proves the shared attribution helpers directly (unit-level) so the
 * contract is locked even when no database is available.
 *
 * Fail-closed by construction: the HTTP/DB portion writes rows, so it is gated
 * on a *safe* database (localhost or *_test) and skips otherwise — it never
 * touches a production database. The pure helper assertions always run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import {
  ACTOR_HEADER,
  duplicateGoalCancelReason,
  goalCascadeReason,
  resolveCancelActor,
  validateCancelReason,
} from '../routes/cancel-attribution.js';

// Fail-closed DB gate (same shape as tasks.patch.test.ts).
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

const ADMIN_TOKEN = 'cancellation-audit-test-token';
process.env.APEX_ADMIN_TOKEN = ADMIN_TOKEN;

describe('cancel-attribution helpers (unit)', () => {
  it('resolveCancelActor: header wins over body actor', () => {
    const actor = resolveCancelActor(
      { [ACTOR_HEADER]: 'apex-cto-001' },
      'spoofed-body-actor',
    );
    expect(actor).toBe('apex-cto-001');
  });

  it('resolveCancelActor: falls back to body actor when no header', () => {
    const actor = resolveCancelActor({}, 'apex-backend-001');
    expect(actor).toBe('apex-backend-001');
  });

  it('resolveCancelActor: returns null when no actor attestable', () => {
    expect(resolveCancelActor({})).toBeNull();
    expect(resolveCancelActor({}, '   ')).toBeNull();
  });

  it('validateCancelReason: rejects empty and out-of-bound reasons', () => {
    expect(validateCancelReason(undefined)).not.toBeNull();
    expect(validateCancelReason('')).not.toBeNull();
    expect(validateCancelReason('ab')).not.toBeNull();
    expect(validateCancelReason('x'.repeat(2001))).not.toBeNull();
  });

  it('validateCancelReason: accepts a valid 3..2000 reason', () => {
    expect(validateCancelReason('superseded by CEO ruling')).toBeNull();
  });

  it('duplicateGoalCancelReason: names canonical, duplicate, and trigger task', () => {
    const reason = duplicateGoalCancelReason('goal-A', 'goal-B', 'task-C');
    expect(reason).toContain('goal-A');
    expect(reason).toContain('goal-B');
    expect(reason).toContain('task-C');
    expect(reason).toContain('Duplicate goal cancelled');
  });

  it('goalCascadeReason: embeds the goal id', () => {
    const reason = goalCascadeReason('goal-123');
    expect(reason).toContain('goal-123');
    expect(reason).toContain('cascaded');
  });
});

suite('goals PATCH cancellation cascade (spec 4e22e5ac)', () => {
  let db: typeof import('@workspace/db').db;
  let goals: typeof import('@workspace/db').goals;
  let tasks: typeof import('@workspace/db').tasks;
  let server: Server;
  let base: string;
  const createdGoalIds: string[] = [];
  const createdTaskIds: string[] = [];

  beforeAll(async () => {
    ({ db, goals, tasks } = await import('@workspace/db'));
    const { createGoalsRouter } = await import('../routes/goals.js');
    const { requireAdminAuth } = await import('../middleware/auth.js');

    const app = express();
    app.use(express.json());
    app.use('/api', requireAdminAuth);
    app.use('/api/goals', createGoalsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    base = `http://127.0.0.1:${address.port}/api/goals`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (createdTaskIds.length) {
      await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    }
    if (createdGoalIds.length) {
      await db.delete(goals).where(inArray(goals.id, createdGoalIds));
    }
  });

  async function seedGoal(status: string): Promise<string> {
    const id = randomUUID();
    createdGoalIds.push(id);
    await db.insert(goals).values({
      id,
      title: `Cancellation audit goal ${id.slice(0, 8)}`,
      description: 'behavioral test goal',
      status,
      priority: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    return id;
  }

  async function seedChildTask(goalId: string, status: string): Promise<string> {
    const id = randomUUID();
    createdTaskIds.push(id);
    await db.insert(tasks).values({
      id,
      goalId,
      title: `Child task ${id.slice(0, 8)}`,
      description: 'behavioral test child',
      status,
      priority: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    return id;
  }

  const patch = async (
    goalId: string,
    body: Record<string, unknown>,
    authorization = `Bearer ${ADMIN_TOKEN}`,
  ) => {
    const res = await fetch(`${base}/${goalId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const readTask = async (taskId: string) => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row;
  };

  it('rejects silent goal cancellation without actor/reason → 400, no write', async () => {
    const id = await seedGoal('active');
    const res = await patch(id, { status: 'cancelled' });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(goals).where(eq(goals.id, id)).limit(1);
    expect(row?.status).toBe('active');
  });

  it('cancels a goal with attribution and cascades to open children only', async () => {
    const goalId = await seedGoal('active');
    const openPending = await seedChildTask(goalId, 'pending');
    const openInProgress = await seedChildTask(goalId, 'in_progress');
    const openBlocked = await seedChildTask(goalId, 'blocked');
    const terminalDone = await seedChildTask(goalId, 'done');

    const res = await patch(goalId, {
      status: 'cancelled',
      cancelledBy: 'apex-cto-001',
      cancelReason: 'superseded by CEO ruling 4e22e5ac',
    });
    expect(res.status).toBe(200);

    // Goal itself is cancelled with attribution.
    const [goalRow] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    expect(goalRow?.status).toBe('cancelled');
    expect(goalRow?.cancelledBy).toBe('apex-cto-001');
    expect(goalRow?.cancelReason).toContain('4e22e5ac');
    expect(goalRow?.cancelledAt).toBeInstanceOf(Date);

    // Open children cascaded with the SAME actor and a reason containing the goal id.
    for (const childId of [openPending, openInProgress, openBlocked]) {
      const row = await readTask(childId);
      expect(row?.status).toBe('cancelled');
      expect(row?.cancelledBy).toBe('apex-cto-001');
      expect(row?.cancelReason).toContain(goalId);
      expect(row?.cancelledAt).toBeInstanceOf(Date);
    }

    // Terminal child untouched.
    const doneRow = await readTask(terminalDone);
    expect(doneRow?.status).toBe('done');
    expect(doneRow?.cancelledBy ?? null).toBeNull();
  });

  it('goal cancellation stamps completedAt + self-describing result (never blank)', async () => {
    const id = await seedGoal('active');
    const res = await patch(id, {
      status: 'cancelled',
      cancelledBy: 'apex-cto-001',
      cancelReason: 'superseded by CEO ruling 092a1729',
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(goals).where(eq(goals.id, id)).limit(1);
    expect(row?.status).toBe('cancelled');
    // A cancelled goal must never be blank: completedAt + result attribution
    // are required on the same write (spec: attribution + observability).
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(row?.result).toContain('[cancelled]');
    expect(row?.result).toContain('actor=apex-cto-001');
    expect(row?.result).toContain('reason=superseded by CEO ruling 092a1729');
    expect(row?.cancelledBy).toBe('apex-cto-001');
    expect(row?.cancelReason).toContain('092a1729');
    expect(row?.cancelledAt).toBeInstanceOf(Date);
  });

  it('PATCH against an already-cancelled goal → 409, row untouched', async () => {
    const id = await seedGoal('cancelled');
    const res = await patch(id, {
      status: 'cancelled',
      cancelledBy: 'apex-cto-001',
      cancelReason: 'attempted re-cancel',
    });
    expect(res.status).toBe(409);
    const [row] = await db.select().from(goals).where(eq(goals.id, id)).limit(1);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy ?? null).toBeNull();
    expect(row?.cancelReason ?? null).toBeNull();
    expect(row?.cancelledAt ?? null).toBeNull();
    expect(row?.completedAt ?? null).toBeNull();
    expect(row?.result ?? null).toBeNull();
  });
});