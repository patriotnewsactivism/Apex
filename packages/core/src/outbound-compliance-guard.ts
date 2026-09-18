import { evaluateOutboundAction } from './compliance/evaluator.js';
import type { OutboundChannel } from './compliance/types.js';

/**
 * Extra outbound gate on top of the existing approval + suppression paths.
 * Fail closed on an explicit deny. If the revenue-ops compliance tables are
 * missing or the org id is not a UUID, log and continue — do not break the
 * legacy send_email / make_outbound_call tools.
 */
export async function assertOutboundAllowed(input: {
  channel: OutboundChannel;
  destination: string;
  organizationId?: string;
  contactId?: string;
  purpose?: string;
}): Promise<{ skipped: boolean; reason?: string }> {
  const orgId = input.organizationId?.trim();
  const contactId = input.contactId?.trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!orgId || !contactId || !uuid.test(orgId) || !uuid.test(contactId)) {
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
    console.warn('[compliance] evaluator unavailable; using legacy suppression only:', message.slice(0, 240));
    return { skipped: true, reason: message.slice(0, 240) };
  }
}
