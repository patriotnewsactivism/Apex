// Feature flags for the email audit gateway (memo Option 3). Every flag
// defaults OFF: only the exact string "true" enables it.
export type EmailAuditFlags = {
  gateway: boolean;     // route sends through sendViaGateway (audit row BEFORE provider call)
  providerSend: boolean; // actually call the provider; false = audit + dry-run only
  webhooks: boolean;    // mount /api/email-audit/webhooks/{resend,brevo,ses}
  reconcile: boolean;   // nightly reconciliation job may run
  exportSheet: boolean; // nightly export to the locked Drive Sheet may run
  dashboard: boolean;   // read-only dashboard API behind admin auth
};

const on = (env: NodeJS.ProcessEnv, k: string) => env[k]?.trim() === 'true';

export function readEmailAuditFlags(env: NodeJS.ProcessEnv = process.env): EmailAuditFlags {
  return {
    gateway: on(env, 'EMAIL_AUDIT_GATEWAY_ENABLED'),
    providerSend: on(env, 'EMAIL_AUDIT_PROVIDER_SEND_ENABLED'),
    webhooks: on(env, 'EMAIL_AUDIT_WEBHOOKS_ENABLED'),
    reconcile: on(env, 'EMAIL_AUDIT_RECONCILE_ENABLED'),
    exportSheet: on(env, 'EMAIL_AUDIT_EXPORT_ENABLED'),
    dashboard: on(env, 'EMAIL_AUDIT_DASHBOARD_ENABLED'),
  };
}
