import { Router } from 'express';
import { db, logs, tasks } from '@workspace/db';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { ACTOR_HEADER, resolveCancelActor, validateCancelReason, cancelAttestationError, buildCancellationUpdate } from './cancel-attribution';

/**
 * Terminal task statuses. Once a task reaches one of these it is immutable:
 * no status-changing write (including cancellation) may touch the row again.
 * This is the core of the guarded-PATCH amendment (092a1729): it closes the
 * over-broad terminal cancellation stamping defect where a late PATCH could
 * silently overwrite a done/failed/cancelled row.
 */
const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'] as const;

/** Statuses a PATCH may transition a task INTO. `failed` is intentionally
 *  excluded from the write enum: a task is marked failed by the executor, not
 *  by an operator PATCH. Reconciling the PATCH enum with `failed` means the
 *  route refuses to fabricate a failure it did not observe. */
const PATCHABLE_STATUSES = ['pending', 'in_progress', 'blocked', 'cancelled', 'done'] as const;

/**
 * Statuses that require full cancellation-style attribution: a non-empty
 * `reason` (3..2000 trimmed) and an attested `actor`. Both `cancelled`
 * (terminal) and `blocked` (quarantine) must never be representable as a bare
 * status flip with four NULLs — the exact fingerprint of incident 55109e1b.
 */
const ATTRIBUTED_STATUSES = new Set<string>(['cancelled', 'blocked']);

const patchSchema = z.object({
  status: z.enum(PATCHABLE_STATUSES).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  // Cancellation attribution — required whenever status === 'cancelled' or 'blocked'.
  reason: z.string().min(1).optional(), // canonical field
  cancelReason: z.string().min(1).optional(), // legacy alias
  cancelledBy: z.string().min(1).optional(), // body actor (header wins)
});

export function createTasksRouter() {
  const router = Router();

  // GET /api/tasks — list all tasks
  router.get('/', async (_req, res) => {
    try {
      const allTasks = await db.select().from(tasks).orderBy(desc(tasks.createdAt));
      res.json({ tasks: allTasks });
    } catch (err) {
      res.json({ tasks: [] });
    }
  });

  // GET /api/tasks/:id — get task by id
  router.get('/:id', async (req, res) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, req.params.id)).limit(1);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ task });
  });

  // PATCH /api/tasks/:id — update status/priority (terminal-safe, attributed)
  router.patch('/:id', async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

    const { status, priority, reason, cancelReason } = parsed.data;
    let cancelledBy = parsed.data.cancelledBy;

    // A PATCH that changes nothing is a no-op success.
    if (status === undefined && priority === undefined) {
      return res.json({ updated: false, reason: 'no_fields' });
    }

    // Attribution is mandatory for `cancelled` AND `blocked`. The x-apex-actor
    // header wins over any body actor; reject with 400 BEFORE any write when no
    // actor is attested or the reason is missing / out of the 3..2000 bound.
    // A cancellation must never be representable as four NULLs (incident
    // 55109e1b): actor, reason, completedAt and errorMessage are all required.
    if (status !== undefined && ATTRIBUTED_STATUSES.has(status)) {
      // Pass the FULL headers object — resolveCancelActor reads the header
      // itself. Passing a single header value here would throw when the header
      // is absent (headers[ACTOR_HEADER] on undefined) and turn a 400 into a 500.
      const actor = resolveCancelActor(req.headers, cancelledBy);
      if (!actor) {
        return res.status(400).json(cancelAttestationError('no actor attested for cancellation/block'));
      }
      // The route accepts both `reason` (canonical) and legacy `cancelReason`;
      // prefer the canonical field, fall back to the legacy alias.
      const reasonValue = reason ?? cancelReason;
      const reasonProblem = validateCancelReason(reasonValue);
      if (reasonProblem) {
        return res.status(400).json(cancelAttestationError(reasonProblem));
      }
      // Rebind the resolved actor (header wins) for the write set below.
      cancelledBy = actor;
    }

    // Load the current task to check terminal status and preserve context
    const [existing] = await db.select().from(tasks).where(eq(tasks.id, req.params.id)).limit(1);
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    // Terminal immutability: block EVERY status-changing write to a
    // done/failed/cancelled row with 409 and a terminal-safe predicate. This
    // prevents the over-broad stamping defect where a late PATCH could
    // overwrite a completed task's result or cancellation fields.
    if (TERMINAL_STATUSES.includes(existing.status as (typeof TERMINAL_STATUSES)[number])) {
      return res.status(409).json({
        error: 'Task is terminal and cannot be modified',
        status: existing.status,
        id: existing.id,
      });
    }

    // Build the write set. A done write must NOT set cancellation fields.
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (priority !== undefined) set.priority = priority;
    if (status !== undefined) {
      set.status = status;
      if (status === 'done') {
        set.completedAt = new Date();
      } else if (status === 'cancelled') {
        // Use shared helper for attributed cancellation
        const cancellationUpdate = buildCancellationUpdate(
          cancelledBy,
          (reason ?? cancelReason)!,
          existing.context || {},
          { setCompletedAt: true }
        );
        set.cancelledBy = cancellationUpdate.cancelledBy;
        set.cancelReason = cancellationUpdate.cancelReason;
        set.cancelledAt = cancellationUpdate.cancelledAt;
        set.completedAt = cancellationUpdate.completedAt;
        set.errorMessage = cancellationUpdate.errorMessage;
        set.context = cancellationUpdate.context;
      } else if (status === 'blocked') {
        // Blocked is a quarantine, not a terminal state: attribution is
        // required but completedAt stays null.
        const cancellationUpdate = buildCancellationUpdate(
          cancelledBy,
          (reason ?? cancelReason)!,
          existing.context || {},
          { setCompletedAt: false }
        );
        set.cancelledBy = cancellationUpdate.cancelledBy;
        set.cancelReason = cancellationUpdate.cancelReason;
        set.cancelledAt = cancellationUpdate.cancelledAt;
        set.errorMessage = cancellationUpdate.errorMessage;
        set.context = cancellationUpdate.context;
      }
    }

    // Terminal-safe predicate: only update rows that are still non-terminal.
    // Combined with the read above, this makes the write atomic against a
    // concurrent terminal transition (e.g. an executor marking the task done
    // between our read and our write). Mirrors liveOwnershipPredicate() in
    // task-queue.ts and prevents resurrecting an operator-cancelled row.
    const updated = await db
      .update(tasks)
      .set(set)
      .where(
        and(
          eq(tasks.id, req.params.id),
          notInArray(tasks.status, ['done', 'failed', 'cancelled']),
        ),
      )
      .returning();

    if (updated.length === 0) {
      // The row was terminal by the time the write landed — report 409 so the
      // caller learns the write was refused rather than getting {updated:true}.
      return res.status(409).json({
        error: 'Task is terminal and cannot be modified',
        id: req.params.id,
      });
    }

    return res.json(updated[0]);
  });

  return router;
}