import { evaluateOutboundAction } from './compliance/evaluator.js';
import type { OutboundChannel } from './compliance/types.js';
import { db, suppressions } from '@workspace/db';
import { and, eq, or } from 'drizzle-orm';

/**
 * Extra outbound gate on top of the existing approval + suppression paths.
 * Phone outreach fails closed unless the revenue-ops contact can be evaluated.
 * The operator's own rehearsal number is exempt after a DNC check. Legacy
 * email retains its existing suppression fallback.
 */
export async function assertOutboundAllowed(input: {
  channel: OutboundChannel;
  destination: string;
  organizationId?: string;
  contactId?: string;
  purpose?: string;
}): Promise<{ skipped: boolean; reason?: string }> {
  // The legacy APEX caller does not carry a revenue-ops contact UUID. Check
  // number-level opt-outs before the UUID shortcut below so a live call cannot
  // ignore a DNC captured by Cartesia (or another revenue-ops surface).
  if (input.channel === 'phone' || input.channel === 'sms') {
    const digits = input.destination.replace(/\D/g, '');
    const number = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    if (!/^\+[1-9]\d{7,14}$/.test(number)) {
      throw new Error(`Compliance denied ${input.channel}: invalid destination number`);
    }
    const blocked = await db.select({ id: suppressions.id }).from(suppressions).where(and(
      eq(suppressions.organizationId, input.organizationId ?? 'apex'),
      eq(suppressions.phoneE164, number),
      or(eq(suppressions.channel, 'all'), eq(suppressions.channel, input.channel)),
    )).limit(1);
    if (blocked.length) throw new Error(`Compliance denied ${input.channel} to ${number}: do-not-contact request`);
    const ownerDigits = (process.env.TELNYX_OWNER_NUMBER ?? '').replace(/\D/g, '');
    const ownerNumber = ownerDigits.length === 10 ? `+1${ownerDigits}` : `+${ownerDigits}`;
    if (input.channel === 'phone' && input.purpose === 'make_outbound_call' &&
        ownerDigits.length >= 10 && number === ownerNumber) {
      return { skipped: true, reason: 'owner rehearsal number' };
    }
  }
  const orgId = input.organizationId?.trim();
  const contactId = input.contactId?.trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!orgId || !contactId || !uuid.test(orgId) || !uuid.test(contactId)) {
    if (input.channel === 'phone') {
      throw new Error('Compliance denied phone outreach: a linked revenue-ops contact and organization are required');
    }
    return { skipped: true, reason: 'no revenue-ops contact/org UUID; using legacy suppression only' };
  }

  try {
    const decision = await evaluateOutboundAction({
      organizationId: orgId,
      contactId,
      channel: input.channel,
      destination: input.destination,
      purpose: input.purpose,
    });
    if (decision.decision === 'deny') {
      throw new Error(
        `Compliance denied ${input.channel} to ${input.destination}: ${decision.reasons.map((r) => r.message).join('; ')}`,
      );
    }
    return { skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Compliance denied')) throw err;
    if (input.channel === 'phone') {
      throw new Error(`Compliance denied phone outreach: evaluator unavailable (${message.slice(0, 240)})`);
    }
    console.warn('[compliance] evaluator unavailable; using legacy suppression only:', message.slice(0, 240));
    return { skipped: true, reason: message.slice(0, 240) };
  }
}
