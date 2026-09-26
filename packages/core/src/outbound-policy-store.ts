// Loads the apex outbound policy and writes the audit row for an auto-approved
// send or call. Lookup failures fail closed (null), which keeps the human gate.

import {
  decideSalesOutbound,
  emptyOutboundPolicy,
  type OutboundPolicySnapshot,
  type SalesOutboundDecision,
} from './outbound-policy.js';

const PROJECT_ID = 'apex';
const LOAD_TIMEOUT_MS = 800;

export async function loadOutboundPolicy(now = new Date()): Promise<OutboundPolicySnapshot | null> {
  const work = loadOutboundPolicyInner(now);
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]);
}

async function loadOutboundPolicyInner(now: Date): Promise<OutboundPolicySnapshot | null> {
  try {
    const { db, outboundPolicies, outboundAudit } = await import('@workspace/db');
    const { and, eq, gte } = await import('drizzle-orm');
    const [row] = await db.select().from(outboundPolicies).where(eq(outboundPolicies.projectId, PROJECT_ID)).limit(1);
    if (!row) return emptyOutboundPolicy();
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const audits = await db
      .select({ toolName: outboundAudit.toolName, rehearsal: outboundAudit.rehearsal })
      .from(outboundAudit)
      .where(and(eq(outboundAudit.projectId, PROJECT_ID), gte(outboundAudit.createdAt, start)))
      .limit(5000);
    const emailsSentToday = audits.filter((audit) =>
      !audit.rehearsal && (audit.toolName === 'send_email' || audit.toolName === 'send_email_campaign_batch')).length;
    const callsPlacedToday = audits.filter((audit) => !audit.rehearsal && audit.toolName === 'make_outbound_call').length;
    return {
      mode: row.mode === 'rehearsal_only' || row.mode === 'capped_live' ? row.mode : 'off',
      killSwitch: row.killSwitch,
      rehearsalEmail: row.rehearsalEmail,
      rehearsalPhone: row.rehearsalPhone,
      personaName: row.personaName,
      personaCompany: row.personaCompany,
      personaIndustry: row.personaIndustry,
      personaCity: row.personaCity,
      dailyEmailCap: row.dailyEmailCap,
      dailyCallCap: row.dailyCallCap,
      sendWindowStartHour: row.sendWindowStartHour,
      sendWindowEndHour: row.sendWindowEndHour,
      timezone: row.timezone,
      postalAddress: row.postalAddress,
      unsubscribeEmail: row.unsubscribeEmail,
      emailsSentToday,
      callsPlacedToday,
    };
  } catch {
    return null;
  }
}

export async function decideToolOutbound(
  toolName: string,
  args: Record<string, unknown>,
): Promise<SalesOutboundDecision> {
  const policy = await loadOutboundPolicy();
  if (!policy) {
    return { autoApprove: false, rehearsal: false, reason: 'outbound policy unavailable; failing closed' };
  }
  const destinationEmail = typeof args.toEmail === 'string' ? args.toEmail : null;
  const destinationPhone = typeof args.customerNumber === 'string' ? args.customerNumber : null;
  const leadId = typeof args.leadId === 'string' ? args.leadId : null;
  let leadExists = false;
  let suppressed = false;
  try {
    const { db, researchedLeads, emailSuppressions } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');
    if (leadId) {
      const [lead] = await db.select({ id: researchedLeads.id }).from(researchedLeads).where(eq(researchedLeads.id, leadId)).limit(1);
      leadExists = Boolean(lead);
    }
    if (destinationEmail) {
      const [row] = await db.select({ email: emailSuppressions.email })
        .from(emailSuppressions)
        .where(eq(emailSuppressions.email, destinationEmail.trim().toLowerCase()))
        .limit(1);
      suppressed = Boolean(row);
    }
  } catch {
    return { autoApprove: false, rehearsal: false, reason: 'could not verify the lead or suppression list' };
  }
  return decideSalesOutbound({
    toolName,
    destinationEmail,
    destinationPhone,
    leadId,
    leadExists,
    suppressed,
    policy,
  });
}

export async function recordOutboundAudit(input: {
  toolName: string;
  destination?: string | null;
  leadId?: string | null;
  policyMode: string;
  providerId?: string | null;
  rehearsal: boolean;
  detail?: string | null;
}): Promise<void> {
  try {
    const { randomUUID } = await import('crypto');
    const { db, outboundAudit } = await import('@workspace/db');
    await db.insert(outboundAudit).values({
      id: randomUUID(),
      projectId: PROJECT_ID,
      toolName: input.toolName,
      destination: input.destination ?? null,
      leadId: input.leadId ?? null,
      policyMode: input.policyMode,
      providerId: input.providerId ?? null,
      rehearsal: input.rehearsal,
      detail: input.detail ?? null,
      createdAt: new Date(),
    });
  } catch (err) {
    console.warn('[outbound-audit] write failed:', err instanceof Error ? err.message : String(err));
  }
}
