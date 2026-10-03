import { Router, type Request } from 'express';
import crypto from 'crypto';
import { and, desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db, callOutcomes, providerEvents, researchedLeads, suppressions, contacts, consentRecords, contactOutreachGates } from '@workspace/db';
import { SendBlockedError, assertSendAllowed, commitSmsMessage, createQueuedEmailSend, deliverQueuedEmailSend, evaluateOutboundAction, markLineFree } from '@workspace/core';
import { cartesiaToolSecret, cartesiaWebhookSecret } from '../cartesia-sales-auth.js';

// Cartesia HTTP tools and lifecycle events are different credentials. Both
// routes fail closed until the operator configures their respective secrets.
const AGENT_ID = 'apex-sales-cartesia';
const ORG_ID = 'apex';
const phoneSchema = z.string().transform((raw) => {
  const digits = raw.replace(/\D/g, '');
  const normalized = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return normalized;
}).refine((phone) => /^\+[1-9]\d{7,14}$/.test(phone), 'Invalid phone number');
const callIdSchema = z.string().min(3).max(160);
const short = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => short(max).optional();

// The DNC write is persistent. Require an unambiguous spoken request, not a
// model-inferred disposition from a short acknowledgement such as "yep".
export function isExplicitOptOut(quote: string | undefined): boolean {
  if (!quote || /\b(?:do\s+not|don't|dont|never)\s+(?:want\s+(?:you\s+to\s+)?)?(?:stop|quit|remove|take)\b/i.test(quote)) return false;
  return /\b(?:stop|quit)\s+(?:calling|contacting|texting|messaging)\b|\b(?:do\s+not|don't|dont|never)\s+(?:call|contact|text|message)\s+(?:me|us|again|this\s+number)\b|\bremove\s+(?:me|us|my\s+number)\s+from\b|\btake\s+(?:me|us|my\s+number)\s+off\b|\b(?:unsubscribe|opt\s*out)\b|\bput\s+(?:me|us)\s+on\s+(?:(?:the|your)\s+)?do\s+not\s+call\s+list\b|\b(?:do\s+not|don't|dont)\s+want\s+(?:any\s+)?more\s+(?:calls|texts|messages)\b/i.test(quote);
}

export function secretMatches(received: unknown, expected: string | undefined): boolean {
  if (typeof received !== 'string' || !expected || !received) return false;
  const actualBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function authorized(req: Request, kind: 'tool' | 'event'): boolean {
  return kind === 'tool'
    ? secretMatches(req.headers.authorization?.replace(/^Bearer\s+/i, ''), cartesiaToolSecret())
    : secretMatches(req.headers['x-webhook-secret'], cartesiaWebhookSecret());
}

const outcomeId = (callId: string) => `cartesia:${callId}`;

export function inferCartesiaLifecycleDisposition(
  eventType: string,
  call: Record<string, any>,
  currentDisposition?: string | null,
): string {
  if (currentDisposition && currentDisposition !== 'no_decision') return currentDisposition;

  const transcript = Array.isArray(call.transcript)
    ? call.transcript.map((turn: { role?: string; text?: string }) => turn.text ?? '').join(' ')
    : '';
  const combined = [
    call.end_reason,
    call.summary,
    call.status,
    call.error_message,
    call.telephony_status,
    call.answering_machine_detection,
    transcript,
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();

  if (/voicemail|voice mail|answering machine|machine detected|left a message|after the beep/.test(combined)) {
    return 'voicemail';
  }
  if (/no[ _-]?answer|not answered|unanswered|ring(?:ing)?[ _-]?timeout|timed out ringing|busy|declined|recipient unavailable|did not pick up/.test(combined)) {
    return 'no_answer';
  }
  if (eventType === 'call_failed') return 'failed_to_dial';
  return 'no_decision';
}

function lifecycleNextAction(disposition: string, currentNextAction?: string | null): string | null {
  if (currentNextAction?.trim()) return currentNextAction;
  if (disposition === 'voicemail') return 'Voicemail left; wait for a callback or follow up according to the campaign cadence.';
  if (disposition === 'no_answer') return 'No answer; retry according to the campaign cadence.';
  if (disposition === 'failed_to_dial') return 'Dial failed; inspect the provider error before retrying.';
  return null;
}

function lifecycleSummary(
  disposition: string,
  providerSummary: unknown,
  currentSummary?: string | null,
): string | null {
  if (typeof providerSummary === 'string' && providerSummary.trim()) return providerSummary.trim().slice(0, 2000);
  if (currentSummary?.trim()) return currentSummary;
  if (disposition === 'voicemail') return 'Outbound call reached voicemail.';
  if (disposition === 'no_answer') return 'Outbound call was not answered.';
  if (disposition === 'failed_to_dial') return 'Outbound call failed before a conversation connected.';
  return null;
}

async function findLead(phone: string) {
  const national = phone.startsWith('+1') ? phone.slice(2) : phone.slice(1);
  const [lead] = await db.select().from(researchedLeads)
    .where(or(eq(researchedLeads.contactPhone, phone), eq(researchedLeads.contactPhone, national)))
    .orderBy(desc(researchedLeads.createdAt)).limit(1);
  return lead;
}

async function isSuppressed(phone: string): Promise<boolean> {
  const rows = await db.select({ id: suppressions.id }).from(suppressions).where(and(
    eq(suppressions.organizationId, ORG_ID), eq(suppressions.phoneE164, phone),
    or(eq(suppressions.channel, 'all'), eq(suppressions.channel, 'phone'), eq(suppressions.channel, 'sms')),
  )).limit(1);
  return rows.length > 0;
}

async function recordExplicitSmsConsent(input: {
  phone: string;
  callId: string;
  leadId?: string | null;
}): Promise<string> {
  let [contact] = await db.select({ id: contacts.id }).from(contacts).where(and(
    eq(contacts.organizationId, ORG_ID),
    eq(contacts.phoneE164, input.phone),
  )).limit(1);

  if (!contact) {
    try {
      const inserted = await db.insert(contacts).values({
        organizationId: ORG_ID,
        phoneE164: input.phone,
        source: 'cartesia_sales_call',
        status: 'active',
        metadata: {
          researchedLeadId: input.leadId ?? null,
          firstExplicitSmsConsentCallId: input.callId,
        },
      }).returning({ id: contacts.id });
      contact = inserted[0];
    } catch {
      [contact] = await db.select({ id: contacts.id }).from(contacts).where(and(
        eq(contacts.organizationId, ORG_ID),
        eq(contacts.phoneE164, input.phone),
      )).limit(1);
    }
  }

  if (!contact) throw new Error('Could not create consent-linked contact');

  const now = new Date();
  await db.insert(consentRecords).values({
    organizationId: ORG_ID,
    contactId: contact.id,
    channel: 'sms',
    status: 'granted',
    consentType: 'explicit',
    scope: 'sales',
    source: 'phone',
    evidence: {
      cartesiaCallId: input.callId,
      explicitPermissionToText: true,
      capturedBy: AGENT_ID,
    },
    grantedAt: now,
    revokedAt: null,
    expiresAt: null,
  }).onConflictDoUpdate({
    target: [consentRecords.organizationId, consentRecords.contactId, consentRecords.channel],
    set: {
      status: 'granted',
      consentType: 'explicit',
      scope: 'sales',
      source: 'phone',
      evidence: {
        cartesiaCallId: input.callId,
        explicitPermissionToText: true,
        capturedBy: AGENT_ID,
      },
      grantedAt: now,
      revokedAt: null,
      expiresAt: null,
    },
  });

  await db.insert(contactOutreachGates).values({
    organizationId: ORG_ID,
    contactId: contact.id,
    channel: 'sms',
    gate: 'allowed',
    lastCheckedAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [contactOutreachGates.organizationId, contactOutreachGates.contactId, contactOutreachGates.channel],
    set: {
      gate: 'allowed',
      lastCheckedAt: now,
      updatedAt: now,
    },
  });

  if (input.leadId) {
    const [lead] = await db.select({
      enrichment: researchedLeads.enrichment,
    }).from(researchedLeads).where(eq(researchedLeads.id, input.leadId)).limit(1);
    if (lead) {
      await db.update(researchedLeads).set({
        enrichment: {
          ...(lead.enrichment ?? {}),
          outboundCompliance: {
            organizationId: ORG_ID,
            contactId: contact.id,
            linkedAt: now.toISOString(),
            linkedFrom: 'cartesia_explicit_sms_consent',
          },
        },
      }).where(eq(researchedLeads.id, input.leadId));
    }
  }

  return contact.id;
}

async function recordExplicitEmailConsent(input: {
  phone: string;
  email: string;
  callId: string;
  leadId?: string | null;
}): Promise<string> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const now = new Date();

  const [emailContact] = await db.select({
    id: contacts.id,
    email: contacts.email,
    phoneE164: contacts.phoneE164,
    metadata: contacts.metadata,
  }).from(contacts).where(and(
    eq(contacts.organizationId, ORG_ID),
    eq(contacts.email, normalizedEmail),
  )).limit(1);

  const [phoneContact] = await db.select({
    id: contacts.id,
    email: contacts.email,
    phoneE164: contacts.phoneE164,
    metadata: contacts.metadata,
  }).from(contacts).where(and(
    eq(contacts.organizationId, ORG_ID),
    eq(contacts.phoneE164, input.phone),
  )).limit(1);

  let contact = emailContact ?? phoneContact;
  if (!contact) {
    try {
      const inserted = await db.insert(contacts).values({
        organizationId: ORG_ID,
        email: normalizedEmail,
        phoneE164: input.phone,
        source: 'cartesia_sales_call',
        status: 'active',
        metadata: {
          researchedLeadId: input.leadId ?? null,
          firstRequestedEmailCallId: input.callId,
        },
      }).returning({
        id: contacts.id,
        email: contacts.email,
        phoneE164: contacts.phoneE164,
        metadata: contacts.metadata,
      });
      contact = inserted[0];
    } catch {
      [contact] = await db.select({
        id: contacts.id,
        email: contacts.email,
        phoneE164: contacts.phoneE164,
        metadata: contacts.metadata,
      }).from(contacts).where(and(
        eq(contacts.organizationId, ORG_ID),
        eq(contacts.email, normalizedEmail),
      )).limit(1);
    }
  } else if (!contact.email || contact.email.toLowerCase() !== normalizedEmail) {
    // The prospect just dictated/confirmed this address on the call. Update the
    // existing phone-linked contact so email compliance resolves to the same
    // identity. If another row already owns the email, emailContact would have
    // won above and we do not merge records here.
    await db.update(contacts).set({
      email: normalizedEmail,
      metadata: {
        ...(contact.metadata ?? {}),
        lastRequestedEmailCallId: input.callId,
        researchedLeadId: input.leadId ?? (contact.metadata as Record<string, unknown> | null)?.researchedLeadId ?? null,
      },
      updatedAt: now,
    }).where(eq(contacts.id, contact.id));
    contact = { ...contact, email: normalizedEmail };
  }

  if (!contact) throw new Error('Could not create email consent-linked contact');

  await db.insert(consentRecords).values({
    organizationId: ORG_ID,
    contactId: contact.id,
    channel: 'email',
    status: 'granted',
    consentType: 'explicit',
    scope: 'transactional',
    source: 'phone',
    evidence: {
      cartesiaCallId: input.callId,
      requestedOneTimeFollowUpEmail: true,
      confirmedEmail: normalizedEmail,
      capturedBy: AGENT_ID,
    },
    grantedAt: now,
    revokedAt: null,
    // One requested message, not a durable marketing subscription.
    expiresAt: new Date(now.getTime() + 60 * 60_000),
  }).onConflictDoUpdate({
    target: [consentRecords.organizationId, consentRecords.contactId, consentRecords.channel],
    set: {
      status: 'granted',
      consentType: 'explicit',
      scope: 'transactional',
      source: 'phone',
      evidence: {
        cartesiaCallId: input.callId,
        requestedOneTimeFollowUpEmail: true,
        confirmedEmail: normalizedEmail,
        capturedBy: AGENT_ID,
      },
      grantedAt: now,
      revokedAt: null,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
    },
  });

  await db.insert(contactOutreachGates).values({
    organizationId: ORG_ID,
    contactId: contact.id,
    channel: 'email',
    gate: 'allowed',
    lastCheckedAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [contactOutreachGates.organizationId, contactOutreachGates.contactId, contactOutreachGates.channel],
    set: {
      gate: 'allowed',
      lastCheckedAt: now,
      updatedAt: now,
    },
  });

  if (input.leadId) {
    const [lead] = await db.select({ enrichment: researchedLeads.enrichment })
      .from(researchedLeads).where(eq(researchedLeads.id, input.leadId)).limit(1);
    if (lead) {
      await db.update(researchedLeads).set({
        contactEmail: normalizedEmail,
        enrichment: {
          ...(lead.enrichment ?? {}),
          outboundCompliance: {
            organizationId: ORG_ID,
            contactId: contact.id,
            linkedAt: now.toISOString(),
            linkedFrom: 'cartesia_requested_email_followup',
          },
        },
      }).where(eq(researchedLeads.id, input.leadId));
    }
  }

  return contact.id;
}

async function saveOutcome(input: {
  callId: string; phone: string; name?: string; leadId?: string; disposition: string;
  appointmentAt?: Date; email?: string; notes?: string;
}) {
  await db.insert(callOutcomes).values({
    id: crypto.randomUUID(), callId: outcomeId(input.callId), leadId: input.leadId ?? null,
    customerNumber: input.phone, customerName: input.name ?? null, disposition: input.disposition,
    appointmentAt: input.appointmentAt ?? null, contactEmail: input.email ?? null,
    nextAction: input.notes ?? null, createdByAgentId: AGENT_ID,
  }).onConflictDoUpdate({ target: callOutcomes.callId, set: {
    customerNumber: input.phone, customerName: input.name ?? null, leadId: input.leadId ?? null,
    disposition: input.disposition, appointmentAt: input.appointmentAt ?? null,
    contactEmail: input.email ?? null, nextAction: input.notes ?? null, updatedAt: new Date(),
  } });
}

function calConfig() {
  const key = process.env.APEX_CAL_API_KEY;
  const eventTypeId = Number(process.env.APEX_CAL_EVENT_TYPE_ID);
  return key && Number.isSafeInteger(eventTypeId) && eventTypeId > 0 ? { key, eventTypeId } : null;
}

async function calRequest(path: string, key: string, body?: object) {
  const response = await fetch(`https://api.cal.com/v2/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, 'cal-api-version': '2026-02-25',
      'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  const data = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || data.status !== 'success') throw new Error(`Calendar returned ${response.status}`);
  return data.data;
}

export function createCartesiaSalesRouter(): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (!authorized(req, req.path === '/events' ? 'event' : 'tool')) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  });

  router.post('/tools/lookup-lead', async (req, res) => {
    const parsed = z.object({ phone_number: phoneSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid phone_number required' });
    try {
      const { phone_number: phone } = parsed.data;
      const [lead, suppressed] = await Promise.all([findLead(phone), isSuppressed(phone)]);
      return res.json({ found: !!lead, lead_id: lead?.id ?? null, company_name: lead?.companyName ?? null,
        decision_maker: lead?.decisionMakerName ?? null, interest: lead?.outreachAngle ?? null,
        status: lead?.status ?? null, do_not_contact: suppressed });
    } catch { return res.status(503).json({ error: 'CRM lookup unavailable' }); }
  });

  router.post('/tools/capture-and-qualify-lead', async (req, res) => {
    const parsed = z.object({ call_id: callIdSchema, phone_number: phoneSchema, business_name: short(180),
      prospect_name: optional(160), prospect_email: z.string().email().optional(),
      interest_track: z.enum(['voice_bot', 'chat_agent', 'workflow_automation', 'full_stack']),
      call_or_ticket_volume: optional(120), current_tech_stack: optional(300),
      qualification_notes: optional(1000),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Call, phone, business, and interest track required' });
    try {
      const p = parsed.data;
      // Capturing factual CRM details is an internal write, not outbound contact.
      // Do not discard an email the prospect explicitly provides merely because
      // the phone/SMS channel is suppressed; actual outbound actions are gated
      // separately by channel-specific compliance at send time.
      let lead = await findLead(p.phone_number);
      const spoken = { interest_track: p.interest_track, call_or_ticket_volume: p.call_or_ticket_volume,
        current_tech_stack: p.current_tech_stack, qualification_notes: p.qualification_notes,
        cartesia_call_id: p.call_id };
      if (!lead) {
        const id = `cartesia-${crypto.createHash('sha256').update(p.call_id).digest('hex').slice(0, 32)}`;
        await db.insert(researchedLeads).values({ id, companyName: p.business_name,
          decisionMakerName: p.prospect_name ?? null, contactEmail: p.prospect_email ?? null,
          contactPhone: p.phone_number, fitReason: 'Prospect described a potential automation need on a sales call.',
          source: 'cartesia_sales_call', researchedByAgentId: AGENT_ID, status: 'contacted',
          enrichmentData: { sales_call: spoken },
        }).onConflictDoNothing();
        lead = await findLead(p.phone_number);
      } else {
        await db.update(researchedLeads).set({ status: lead.status === 'new' ? 'contacted' : lead.status,
          decisionMakerName: lead.decisionMakerName ?? p.prospect_name ?? null,
          contactEmail: lead.contactEmail ?? p.prospect_email ?? null,
          enrichmentData: { ...(lead.enrichmentData ?? {}), sales_call: spoken },
        }).where(eq(researchedLeads.id, lead.id));
      }
      const [prior] = await db.select({ disposition: callOutcomes.disposition })
        .from(callOutcomes).where(eq(callOutcomes.callId, outcomeId(p.call_id))).limit(1);
      if (!prior || prior.disposition === 'no_decision') await saveOutcome({ callId: p.call_id,
        phone: p.phone_number, name: p.prospect_name, leadId: lead?.id,
        disposition: 'no_decision', notes: p.qualification_notes });
      return res.json({ saved: true, lead_id: lead?.id ?? null });
    } catch { return res.status(503).json({ error: 'CRM write unavailable' }); }
  });

  router.post('/tools/send-requested-followup-email', async (req, res) => {
    const parsed = z.object({
      call_id: callIdSchema,
      phone_number: phoneSchema,
      prospect_email: z.string().email(),
      prospect_name: optional(160),
      follow_up_type: z.enum(['buildmybot_overview', 'apex_overview']).default('buildmybot_overview'),
      requested_by_prospect: z.literal(true),
    }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Confirmed email and explicit prospect request are required' });
    }

    try {
      const p = parsed.data;
      const normalizedEmail = p.prospect_email.trim().toLowerCase();
      const lead = await findLead(p.phone_number);
      const eventId =
        'requested-email:' + p.call_id + ':' +
        crypto.createHash('sha256').update(normalizedEmail).digest('hex').slice(0, 16);

      const [prior] = await db.select({ id: providerEvents.id }).from(providerEvents).where(and(
        eq(providerEvents.provider, 'cartesia'),
        eq(providerEvents.externalEventId, eventId),
      )).limit(1);
      if (prior) {
        return res.json({ sent: true, already_sent: true, to: normalizedEmail });
      }

      await recordExplicitEmailConsent({
        phone: p.phone_number,
        email: normalizedEmail,
        callId: p.call_id,
        leadId: lead?.id ?? null,
      });

      const firstName = p.prospect_name?.trim().split(/\s+/)[0] || 'there';
      const isBuildMyBot = p.follow_up_type === 'buildmybot_overview';
      const subject = isBuildMyBot
        ? 'BuildMyBot follow-up you requested'
        : 'APEX follow-up you requested';
      const productName = isBuildMyBot ? 'BuildMyBot' : 'APEX Work Solutions';
      const productUrl = isBuildMyBot ? 'https://www.buildmybot.app/' : 'https://apexwork.org/';
      const html =
        '<p>Hi ' + firstName.replace(/[<>&"]/g, '') + ',</p>' +
        '<p>As requested, here is the follow-up from our call.</p>' +
        '<p><strong>' + productName + '</strong>: <a href="' + productUrl + '">' + productUrl + '</a></p>' +
        (isBuildMyBot
          ? '<p>BuildMyBot helps businesses handle inbound calls and automate follow-up workflows.</p>'
          : '<p>APEX is an AI-powered business automation and revenue-workforce platform.</p>') +
        '<p>— Don<br>BuildMyBot / APEX</p>';
      const text =
        'Hi ' + firstName + ',\n\n' +
        'As requested, here is the follow-up from our call.\n\n' +
        productName + ': ' + productUrl + '\n\n' +
        (isBuildMyBot
          ? 'BuildMyBot helps businesses handle inbound calls and automate follow-up workflows.\n\n'
          : 'APEX is an AI-powered business automation and revenue-workforce platform.\n\n') +
        '— Don\nBuildMyBot / APEX';

      const sendId = crypto.randomUUID();
      await createQueuedEmailSend({
        id: sendId,
        leadId: lead?.id ?? null,
        toEmail: normalizedEmail,
        toName: p.prospect_name ?? null,
        subject,
        body: html,
        createdByAgentId: AGENT_ID,
      });
      const result = await deliverQueuedEmailSend(sendId, normalizedEmail, subject, html, {
        text,
        leadId: lead?.id ?? null,
        purpose: 'requested_followup_email',
      });
      if (!result.success) {
        return res.status(result.status === 'suppressed' ? 409 : 503).json({
          sent: false,
          error: result.error ?? 'Requested email could not be sent',
        });
      }

      const now = new Date();
      await db.insert(providerEvents).values({
        provider: 'cartesia',
        externalEventId: eventId,
        eventType: 'requested_email_sent',
        payload: {
          call_id: p.call_id,
          email_send_id: sendId,
          follow_up_type: p.follow_up_type,
        },
        status: 'processed',
        processedAt: now,
      }).onConflictDoNothing();

      if (lead) {
        await db.update(researchedLeads).set({ contactEmail: normalizedEmail })
          .where(eq(researchedLeads.id, lead.id));
      }
      await db.update(callOutcomes).set({
        contactEmail: normalizedEmail,
        nextAction: 'Prospect-requested email follow-up sent during the call.',
        updatedAt: now,
      }).where(eq(callOutcomes.callId, outcomeId(p.call_id)));

      return res.json({
        sent: true,
        email_send_id: sendId,
        to: normalizedEmail,
        message: 'Requested follow-up email sent.',
      });
    } catch (error) {
      return res.status(503).json({
        sent: false,
        error: error instanceof Error ? error.message.slice(0, 240) : 'Requested email could not be sent',
      });
    }
  });

  router.post('/tools/check-calendar-availability', async (req, res) => {
    const parsed = z.object({ start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      timezone: short(80), preferred_time_of_day: z.enum(['morning', 'afternoon', 'any']).default('any') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Start/end dates and timezone required' });
    const config = calConfig();
    if (!config) return res.status(503).json({ error: 'Live calendar is not connected; offer a callback instead' });
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timezone });
      const { start_date, end_date, timezone, preferred_time_of_day } = parsed.data;
      if (start_date > end_date || (Date.parse(end_date) - Date.parse(start_date)) > 14 * 86400_000)
        return res.status(400).json({ error: 'Use a date range of at most 14 days' });
      const params = new URLSearchParams({ eventTypeId: String(config.eventTypeId), start: start_date,
        end: end_date, timeZone: timezone });
      const data = await calRequest(`slots?${params}`, config.key) as Record<string, Array<{ start: string }>>;
      const slots = Object.values(data).flat().map((slot) => slot.start).filter((s) => {
        const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(s)));
        return preferred_time_of_day === 'any' || (preferred_time_of_day === 'morning' ? hour < 12 : hour >= 12);
      }).slice(0, 3);
      return res.json({ slots, timezone });
    } catch { return res.status(503).json({ error: 'Calendar unavailable; do not promise a time' }); }
  });

  router.post('/tools/book-consultation', async (req, res) => {
    const parsed = z.object({ call_id: callIdSchema, phone_number: phoneSchema,
      prospect_name: short(160), prospect_email: z.string().email(), slot_time: z.string().datetime({ offset: true }),
      timezone: short(80), scope_summary: optional(500) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Confirmed slot, name, email, phone, timezone and call_id required' });
    const config = calConfig();
    if (!config) return res.status(503).json({ error: 'Live calendar is not connected; offer a callback instead' });
    try {
      const p = parsed.data;
      new Intl.DateTimeFormat('en-US', { timeZone: p.timezone });
      if (await isSuppressed(p.phone_number)) return res.status(409).json({ error: 'Contact opted out' });
      const at = new Date(p.slot_time);
      if (at.getTime() <= Date.now()) return res.status(400).json({ error: 'Slot is in the past' });
      const [existing] = await db.select().from(callOutcomes).where(eq(callOutcomes.callId, outcomeId(p.call_id))).limit(1);
      if (existing?.disposition === 'appointment_booked')
        return res.json({ booked: true, already_booked: true, start: existing.appointmentAt?.toISOString() });
      const booking = await calRequest('bookings', config.key, { eventTypeId: config.eventTypeId,
        start: at.toISOString(), attendee: { name: p.prospect_name, email: p.prospect_email,
          phoneNumber: p.phone_number, timeZone: p.timezone },
        metadata: { source: 'apex_cartesia', call_id: p.call_id },
      }) as { uid?: string; status?: string; start?: string };
      if (!booking.uid) throw new Error('Calendar did not confirm a booking');
      const booked = booking.status === 'accepted';
      let recorded = true;
      try {
        await saveOutcome({ callId: p.call_id, phone: p.phone_number, name: p.prospect_name,
          leadId: (await findLead(p.phone_number))?.id, disposition: booked ? 'appointment_booked' : 'callback_requested',
          appointmentAt: booked ? at : undefined, email: p.prospect_email,
          notes: `Cal.com ${booking.uid}; ${p.scope_summary ?? ''}` });
      } catch { recorded = false; }
      return res.json({ booked, recorded, booking_uid: booking.uid, booking_status: booking.status,
        start: booking.start ?? at.toISOString(), message: booked ? 'Confirmed by calendar' : 'Awaiting host confirmation; do not claim it is booked' });
    } catch { return res.status(503).json({ error: 'Booking failed; do not claim it is booked' }); }
  });

  router.post('/tools/record-outcome', async (req, res) => {
    const parsed = z.object({ call_id: callIdSchema, phone_number: phoneSchema,
      disposition: z.enum(['qualified', 'callback_requested', 'not_interested', 'no_decision', 'dnc']),
      prospect_name: optional(160), notes: optional(500), opt_out_quote: optional(240) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid call outcome' });
    if (parsed.data.disposition === 'dnc' && !isExplicitOptOut(parsed.data.opt_out_quote))
      return res.status(400).json({ error: 'DNC requires an explicit spoken opt-out; ask for clarification if uncertain' });
    try {
      const p = parsed.data;
      if (p.disposition === 'dnc') {
        const [existing] = await db.select({ id: suppressions.id }).from(suppressions).where(and(
          eq(suppressions.organizationId, ORG_ID), eq(suppressions.phoneE164, p.phone_number), eq(suppressions.channel, 'all'))).limit(1);
        if (!existing) await db.insert(suppressions).values({ organizationId: ORG_ID,
          phoneE164: p.phone_number, channel: 'all', reason: 'dnc', source: 'cartesia_sales_call' });
      }
      const [existingOutcome] = await db.select({ disposition: callOutcomes.disposition })
        .from(callOutcomes).where(eq(callOutcomes.callId, outcomeId(p.call_id))).limit(1);
      if (existingOutcome?.disposition === 'dnc') return res.json({ recorded: true, do_not_contact: true });
      if (existingOutcome?.disposition === 'appointment_booked' && p.disposition !== 'dnc')
        return res.json({ recorded: true, preserved_booking: true });
      await saveOutcome({ callId: p.call_id, phone: p.phone_number, name: p.prospect_name,
        leadId: (await findLead(p.phone_number))?.id, disposition: p.disposition, notes: p.notes });
      return res.json({ recorded: true, do_not_contact: p.disposition === 'dnc' });
    } catch { return res.status(503).json({ error: 'Outcome was not saved' }); }
  });

  router.post('/tools/send-demo-link', async (req, res) => {
    const parsed = z.object({ call_id: callIdSchema, phone_number: phoneSchema, consent_to_text: z.literal(true),
      demo_type: z.enum(['buildmybot_live_demo', 'apex_overview']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Phone and explicit permission to text required' });
    const p = parsed.data;
    const key = process.env.TELNYX_API_KEY;
    const from = process.env.APEX_FRONT_DESK_NUMBER;
    if (!key || !from) return res.status(503).json({ error: 'SMS provider not configured' });
    try {
      if (await isSuppressed(p.phone_number)) return res.status(409).json({ error: 'Contact opted out' });

      const lead = await findLead(p.phone_number);
      const contactId = await recordExplicitSmsConsent({
        phone: p.phone_number,
        callId: p.call_id,
        leadId: lead?.id ?? null,
      });
      const compliance = await evaluateOutboundAction({
        organizationId: ORG_ID,
        contactId,
        channel: 'sms',
        destination: p.phone_number,
        purpose: 'requested_demo_link',
      });
      if (compliance.decision !== 'allow') {
        return res.status(409).json({
          error: 'SMS blocked by compliance evaluator',
          reasons: compliance.reasons.map((reason) => reason.code),
        });
      }

      const url = p.demo_type === 'buildmybot_live_demo' ? 'https://www.buildmybot.app/' : 'https://apexwork.org/';
      const eventId = `demo:${p.call_id}:${p.demo_type}`;
      const [prior] = await db.select({ id: providerEvents.id }).from(providerEvents).where(and(
        eq(providerEvents.provider, 'cartesia'), eq(providerEvents.externalEventId, eventId))).limit(1);
      if (prior) return res.json({ sent: true, already_sent: true, url });
      const text = `As requested, here is ${p.demo_type === 'buildmybot_live_demo' ? 'BuildMyBot' : 'APEX Work Solutions'}: ${url} Reply STOP to opt out.`;
      // TODO(feat/send-safeguard): assertSendAllowed checks do-not-contact before the provider call.
      try {
        await assertSendAllowed({ channel: 'sms', destination: p.phone_number, contactId });
      } catch (error) {
        if (error instanceof SendBlockedError) return res.status(409).json({ error: error.message, doNotContact: true });
        throw error;
      }
      const response = await fetch('https://api.telnyx.com/v2/messages', { method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: p.phone_number, text }), signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`SMS provider returned ${response.status}`);
      const result = await response.json() as { data?: { id?: string } };
      try {
        const id = crypto.randomUUID();
        await commitSmsMessage({ id, direction: 'outbound',
          counterpartyNumber: p.phone_number, fromNumber: from, toNumber: p.phone_number,
          body: text, status: 'sent', providerId: result.data?.id, createdByAgentId: AGENT_ID,
        }, { actorType: 'agent', actorName: AGENT_ID });
        await db.insert(providerEvents).values({ provider: 'cartesia',
          externalEventId: eventId, eventType: 'demo_link_sent',
          payload: { call_id: p.call_id, sms_id: id, demo_type: p.demo_type }, status: 'processed',
          processedAt: new Date() }).onConflictDoNothing();
        return res.json({ sent: true, recorded: true, url });
      } catch {
        // Provider accepted the text. Do not invite the agent to resend it.
        return res.json({ sent: true, recorded: false, url });
      }
    } catch { return res.status(503).json({ error: 'Text could not be sent; do not say it was delivered' }); }
  });

  router.post('/events', async (req, res) => {
    const event = req.body as Record<string, any>;
    if (!event || typeof event.webhook_request_id !== 'string' || typeof event.call_id !== 'string' ||
      typeof event.type !== 'string')
      return res.status(400).json({ error: 'Invalid event' });

    // One webhook is attached to the canonical Cartesia sales agent, so Cartesia
    // also sends lifecycle/turn events we do not need to persist. They are valid
    // authenticated deliveries, not errors: ACK them to prevent pointless retries.
    if (!['call_completed', 'call_failed', 'post_call_analysis'].includes(event.type))
      return res.json({ received: true, ignored: true, type: event.type });

    try {
      const call = event.call ?? {};
      if (event.type === 'call_completed' || event.type === 'call_failed') {
        await markLineFree({ callId: outcomeId(event.call_id), reason: event.type });
      }
      const params = call.telephony_params ?? {};
      const phone = params.direction === 'inbound' ? params.from : params.to;
      const [current] = await db.select().from(callOutcomes).where(eq(callOutcomes.callId, outcomeId(event.call_id))).limit(1);
      if (event.type === 'post_call_analysis') {
        if (typeof event.analysis?.summary === 'string') await db.insert(callOutcomes).values({
          id: crypto.randomUUID(), callId: outcomeId(event.call_id), customerNumber: typeof phone === 'string' ? phone : '',
          disposition: current?.disposition ?? 'no_decision', summary: event.analysis.summary.slice(0, 2000),
          nextAction: current?.nextAction ?? null, createdByAgentId: current?.createdByAgentId ?? AGENT_ID,
        }).onConflictDoUpdate({ target: callOutcomes.callId,
          set: { summary: event.analysis.summary.slice(0, 2000), updatedAt: new Date() } });
      } else {
        // Never overwrite a meaningful decision captured by a mid-call tool.
        // When no tool could run (voicemail/no-answer/provider failure), infer a
        // conservative lifecycle disposition so the operator sees what happened
        // without having to read the raw transcript.
        const transcript = Array.isArray(call.transcript) ? call.transcript
          .map((turn: { role?: string; text?: string }) => `${turn.role ?? 'unknown'}: ${turn.text ?? ''}`).join('\n').slice(0, 50000) : null;
        const disposition = inferCartesiaLifecycleDisposition(event.type, call, current?.disposition);
        const summary = lifecycleSummary(disposition, call.summary, current?.summary);
        const nextAction = lifecycleNextAction(disposition, current?.nextAction);
        const endedReason = typeof call.end_reason === 'string'
          ? call.end_reason.slice(0, 500)
          : (typeof call.error_message === 'string' ? call.error_message.slice(0, 500) : current?.endedReason ?? null);

        await db.insert(callOutcomes).values({
          id: crypto.randomUUID(),
          callId: outcomeId(event.call_id),
          leadId: current?.leadId ?? null,
          customerNumber: typeof phone === 'string' ? phone : current?.customerNumber ?? '',
          customerName: current?.customerName ?? null,
          disposition,
          transcript,
          summary,
          nextAction,
          endedReason,
          createdByAgentId: current?.createdByAgentId ?? AGENT_ID,
        }).onConflictDoUpdate({
          target: callOutcomes.callId,
          set: {
            disposition,
            transcript,
            summary,
            nextAction,
            endedReason,
            updatedAt: new Date(),
          },
        });
      }
      return res.json({ received: true });
    } catch { return res.status(503).json({ error: 'Webhook storage unavailable' }); }
  });
  return router;
}
