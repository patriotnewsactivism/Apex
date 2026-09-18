import { sql } from 'drizzle-orm';
import { db } from '@workspace/db';
import {
  OutboundActionRequest,
  ComplianceDecision,
  ComplianceReason,
} from './types';

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  // Drizzle db.execute with postgres driver returns RowList (array-like),
  // which is already an array of rows — no .rows wrapper.
  const rows = (result as { rows?: T[] } | null)?.rows;
  if (Array.isArray(rows)) return rows;
  // Fallback: if it's an array-like object (RowList), convert to array
  if (result && typeof result === 'object' && 'length' in result) {
    return Array.from(result as unknown[]) as T[];
  }
  return [];
}

export async function evaluateOutboundAction(
  req: OutboundActionRequest
): Promise<ComplianceDecision> {
  const evaluatedAt = new Date();
  const reasons: ComplianceReason[] = [];

  const destination = req.destination ? req.destination.trim() : '';
  if (!destination) {
    return {
      decision: 'deny',
      reasons: [{ code: 'INVALID_DESTINATION', message: 'Destination address or number is blank.' }],
      evaluatedAt,
    };
  }

  // 1. Suppression Check
  const isEmail = req.channel === 'email';
  const suppressionQuery = isEmail
    ? sql`
        SELECT id, reason FROM suppressions
        WHERE organization_id = ${req.organizationId}::uuid
          AND email = ${destination.toLowerCase()}
          AND channel IN ('email', 'all')
          AND (expires_at IS NULL OR expires_at > ${evaluatedAt})
        LIMIT 1;
      `
    : sql`
        SELECT id, reason FROM suppressions
        WHERE organization_id = ${req.organizationId}::uuid
          AND phone_e164 = ${destination}
          AND channel IN (${req.channel}::channel_enum, 'all')
          AND (expires_at IS NULL OR expires_at > ${evaluatedAt})
        LIMIT 1;
      `;

  const suppressionResult = await db.execute(suppressionQuery);
  const suppressionRows = rowsOf<{ id: string; reason: string }>(suppressionResult);
  if (suppressionRows.length > 0) {
    const row = suppressionRows[0];
    const decision: ComplianceDecision = {
      decision: 'deny',
      reasons: [
        {
          code: 'SUPPRESSED_CHANNEL',
          message: `Recipient is on suppression list (Reason: ${row.reason}).`,
        },
      ],
      evaluatedAt,
      metadata: { suppressionId: row.id },
    };

    await logAuditDenial(req, decision);
    return decision;
  }

  // 2. Contact Status Check
  const contactQuery = await db.execute(sql`
    SELECT id, status, timezone FROM contacts
    WHERE id = ${req.contactId}::uuid AND organization_id =${req.organizationId}::uuid
    LIMIT 1;
  `);

  let recipientTimezone = req.timezone || 'America/Chicago';
  const contactRows = rowsOf<{ status: string; timezone: string | null }>(contactQuery);
  if (contactRows.length > 0) {
    const contact = contactRows[0];
    if (contact.status !== 'active') {
      reasons.push({ code: 'CONTACT_NOT_ACTIVE', message: `Contact is not active (Status: ${contact.status}).` });
    }
    if (contact.timezone) {
      recipientTimezone = contact.timezone;
    }
  }

  // 3. TCPA Calling Window (Phone/SMS: 8:00 AM - 9:00 PM local)
  let localHour: number | undefined;
  if (req.channel === 'phone' || req.channel === 'sms') {
    try {
      const now = req.scheduledTime || evaluatedAt;
      const localTimeString = now.toLocaleTimeString('en-US', {
        timeZone: recipientTimezone,
        hour12: false,
        hour: '2-digit',
      });
      localHour = parseInt(localTimeString, 10);

      if (localHour < 8 || localHour >= 21) {
        reasons.push({
          code: 'OUTSIDE_CALLING_WINDOW',
          message: `Outbound ${req.channel} restricted: local time is ${localHour}:00 in${recipientTimezone} (permitted window: 08:00-21:00).`,
        });
      }
    } catch {
      localHour = undefined;
    }
  }

  // 4. Consent State
  const consentQuery = await db.execute(sql`
    SELECT status FROM consent_records
    WHERE organization_id = ${req.organizationId}::uuid
      AND contact_id = ${req.contactId}::uuid
      AND channel = ${req.channel}::channel_enum
      AND (expires_at IS NULL OR expires_at > ${evaluatedAt})
    ORDER BY created_at DESC
    LIMIT 1;
  `);

  const consentRows = rowsOf<{ status: string }>(consentQuery);
  if (consentRows.length > 0) {
    const consent = consentRows[0];
    if (consent.status === 'denied') {
      reasons.push({ code: 'CONSENT_DENIED', message: `Explicit consent was denied for channel '${req.channel}'.` });
    } else if (consent.status === 'revoked') {
      reasons.push({ code: 'CONSENT_REVOKED', message: `Consent was revoked for channel '${req.channel}'.` });
    }
  }

  // 5. Cadence Limits (Max 3 outbound touches in 24 hours)
  const windowStart = new Date(evaluatedAt.getTime() - 24 * 60 * 60 * 1000);
  const touchHistory = await db.execute(sql`
    SELECT COUNT(*)::int as count FROM interactions
    WHERE organization_id = ${req.organizationId}::uuid
      AND contact_id = ${req.contactId}::uuid
      AND direction = 'outbound'
      AND occurred_at >= ${windowStart};
  `);

  const recentTouches = rowsOf<{ count: number }>(touchHistory)[0]?.count ?? 0;
  if (recentTouches >= 3) {
    reasons.push({
      code: 'CADENCE_EXCEEDED',
      message: `Contact has received ${recentTouches} outbound touches in the last 24 hours (limit is 3).`,
    });
  }

  const isDenied = reasons.length > 0;
  const decision: ComplianceDecision = {
    decision: isDenied ? 'deny' : 'allow',
    reasons,
    evaluatedAt,
    metadata: {
      recipientLocalHour: localHour,
      timezoneUsed: recipientTimezone,
      interactionCount24h: recentTouches,
    },
  };

  if (isDenied) {
    await logAuditDenial(req, decision);
  }

  return decision;
}

async function logAuditDenial(req: OutboundActionRequest, decision: ComplianceDecision) {
  try {
    await db.execute(sql`
      INSERT INTO audit_events (
        organization_id, actor_type, actor_id, action, entity_type, entity_id, metadata, occurred_at
      ) VALUES (
        ${req.organizationId}::uuid, 'system', 'compliance-gatekeeper', 'outbound.denied', 'contact',${req.contactId}::uuid,
        ${JSON.stringify({ channel: req.channel, reasons: decision.reasons, destination: req.destination })},${decision.evaluatedAt}
      );
    `);
  } catch (err) {
    console.error('Failed to write compliance denial audit event:', err);
  }
}
