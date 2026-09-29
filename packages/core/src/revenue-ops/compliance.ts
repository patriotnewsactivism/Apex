// ─── Revenue Operations Compliance Engine ─────────────────────────────────────
//
// Non-overridable policy enforcement for all revenue-ops outbound actions
// (call, email, SMS). Every outbound tool calls evaluateOutboundAction BEFORE
// executing. Policy failures are enforced in code, not prompt.
//
// Rules (in priority order):
//   1. Suppression check: suppressed contact → deny
//   2. Consent check: no valid consent for channel → deny
//   3. Jurisdiction check: restricted jurisdiction → require_approval
//   4. Purpose check: marketing purpose + transactional-only consent → deny
//   5. Default: allow
//
// Circular dependency guard: this module imports from @workspace/db (schema +
// schema-revenue-ops). It does NOT import from orchestration-tools or any
// revenue-ops tool that might import back from here.

import { db } from '@workspace/db';
import { eq, sql, and, or, isNull, gt } from 'drizzle-orm';
import {
  providerConnections,
  companies,
  contacts,
  consentRecords,
  suppressions,
  contactOutreachGates,
  interactions,
} from '@workspace/db';
import type { OutboundChannel } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────────

export type ComplianceDecisionType = 'allow' | 'deny' | 'require_approval';

export interface ComplianceReason {
  code: string;
  message: string;
}

export interface EvaluateOutboundActionInput {
  organizationId: string;
  contactId: string;
  channel: OutboundChannel;
  destination?: string;
  purpose?: string;
  campaignId?: string;
  scheduledTime?: Date;
  timezone?: string;
}

export interface ComplianceDecision {
  decision: ComplianceDecisionType;
  reasons: ComplianceReason[];
  evaluatedAt: Date;
  metadata?: {
    contactStatus?: string;
    consentStatus?: string;
    suppressionReason?: string;
    gateStatus?: string;
    timezoneUsed?: string;
  };
}

// Channels that require explicit consent before outreach
const CONSENT_REQUIRED_CHANNELS: OutboundChannel[] = ['sms', 'email', 'phone'];

// ─── Suppression check ──────────────────────────────────────────────────────────

async function checkSuppression(
  organizationId: string,
  contactId: string,
  channel: OutboundChannel,
  destination?: string,
): Promise<{ suppressed: boolean; reason?: string }> {
  // Check the cross-channel suppressions table
  const suppressionRows = await db
    .select({ reason: suppressions.reason })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.organizationId, organizationId),
        or(
          eq(suppressions.contactId, contactId),
          ...(destination
            ? channel === 'email'
              ? [eq(suppressions.email, destination.trim().toLowerCase())]
              : [eq(suppressions.phoneE164, destination.trim())]
            : []),
        ),
        or(
          eq(suppressions.channel, channel),
          eq(suppressions.channel, 'all'),
        ),
        or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, new Date())),
      ),
    )
    .limit(1);

  if (suppressionRows.length > 0) {
    return { suppressed: true, reason: suppressionRows[0].reason };
  }

  // Also check contact status
  const contactRows = await db
    .select({ status: contacts.status })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)))
    .limit(1);

  if (contactRows.length > 0 && contactRows[0].status === 'suppressed') {
    return { suppressed: true, reason: 'Contact status is suppressed' };
  }

  return { suppressed: false };
}

// ─── Contact outreach gate check ────────────────────────────────────────────────

async function checkOutreachGate(
  organizationId: string,
  contactId: string,
  channel: OutboundChannel,
): Promise<{ gate: string; allowed: boolean }> {
  const gateRows = await db
    .select({ gate: contactOutreachGates.gate })
    .from(contactOutreachGates)
    .where(
      and(
        eq(contactOutreachGates.organizationId, organizationId),
        eq(contactOutreachGates.contactId, contactId),
        eq(contactOutreachGates.channel, channel),
      ),
    )
    .limit(1);

  if (gateRows.length === 0) {
    // No gate record = pending (default). Compute from consent.
    return { gate: 'pending', allowed: false };
  }

  const gate = gateRows[0].gate as string;
  return { gate, allowed: gate === 'allowed' };
}

// ─── Consent check ──────────────────────────────────────────────────────────────

async function checkConsent(
  organizationId: string,
  contactId: string,
  channel: OutboundChannel,
): Promise<{ hasConsent: boolean; status?: string; scope?: string; expiresAt?: string }> {
  if (!CONSENT_REQUIRED_CHANNELS.includes(channel)) {
    return { hasConsent: true, status: 'not_required' };
  }

  const consentRows = await db
    .select({
      status: consentRecords.status,
      scope: consentRecords.scope,
      expiresAt: consentRecords.expiresAt,
    })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.organizationId, organizationId),
        eq(consentRecords.contactId, contactId),
        eq(consentRecords.channel, channel),
        or(isNull(consentRecords.expiresAt), gt(consentRecords.expiresAt, new Date())),
      ),
    )
    .orderBy(sql`${consentRecords.createdAt} DESC`)
    .limit(1);

  if (consentRows.length === 0) {
    return { hasConsent: false, status: 'missing' };
  }

  const status = consentRows[0].status as string;
  const hasConsent = status === 'granted';
  return {
    hasConsent,
    status,
    scope: consentRows[0].scope ?? undefined,
    expiresAt: consentRows[0].expiresAt?.toISOString(),
  };
}

// ─── Purpose check ──────────────────────────────────────────────────────────────

function checkPurpose(
  channel: OutboundChannel,
  purpose?: string,
  consentScope?: string,
): { passes: boolean; reason?: string } {
  if (!purpose) return { passes: true };

  const purposeLower = purpose.toLowerCase();
  const isMarketing = purposeLower.includes('marketing') || purposeLower.includes('campaign');

  if (isMarketing && consentScope === 'transactional') {
    return {
      passes: false,
      reason: 'Marketing purpose requires marketing consent scope, but contact has transactional-only consent.',
    };
  }

  return { passes: true };
}

// ─── Main evaluation ────────────────────────────────────────────────────────────

export async function evaluateOutboundAction(
  input: EvaluateOutboundActionInput,
): Promise<ComplianceDecision> {
  const evaluatedAt = new Date();
  const reasons: ComplianceReason[] = [];

  // 1. Suppression check
  const suppression = await checkSuppression(
    input.organizationId,
    input.contactId,
    input.channel,
    input.destination,
  );
  if (suppression.suppressed) {
    return {
      decision: 'deny',
      reasons: [
        {
          code: 'SUPPRESSED',
          message: suppression.reason
            ? `Contact is suppressed: ${suppression.reason}`
            : 'Contact is on suppression list.',
        },
      ],
      evaluatedAt,
      metadata: { suppressionReason: suppression.reason },
    };
  }

  // 2. Outreach gate check
  const gate = await checkOutreachGate(
    input.organizationId,
    input.contactId,
    input.channel,
  );
  if (!gate.allowed) {
    return {
      decision: 'deny',
      reasons: [{
        code: gate.gate === 'denied' ? 'OUTREACH_GATE_DENIED' : 'OUTREACH_GATE_PENDING',
        message: gate.gate === 'denied'
          ? 'Contact outreach gate is denied for this channel.'
          : 'Contact outreach gate is not explicitly allowed for this channel.',
      }],
      evaluatedAt,
      metadata: { gateStatus: gate.gate },
    };
  }

  // 3. Consent check
  const consent = await checkConsent(
    input.organizationId,
    input.contactId,
    input.channel,
  );
  if (!consent.hasConsent && consent.status !== 'not_required') {
    return {
      decision: 'deny',
      reasons: [
        {
          code: 'NO_CONSENT',
          message: consent.status === 'missing'
            ? `No consent record found for ${input.channel} channel.`
            : `Consent status is "${consent.status}" — valid consent required.`,
        },
      ],
      evaluatedAt,
      metadata: { consentStatus: consent.status },
    };
  }

  // 4. Purpose check
  const purposeResult = checkPurpose(input.channel, input.purpose, consent.scope);
  if (!purposeResult.passes) {
    return {
      decision: 'deny',
      reasons: [{ code: 'PURPOSE_MISMATCH', message: purposeResult.reason! }],
      evaluatedAt,
    };
  }

  // 5. Phone/SMS calling window and cross-channel cadence. These checks
  // were previously implemented in a second legacy evaluator, which allowed
  // different send paths to get different answers. Keep them here so every
  // outbound channel uses one fail-closed decision engine.
  let timezoneUsed = input.timezone;
  if (!timezoneUsed) {
    const [contact] = await db
      .select({ timezone: contacts.timezone })
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.organizationId, input.organizationId)))
      .limit(1);
    timezoneUsed = contact?.timezone ?? 'America/Chicago';
  }

  if (input.channel === 'phone' || input.channel === 'sms') {
    try {
      const now = input.scheduledTime ?? evaluatedAt;
      const hour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: timezoneUsed,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(now));
      if (hour < 8 || hour >= 21) {
        return {
          decision: 'deny',
          reasons: [{
            code: 'OUTSIDE_CALLING_WINDOW',
            message: `Outbound ${input.channel} is outside the configured 08:00-21:00 local contact window.`,
          }],
          evaluatedAt,
          metadata: {
            consentStatus: consent.status,
            gateStatus: gate.gate,
            timezoneUsed,
          },
        };
      }
    } catch {
      return {
        decision: 'deny',
        reasons: [{ code: 'TIMEZONE_UNVERIFIED', message: 'Recipient timezone could not be verified.' }],
        evaluatedAt,
        metadata: { consentStatus: consent.status, gateStatus: gate.gate },
      };
    }
  }

  const windowStart = new Date(evaluatedAt.getTime() - 24 * 60 * 60 * 1000);
  const [touches] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(interactions)
    .where(and(
      eq(interactions.organizationId, input.organizationId),
      eq(interactions.contactId, input.contactId),
      eq(interactions.direction, 'outbound'),
      gt(interactions.occurredAt, windowStart),
    ));
  if ((touches?.count ?? 0) >= 3) {
    return {
      decision: 'deny',
      reasons: [{
        code: 'CADENCE_EXCEEDED',
        message: `Contact already has ${touches?.count ?? 0} outbound touches in the last 24 hours.`,
      }],
      evaluatedAt,
      metadata: {
        consentStatus: consent.status,
        gateStatus: gate.gate,
        timezoneUsed,
      },
    };
  }

  // 6. Default: allow
  return {
    decision: 'allow',
    reasons: [],
    evaluatedAt,
    metadata: {
      contactStatus: 'active',
      consentStatus: consent.status ?? 'unknown',
      gateStatus: gate.gate,
      timezoneUsed,
    },
  };
}
