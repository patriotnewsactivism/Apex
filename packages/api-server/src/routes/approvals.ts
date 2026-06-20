import { Router } from 'express';
import { db, approvals } from '@workspace/db';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { broadcast } from '../websocket.js';

export function createApprovalsRouter() {
  const router = Router();

  // GET /api/approvals — list pending approvals
  router.get('/', async (req, res) => {
    const { status = 'pending' } = req.query;
    const rows = await db.select().from(approvals)
      .where(eq(approvals.status, String(status)))
      .orderBy(desc(approvals.createdAt));
    res.json({ approvals: rows });
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

  return router;
}
