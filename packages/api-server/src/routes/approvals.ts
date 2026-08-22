import { Router } from 'express';
import { db, approvals } from '@workspace/db';
import { and, eq, desc, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { broadcast } from '../websocket.js';

// Two different things live in this table under one status='pending' filter:
//
//   kind='approval'   — a real per-tool gate. An agent is BLOCKED until a human
//                       approves or rejects it (runShell, create_pull_request,
//                       deploy_to_environment, …).
//   kind='escalation' — escalate_to_human. Nothing is blocked; the agent
//                       carried on. It is a message asking for a decision.
//
// Conflating them is what made the queue unusable: 8,683 escalations buried
// 16 gated calls. Listing defaults to approvals, because those are the ones
// where something is actually waiting on a human.
const KINDS = ['approval', 'escalation', 'all'] as const;

/** Escalations older than this with nobody triaging them are closed as stale.
 *  A gated approval is NEVER auto-closed — something is blocked on it. */
const ESCALATION_STALE_AFTER_DAYS = 7;

export function createApprovalsRouter() {
  const router = Router();

  // GET /api/approvals?status=pending&kind=approval
  router.get('/', async (req, res) => {
    const status = String(req.query.status ?? 'pending');
    const kindParam = String(req.query.kind ?? 'approval');
    const kind = (KINDS as readonly string[]).includes(kindParam) ? kindParam : 'approval';

    const where = kind === 'all'
      ? eq(approvals.status, status)
      : and(eq(approvals.status, status), eq(approvals.kind, kind));

    const rows = await db.select().from(approvals)
      .where(where)
      // Repeatedly-raised escalations first: an ask on its 340th shift needs a
      // decision more than one raised for the first time this morning.
      .orderBy(desc(approvals.occurrences), desc(approvals.createdAt))
      .limit(500);

    res.json({ approvals: rows, kind, status });
  });

  // GET /api/approvals/counts — badge numbers without pulling 500 rows
  router.get('/counts', async (_req, res) => {
    const rows = await db
      .select({ kind: approvals.kind, count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(eq(approvals.status, 'pending'))
      .groupBy(approvals.kind);

    const counts = { approval: 0, escalation: 0 };
    for (const r of rows) {
      if (r.kind === 'escalation') counts.escalation = r.count;
      else counts.approval += r.count;
    }
    res.json(counts);
  });

  // POST /api/approvals/:id/approve
  router.post('/:id/approve', async (req, res) => {
    const { note } = z.object({ note: z.string().optional() }).parse(req.body);
    await db.update(approvals)
      .set({ status: 'approved', reviewedAt: new Date(), reviewerNote: note })
      .where(eq(approvals.id, req.params.id));

    broadcast({ type: 'approval:resolved', approvalId: req.params.id, status: 'approved' });
    res.json({ approved: true });
  });

  // POST /api/approvals/:id/reject
  router.post('/:id/reject', async (req, res) => {
    const { note } = z.object({ note: z.string().optional() }).parse(req.body);
    await db.update(approvals)
      .set({ status: 'rejected', reviewedAt: new Date(), reviewerNote: note })
      .where(eq(approvals.id, req.params.id));

    broadcast({ type: 'approval:resolved', approvalId: req.params.id, status: 'rejected' });
    res.json({ rejected: true });
  });

  // POST /api/approvals/:id/acknowledge — escalations only.
  // An escalation is a message, not a gate: acknowledging it clears it from the
  // queue without pretending a tool call was authorized.
  router.post('/:id/acknowledge', async (req, res) => {
    const { note } = z.object({ note: z.string().optional() }).parse(req.body);
    const result = await db.update(approvals)
      .set({ status: 'acknowledged', reviewedAt: new Date(), reviewerNote: note })
      .where(and(eq(approvals.id, req.params.id), eq(approvals.kind, 'escalation')))
      .returning({ id: approvals.id });

    if (result.length === 0) {
      res.status(400).json({
        error: 'Not an open escalation. Gated approvals must be approved or rejected — something is blocked on them.',
      });
      return;
    }

    broadcast({ type: 'approval:resolved', approvalId: req.params.id, status: 'acknowledged' });
    res.json({ acknowledged: true });
  });

  return router;
}

/**
 * Close escalations nobody triaged within the window. Called on the same
 * schedule as the other startup/periodic sweeps in index.ts.
 *
 * Only ever touches kind='escalation'. A gated approval blocks an agent, so
 * expiring one would silently strand real work — those stay pending forever
 * until a human answers.
 */
export async function sweepStaleEscalations(): Promise<number> {
  const cutoff = new Date(Date.now() - ESCALATION_STALE_AFTER_DAYS * 86_400_000);
  const swept = await db
    .update(approvals)
    .set({
      status: 'stale',
      reviewedAt: new Date(),
      reviewerNote: `Auto-closed: no human response within ${ESCALATION_STALE_AFTER_DAYS} days.`,
    })
    .where(
      and(
        eq(approvals.kind, 'escalation'),
        eq(approvals.status, 'pending'),
        lt(approvals.createdAt, cutoff),
      ),
    )
    .returning({ id: approvals.id });

  if (swept.length > 0) {
    console.log(`[approvals] Swept ${swept.length} escalation(s) older than ${ESCALATION_STALE_AFTER_DAYS} days to 'stale'.`);
  }
  return swept.length;
}
