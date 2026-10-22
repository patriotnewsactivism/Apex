import type { Express } from 'express';
import { readEmailAuditFlags } from './flags.js';
import { createEmailAuditWebhookRouter } from './webhooks.js';
import { createEmailAuditDashboardRouter } from './dashboard.js';
import { createPgAuditReader, createPgAuditStore, type PgLike } from './store-pg.js';

// All mounts are no-ops unless their flag is "true" AND the dedicated
// least-privilege DB URL is set. Default production state: nothing mounted.
async function sqlFor(url: string | undefined): Promise<PgLike | null> {
  if (!url) return null;
  const { createAuditSql } = await import('@workspace/db');
  return createAuditSql(url) as unknown as PgLike;
}

export async function mountEmailAuditPublic(app: Express, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!readEmailAuditFlags(env).webhooks) return false;
  const sql = await sqlFor(env.EMAIL_AUDIT_WRITER_DATABASE_URL);
  if (!sql) { console.warn('[email-audit] webhooks flag on but EMAIL_AUDIT_WRITER_DATABASE_URL missing; not mounted'); return false; }
  app.use('/api/email-audit/webhooks', createEmailAuditWebhookRouter({ store: createPgAuditStore(sql), env }));
  return true;
}

export async function mountEmailAuditAdmin(app: Express, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!readEmailAuditFlags(env).dashboard) return false;
  const sql = await sqlFor(env.EMAIL_AUDIT_READER_DATABASE_URL);
  if (!sql) { console.warn('[email-audit] dashboard flag on but EMAIL_AUDIT_READER_DATABASE_URL missing; not mounted'); return false; }
  app.use('/api/email-audit', createEmailAuditDashboardRouter(createPgAuditReader(sql)));
  return true;
}
