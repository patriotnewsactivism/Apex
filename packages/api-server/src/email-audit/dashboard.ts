import { Router } from 'express';
import { verifyChain } from './chain.js';
import type { PgAuditReader } from './store-pg.js';

// Read-only dashboard API. Mounted AFTER requireAdminAuth (Matthew's login)
// and only when EMAIL_AUDIT_DASHBOARD_ENABLED=true. GET only; uses the
// apex_audit_reader connection, so even a bug here cannot write.
export function createEmailAuditDashboardRouter(reader: Pick<PgAuditReader, 'search' | 'perAgentCounts' | 'chainedRows'>): Router {
  const router = Router();
  router.get('/sends', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const since = typeof req.query.since === 'string' && !Number.isNaN(Date.parse(req.query.since)) ? new Date(req.query.since) : undefined;
    const rows = await reader.search({
      agent: typeof req.query.agent === 'string' ? req.query.agent : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined, since, limit,
    });
    res.json({ rows });
  });
  router.get('/agents', async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 730);
    res.json({ rows: await reader.perAgentCounts(new Date(Date.now() - days * 86400_000)) });
  });
  router.get('/chain', async (_req, res) => {
    const rows = await reader.chainedRows();
    const v = verifyChain(rows);
    res.json({ ok: v.ok, length: rows.length, head: rows.at(-1)?.rowHash ?? null, problems: v.problems.slice(0, 100) });
  });
  router.all('*splat', (req, res, next) => (req.method === 'GET' ? next() : res.status(405).json({ error: 'read-only' })));
  return router;
}
