import { evaluateOutboundAction } from './revenue-ops/compliance.js';
import type { OutboundChannel } from './compliance/types.js';
import { contacts, db, researchedLeads, suppressions } from '@workspace/db';
import { and, eq, gt, isNull, or } from 'drizzle-orm';

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const normalized = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

function complianceLinkFromLead(lead: {
  enrichment?: Record<string, unknown> | null;
  enrichmentData?: Record<string, unknown> | null;
}): { organizationId?: string; contactId?: string } {
  const sources = [lead.enrichment, lead.enrichmentData].filter(
    (value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'),
  );

  for (const source of sources) {
    const candidate =
      (source.outboundCompliance as Record<string, unknown> | undefined) ??
      (source.revenueOps as Record<string, unknown> | undefined);
    if (!candidate) continue;
    const organizationId =
      typeof candidate.organizationId === 'string' ? candidate.organizationId.trim() : undefined;
    const contactId = typeof candidate.contactId === 'string' ? candidate.contactId.trim() : undefined;
    if (organizationId || contactId) return { organizationId, contactId };
  }

  return {};
}

async function resolveComplianceIdentity(input: {
  organizationId?: string;
  contactId?: string;
  leadId?: string;
  channel: OutboundChannel;
  destination: string;
}): Promise<{ organizationId?: string; contactId?: string }> {
  if (input.organizationId?.trim() && input.contactId?.trim()) {
    return {
      organizationId: input.organizationId.trim(),
      contactId: input.contactId.trim(),
    };
  }

  if (input.leadId) {
    const [lead] = await db
      .select({
        enrichment: researchedLeads.enrichment,
        enrichmentData: researchedLeads.enrichmentData,
      })
      .from(researchedLeads)
      .where(eq(researchedLeads.id, input.leadId))
      .limit(1);

    const linked = lead ? complianceLinkFromLead(lead) : {};
    if (linked.organizationId && linked.contactId) return linked;
  }

  // A first-party contact record is also a valid linkage. This keeps
  // operator/inbound-confirmation paths from needing a researched_leads id
  // while still refusing arbitrary cold destinations.
  const org = input.organizationId?.trim() || 'apex';
  const destination = input.destination.trim();
  const [contact] = await db
    .select({ id: contacts.id, organizationId: contacts.organizationId })
    .from(contacts)
    .where(and(
      eq(contacts.organizationId, org),
      input.channel === 'email'
        ? eq(contacts.email, destination.toLowerCase())
        : eq(contacts.phoneE164, normalizePhone(destination) ?? destination),
    ))
    .limit(1);

  return contact
    ? { organizationId: contact.organizationId, contactId: contact.id }
    : {};
}

// ─── Owner-line allowlist ───────────────────────────────────────────────────────
// The operator's own numbers are the REQUIRED target of owner-line tests and
// internal transfers (Constitution 24.2/24.4; see call-bridge
// OWNER/APEX_DEFAULT_OPERATOR_NUMBER precedent). They are not subject to
// contact-linkage, outreach-gate, or consent checks — but the DNC/suppression
// check above them always wins, so an explicit opt-out still blocks sends.
// Comma-separated E.164 list; defaults to the operator's cell.
const OWNER_NUMBERS = (process.env.APEX_OWNER_NUMBERS ?? '+18328804970')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

function isOwnerDestination(channel: OutboundChannel, destination: string): boolean {
  if (channel !== 'phone' && channel !== 'sms') return false;
  const digits = destination.replace(/\D/g, '');
  if (digits.length < 10) return false;
  return OWNER_NUMBERS.some((owner) => {
    const ownerDigits = owner.replace(/\D/g, '');
    return ownerDigits.length >= 10 && ownerDigits.slice(-10) === digits.slice(-10);
  });
}

async function isRehearsalDestination(channel: OutboundChannel, destination: string): Promise<boolean> {
  try {
    const { loadOutboundPolicy } = await import('./outbound-policy-store.js');
    const { sameEmail, samePhone } = await import('./outbound-policy.js');
    const policy = await loadOutboundPolicy();
    if (!policy) return false;
    if (channel === 'email') return sameEmail(destination, policy.rehearsalEmail);
    if (channel === 'phone' || channel === 'sms') {
      return samePhone(destination, policy.rehearsalPhone);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Single fail-closed outbound gate for phone, SMS and email.
 *
 * Rehearsal destinations are the only exception and still receive the direct
 * suppression/DNC check below. Every live destination must resolve to a
 * revenue-ops contact + organization and pass the same compliance evaluator.
 * Missing linkage, missing/ambiguous consent, a pending outreach gate, an
 * evaluator error, calling-window failure or cadence violation blocks the send.
 */
export async function assertOutboundAllowed(input: {
  channel: OutboundChannel;
  destination: string;
  organizationId?: string;
  contactId?: string;
  leadId?: string;
  purpose?: string;
}): Promise<{ skipped: boolean; reason?: string }> {
  const destination = input.destination.trim();
  if (!destination) {
    throw new Error(`Compliance denied ${input.channel}: destination is blank`);
  }

  // Destination-level DNC/suppression is checked before any rehearsal or
  // contact-link exception, so an explicit opt-out always wins.
  if (input.channel === 'phone' || input.channel === 'sms') {
    const number = normalizePhone(destination);
    if (!number) {
      throw new Error(`Compliance denied ${input.channel}: invalid destination number`);
    }
    const rows = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(and(
        or(
          ...(input.organizationId ? [eq(suppressions.organizationId, input.organizationId)] : []),
          eq(suppressions.organizationId, 'apex'),
        ),
        eq(suppressions.phoneE164, number),
        or(eq(suppressions.channel, 'all'), eq(suppressions.channel, input.channel)),
        or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, new Date())),
        isNull(suppressions.liftedAt),
      ))
      .limit(1);
    if (rows.length) {
      throw new Error(`Compliance denied ${input.channel} to ${number}: do-not-contact request`);
    }
  } else {
    const normalizedEmail = destination.toLowerCase();
    const rows = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(and(
        or(
          ...(input.organizationId ? [eq(suppressions.organizationId, input.organizationId)] : []),
          eq(suppressions.organizationId, 'apex'),
        ),
        eq(suppressions.email, normalizedEmail),
        or(eq(suppressions.channel, 'all'), eq(suppressions.channel, 'email')),
        or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, new Date())),
        isNull(suppressions.liftedAt),
      ))
      .limit(1);
    if (rows.length) {
      throw new Error(`Compliance denied email to ${normalizedEmail}: suppression/opt-out record`);
    }
  }

  if (isOwnerDestination(input.channel, destination)) {
    return { skipped: true, reason: 'owner destination (owner-line test)' };
  }

  if (await isRehearsalDestination(input.channel, destination)) {
    return { skipped: true, reason: 'operator rehearsal destination' };
  }

  let identity: { organizationId?: string; contactId?: string };
  try {
    identity = await resolveComplianceIdentity({
      ...input,
      channel: input.channel,
      destination,
    });
  } catch (error) {
    throw new Error(
      `Compliance denied ${input.channel}: contact linkage lookup failed (${
        error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180)
      })`,
    );
  }

  const organizationId = identity.organizationId?.trim();
  const contactId = identity.contactId?.trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!organizationId || !contactId || !uuid.test(contactId)) {
    throw new Error(
      `Compliance denied ${input.channel}: a consent-linked revenue-ops contact and organization are required`,
    );
  }

  try {
    const decision = await evaluateOutboundAction({
      organizationId,
      contactId,
      channel: input.channel,
      destination,
      purpose: input.purpose,
    });
    if (decision.decision !== 'allow') {
      throw new Error(
        `Compliance denied ${input.channel} to ${destination}: ${decision.reasons.map((r) => r.message).join('; ')}`,
      );
    }
    return { skipped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Compliance denied')) throw error;
    throw new Error(
      `Compliance denied ${input.channel}: evaluator unavailable (${message.slice(0, 240)})`,
    );
  }
}
