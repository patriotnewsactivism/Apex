// Resend delivery shared by one-off sends, campaign batches, and rehearsal.
// Env is read at call time so a missing key is a failed row, not a crash.

import { unresolvedMergeTokens } from './outbound-policy.js';
import { emailGreetingName } from './sales-playbooks.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

export function resendFromAddress(): string {
  const name = process.env.RESEND_FROM_NAME || 'BuildMyBot Sales';
  const email = process.env.RESEND_FROM_EMAIL || 'sales@buildmybot.app';
  return `${name} <${email}>`;
}

/** Case-sensitive {{field}} substitution. An empty value is left as the token
 *  so the sender can refuse the message instead of mailing a blank or a typo. */
export function resolveMergeFields(
  template: string,
  fields: Record<string, string | null | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = fields[key];
    return value === undefined || value === null || value === '' ? match : value;
  });
}

/** Keep outbound greetings conversational: "Hi Connie," rather than
 *  "Hi Connie Hyde,". Full names stay in CRM/display metadata, not salutations. */
export function humanizeEmailGreeting(
  body: string | null | undefined,
  toName: string | null | undefined,
): string | null {
  if (body == null) return null;
  const fullName = typeof toName === 'string' ? toName.trim() : '';
  const firstName = emailGreetingName(fullName);
  if (!fullName || firstName === 'there' || firstName.toLowerCase() === fullName.toLowerCase()) return body;

  const escaped = fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\export async function isEmailSuppressed(email: string): Promise<boolean> {');
  const htmlGreeting = new RegExp('(<p>\\s*(?:hi|hello|hey|dear)\\s+)' + escaped + '(\\s*[,!]?\\s*<\\/p>)', 'i');
  const plainGreeting = new RegExp('(^|\\n)(\\s*(?:hi|hello|hey|dear)\\s+)' + escaped + '(\\s*[,!]?)', 'i');

  return body
    .replace(htmlGreeting, (_match, lead: string, tail: string) => lead + firstName + tail)
    .replace(plainGreeting, (_match, lineStart: string, lead: string, tail: string) => lineStart + lead + firstName + tail);
}

export async function isEmailSuppressed(email: string): Promise<boolean> {
  const { db, emailSuppressions } = await import('@workspace/db');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(emailSuppressions).where(eq(emailSuppressions.email, email)).limit(1);
  return rows.length > 0;
}

export async function createQueuedEmailSend(args: {
  id: string;
  campaignId?: string | null;
  leadId?: string | null;
  toEmail: string;
  toName?: string | null;
  subject: string;
  body?: string | null;
  createdByAgentId: string;
}): Promise<void> {
  const { db, emailSends } = await import('@workspace/db');
  await db.insert(emailSends).values({
    id: args.id,
    campaignId: args.campaignId ?? null,
    leadId: args.leadId ?? null,
    toEmail: args.toEmail.trim().toLowerCase(),
    toName: args.toName ?? null,
    subject: args.subject,
    body: humanizeEmailGreeting(args.body, args.toName),
    status: 'queued',
    createdByAgentId: args.createdByAgentId,
    createdAt: new Date(),
  });
}

export interface DeliverEmailOptions {
  text?: string;
  /** researched_leads.id, used to resolve the canonical revenue-ops consent link. */
  leadId?: string | null;
  purpose?: string;
  /** When set, a missing postal address fails the send before Resend is called. */
  requireCompliance?: boolean;
  postalAddress?: string | null;
  unsubscribeEmail?: string | null;
}

export async function deliverQueuedEmailSend(
  sendId: string,
  toEmail: string,
  subject: string,
  html: string,
  options: DeliverEmailOptions = {},
): Promise<{ success: boolean; status: string; providerId?: string; error?: string; complianceWarning?: string }> {
  const { db, emailSends } = await import('@workspace/db');
  const { eq } = await import('drizzle-orm');
  const { appendComplianceFooter } = await import('./outbound-policy.js');
  const email = toEmail.trim().toLowerCase();

  const fail = async (status: string, error: string) => {
    await db.update(emailSends)
      .set({ status, errorMessage: error.slice(0, 500) })
      .where(eq(emailSends.id, sendId));
    return { success: false, status, error };
  };

  if (await isEmailSuppressed(email)) {
    return fail('suppressed', 'Recipient is on the suppression list (prior bounce, complaint, or manual opt-out).');
  }

  try {
    const { assertOutboundAllowed } = await import('./outbound-compliance-guard.js');
    await assertOutboundAllowed({
      channel: 'email',
      destination: email,
      leadId: options.leadId ?? undefined,
      purpose: options.purpose ?? 'email_delivery',
    });
  } catch (error) {
    return fail(
      'failed',
      error instanceof Error ? error.message : `Compliance denied email: ${String(error)}`,
    );
  }

  const unresolved = [...new Set([...unresolvedMergeTokens(subject), ...unresolvedMergeTokens(html)])];
  if (unresolved.length > 0) {
    return fail('failed', `Unresolved merge field${unresolved.length === 1 ? '' : 's'}: ${unresolved.join(', ')}`);
  }

  const [sendRow] = await db
    .select({ toName: emailSends.toName })
    .from(emailSends)
    .where(eq(emailSends.id, sendId))
    .limit(1);
  let bodyHtml = humanizeEmailGreeting(html, sendRow?.toName) ?? html;
  let bodyText = options.text
    ? humanizeEmailGreeting(options.text, sendRow?.toName) ?? options.text
    : bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  let complianceWarning: string | undefined;
  const postal = options.postalAddress?.trim() ?? '';
  if (options.requireCompliance && !postal) {
    return fail('failed', 'Live email requires a postal address on the outbound policy before it can send.');
  }
  if (postal) {
    const footed = appendComplianceFooter(bodyHtml, bodyText, postal, options.unsubscribeEmail ?? null);
    bodyHtml = footed.html;
    bodyText = footed.text;
  } else if (!options.requireCompliance) {
    complianceWarning = 'No postal address is configured, so this email has no unsubscribe footer.';
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return fail('failed', 'Resend is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.');
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: resendFromAddress(),
        to: [email],
        subject,
        html: bodyHtml,
        text: bodyText,
        tags: [{ name: 'apex_send_id', value: sendId }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return fail('failed', `Resend ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as { id: string };
    await db.update(emailSends)
      .set({ status: 'sent', providerId: data.id, sentAt: new Date(), errorMessage: null })
      .where(eq(emailSends.id, sendId));
    return { success: true, status: 'sent', providerId: data.id, complianceWarning };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail('failed', message);
  }
}
