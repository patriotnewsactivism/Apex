import postgres from 'postgres';

/**
 * Separate, least-privilege connection for the email audit gateway. The URL
 * must belong to a LOGIN role that is a member of apex_audit_writer (INSERT
 * only) or apex_audit_reader (SELECT only); see
 * lib/db/drizzle/20261021_email_audit_roles.sql. Never the app's owner URL.
 * Nothing calls this unless EMAIL_AUDIT_* flags are enabled.
 */
export function createAuditSql(url: string) {
  return postgres(url, { max: 2, idle_timeout: 30, prepare: false });
}
export type AuditSql = ReturnType<typeof createAuditSql>;
