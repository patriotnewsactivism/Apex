import { Router } from 'express';
import { eq, desc, and, ilike, sql } from 'drizzle-orm';

export function createLeadsRouter(): Router {
  const router = Router();

  // ─── GET /api/leads — list with optional filters ─────────────────────────
  router.get('/', async (req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');

    const conditions = [];
    if (req.query.status) conditions.push(eq(researchedLeads.status, String(req.query.status)));
    if (req.query.industry) conditions.push(ilike(researchedLeads.industry, `%${String(req.query.industry)}%`));
    if (req.query.city) conditions.push(ilike(researchedLeads.city, `%${String(req.query.city)}%`));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(Number(req.query.limit) || 500, 5000);

    const leads = await db
      .select()
      .from(researchedLeads)
      .where(where)
      .orderBy(desc(researchedLeads.createdAt))
      .limit(limit);

    res.json({ leads });
  });

  // ─── GET /api/leads/export — CSV download ────────────────────────────────
  router.get('/export', async (_req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');

    const leads = await db
      .select()
      .from(researchedLeads)
      .orderBy(desc(researchedLeads.createdAt))
      .limit(10000);

    const escapeCsv = (val: string | null | undefined): string => {
      if (val == null) return '';
      const needsQuoting = /["\n\r,]/.test(val);
      const escaped = val.replace(/"/g, '""');
      return needsQuoting ? `"${escaped}"` : escaped;
    };

    const headers = [
      'Company Name', 'Website', 'Industry', 'City', 'Status',
      'Fit Reason', 'Outreach Angle', 'Researched By', 'Created At',
    ];

    const rows = leads.map((l) => [
      escapeCsv(l.companyName),
      escapeCsv(l.website),
      escapeCsv(l.industry),
      escapeCsv(l.city),
      escapeCsv(l.status),
      escapeCsv(l.fitReason),
      escapeCsv(l.outreachAngle),
      escapeCsv(l.researchedByAgentId),
      escapeCsv(l.createdAt?.toISOString() ?? ''),
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="apex-leads.csv"');
    res.send(csv);
  });

  // ─── GET /api/leads/stats — summary counts ───────────────────────────────
  router.get('/stats', async (_req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');

    const all = await db.select().from(researchedLeads);
    const byStatus = {
      new: all.filter((l) => l.status === 'new').length,
      contacted: all.filter((l) => l.status === 'contacted').length,
      qualified: all.filter((l) => l.status === 'qualified').length,
      rejected: all.filter((l) => l.status === 'rejected').length,
    };
    const byIndustry: Record<string, number> = {};
    for (const l of all) {
      const key = l.industry || 'Unknown';
      byIndustry[key] = (byIndustry[key] ?? 0) + 1;
    }

    res.json({ total: all.length, byStatus, byIndustry });
  });

  // ─── PATCH /api/leads/:id — update status ────────────────────────────────
  router.patch('/:id', async (req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');
    const { status } = req.body as { status?: string };
    const validStatuses = ['new', 'contacted', 'qualified', 'rejected'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: 'status must be one of: new, contacted, qualified, rejected' });
      return;
    }

    await db
      .update(researchedLeads)
      .set({ status })
      .where(eq(researchedLeads.id, String(req.params.id)));

    res.json({ success: true, id: req.params.id, status });
  });

  return router;
}
