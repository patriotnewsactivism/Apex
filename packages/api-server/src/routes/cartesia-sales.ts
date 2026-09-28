import { Router, type Request } from 'express';
import crypto from 'crypto';
import { and, desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db, callOutcomes, providerEvents, researchedLeads, smsMessages, suppressions } from '@workspace/db';

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
  if (!quote || /\b(?:do\s+not|don't|dont)\s+want\s+(?:you\s+to\s+)?(?:stop|quit)\b/i.test(quote)) return false;
  return /\b(?:stop|quit)\s+(?:calling|contacting|texting|messaging)\b|\b(?:do\s+not|don't|dont|never)\s+(?:call|contact|text|message)\s+(?:me|us|again)\b|\bremove\s+(?:me|us)\s+from\b|\btake\s+(?:me|us)\s+off\b|\b(?:unsubscribe|opt\s*out)\b|\bput\s+(?:me|us)\s+on\s+(?:the\s+)?do\s+not\s+call\s+list\b/i.test(quote);
}

export function secretMatches(received: unknown, expected: string | undefined): boolean {
  if (typeof received !== 'string' || !expected || !received) return false;
  const actualBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function authorized(req: Request, kind: 'tool' | 'event'): boolean {
  return kind === 'tool'
    ? secretMatches(req.headers.authorization?.replace(/^Bearer\s+/i, ''), process.env.CARTESIA_TOOL_SECRET)
    : secretMatches(req.headers['x-webhook-secret'], process.env.CARTESIA_WEBHOOK_SECRET);
}

const outcomeId = (callId: string) => `cartesia:${callId}`;

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
      if (await isSuppressed(p.phone_number)) return res.status(409).json({ error: 'Contact opted out' });
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
      const url = p.demo_type === 'buildmybot_live_demo' ? 'https://www.buildmybot.app/' : 'https://apexwork.org/';
      const eventId = `demo:${p.call_id}:${p.demo_type}`;
      const [prior] = await db.select({ id: providerEvents.id }).from(providerEvents).where(and(
        eq(providerEvents.provider, 'cartesia'), eq(providerEvents.externalEventId, eventId))).limit(1);
      if (prior) return res.json({ sent: true, already_sent: true, url });
      const text = `As requested, here is ${p.demo_type === 'buildmybot_live_demo' ? 'BuildMyBot' : 'APEX Work Solutions'}: ${url} Reply STOP to opt out.`;
      const response = await fetch('https://api.telnyx.com/v2/messages', { method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: p.phone_number, text }), signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`SMS provider returned ${response.status}`);
      const result = await response.json() as { data?: { id?: string } };
      try {
        const id = crypto.randomUUID();
        await db.insert(smsMessages).values({ id, direction: 'outbound',
          counterpartyNumber: p.phone_number, fromNumber: from, toNumber: p.phone_number,
          body: text, status: 'sent', providerId: result.data?.id, createdByAgentId: AGENT_ID });
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
      const params = call.telephony_params ?? {};
      const phone = params.direction === 'inbound' ? params.from : params.to;
      const [current] = await db.select().from(callOutcomes).where(eq(callOutcomes.callId, outcomeId(event.call_id))).limit(1);
      if (event.type === 'post_call_analysis') {
        if (typeof event.analysis?.summary === 'string') await db.insert(callOutcomes).values({
          id: crypto.randomUUID(), callId: outcomeId(event.call_id), customerNumber: typeof phone === 'string' ? phone : '',
          disposition: 'no_decision', summary: event.analysis.summary.slice(0, 2000), createdByAgentId: AGENT_ID,
        }).onConflictDoUpdate({ target: callOutcomes.callId,
          set: { summary: event.analysis.summary.slice(0, 2000), updatedAt: new Date() } });
      } else {
        // Never overwrite the decision captured by a mid-call tool.
        const transcript = Array.isArray(call.transcript) ? call.transcript
          .map((turn: { role?: string; text?: string }) => `${turn.role ?? 'unknown'}: ${turn.text ?? ''}`).join('\n').slice(0, 50000) : null;
        await db.insert(callOutcomes).values({ id: crypto.randomUUID(), callId: outcomeId(event.call_id),
          customerNumber: typeof phone === 'string' ? phone : '', disposition: event.type === 'call_failed' ? 'failed_to_dial' : 'no_decision',
          transcript, summary: typeof call.summary === 'string' ? call.summary.slice(0, 2000) : current?.summary ?? null,
          endedReason: typeof call.end_reason === 'string' ? call.end_reason : null, createdByAgentId: AGENT_ID,
        }).onConflictDoUpdate({ target: callOutcomes.callId, set: { transcript,
          summary: typeof call.summary === 'string' ? call.summary.slice(0, 2000) : current?.summary ?? null,
          endedReason: typeof call.end_reason === 'string' ? call.end_reason : null, updatedAt: new Date() } });
      }
      return res.json({ received: true });
    } catch { return res.status(503).json({ error: 'Webhook storage unavailable' }); }
  });
  return router;
}
