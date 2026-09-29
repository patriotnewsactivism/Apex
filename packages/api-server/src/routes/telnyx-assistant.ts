import { Router } from 'express';
import crypto from 'crypto';
import { db, researchedLeads, logs, smsMessages, callBridgeSessions, callOutcomes } from '@workspace/db';
import { eq, or, desc } from 'drizzle-orm';
import type { ApexCEO } from '@workspace/agents';
import { assertOutboundAllowed } from '@workspace/core';

// ─── Apex Front Desk — Telnyx AI Assistant tool-calling surface ─────────────
//
// Backs the "Apex Front Desk" Telnyx-hosted AI Assistant (configured directly
// in the Telnyx account, not in this repo — Telnyx owns the voice/STT/LLM/TTS
// loop entirely; this router is only the set of custom actions the assistant
// can take mid-call). Three endpoints:
//
//   POST /dynamic-variables       — Telnyx calls this once at conversation
//                                   start (assistant's dynamic_variables_
//                                   webhook_url) so the greeting/instructions
//                                   can reference a real caller name instead
//                                   of a blank template.
//   POST /tools/take-message      — the assistant's "I'll pass this along"
//                                   action. Creates a real followup goal in
//                                   Apex (ceo.submitGoal), not just a log line
//                                   — a human/agent actually sees it.
//   POST /tools/send-confirmation — sends a fixed-template confirmation by
//                                   email and/or SMS. Deliberately NOT the
//                                   general send_email tool's freeform body:
//                                   this fires from an unsupervised live call
//                                   with no human approving each send, so the
//                                   content is a template Apex generates from
//                                   structured fields (name/reason), never
//                                   text the assistant composed itself.
//   POST /tools/lookup-caller-history — on-demand version of the
//                                   dynamic-variables lookup below. Unlike
//                                   dynamic-variables (which fires once, keyed
//                                   to the number the call connected from),
//                                   the assistant can call this mid-conversation
//                                   when a caller gives a DIFFERENT callback
//                                   number, and it also surfaces recent SMS
//                                   history dynamic-variables never carries.
//
//   POST /events                  — Telnyx AI conversation lifecycle/insight
//                                   webhook. Persists inbound callback history
//                                   (summary, transcript, next action, outcome)
//                                   into call_outcomes for the next contact.
//   POST /sms-inbound             — Telnyx messaging-profile webhook for the
//                                   same number: logs an inbound text and
//                                   opens a followup goal, same as a missed
//                                   call would.
//
// Auth: Telnyx's AI-Assistant webhooks are a different subsystem from the
// Call Control webhooks routes/telnyx-webhook.ts protects with a header
// secret, and it is not confirmed here whether custom headers are
// deliverable on every one of these callback types. A query-string secret is
// used instead because it works unconditionally — the secret lives in the
// URL registered with Telnyx, not in a header Telnyx may or may not forward.
// Rotate by changing TELNYX_ASSISTANT_WEBHOOK_SECRET and re-saving the
// assistant/messaging-profile config with the new URL.
//
// NOTE ON PAYLOAD SHAPES: Telnyx's exact request body for dynamic-variables
// and assistant tool calls could not be fully confirmed against documentation
// in this environment. Every parser below is deliberately tolerant (several
// plausible field-name variants) and every request is logged with its full
// raw body on first receipt so the real shape can be confirmed and any dead
// branches trimmed after the first live call.

const CALLER_NAME_GOAL_PRIORITY_URGENT = 1;
const CALLER_NAME_GOAL_PRIORITY_NORMAL = 3;

function verifyAssistantKey(query: Record<string, unknown>): boolean {
  const secret = process.env.TELNYX_ASSISTANT_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Telnyx Assistant] TELNYX_ASSISTANT_WEBHOOK_SECRET is not configured; rejecting request.');
    return false;
  }
  const received = typeof query.key === 'string' ? query.key : '';
  if (!received || received.length !== secret.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(secret));
  } catch {
    return false;
  }
}

/** Digits-only comparison so +1 vs no-plus, spaces, and dashes never cause a
 *  known caller to look unrecognized. Exported for direct guard testing. */
export function normalizePhone(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
}

/** Best-effort extraction of the caller's number across the field names this
 *  could plausibly arrive under (see NOTE ON PAYLOAD SHAPES above). Exported
 *  for direct guard testing. */
export function extractCallerNumber(body: Record<string, unknown>): string {
  const data = body.data as Record<string, unknown> | undefined;
  const dataPayload = data?.payload as Record<string, unknown> | undefined;
  const payload = body.payload as Record<string, unknown> | undefined;
  const call = body.call as Record<string, unknown> | undefined;
  const candidates = [
    dataPayload?.telnyx_end_user_target,
    dataPayload?.end_user_target,
    dataPayload?.from,
    dataPayload?.caller_number,
    payload?.telnyx_end_user_target,
    payload?.end_user_target,
    body.telnyx_end_user_target,
    body.end_user_target,
    body.from,
    body.caller_number,
    call?.from,
    payload?.from,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function extractCallControlId(body: Record<string, unknown>): string {
  const data = body.data as Record<string, unknown> | undefined;
  const dataPayload = data?.payload as Record<string, unknown> | undefined;
  const payload = body.payload as Record<string, unknown> | undefined;
  const candidates = [
    dataPayload?.call_control_id,
    payload?.call_control_id,
    body.call_control_id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function firstNameFrom(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed || /^first\s+name$/i.test(trimmed)) return 'there';
  return trimmed.split(/\s+/)[0] || 'there';
}

function agentDisplayName(agentId: string | null | undefined): string {
  if (!agentId) return 'Don';
  if (agentId === 'apex-sales-cartesia' || agentId === 'apex-sales-001' || agentId === 'apex-front-desk') return 'Don';
  return agentId
    .replace(/^apex-/, '')
    .replace(/-\d+$/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Don';
}

function dispositionLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    appointment_booked: 'appointment booked',
    qualified: 'qualified opportunity',
    callback_requested: 'callback requested',
    dnc: 'do not contact',
    not_interested: 'not interested',
    voicemail: 'voicemail left',
    no_answer: 'no answer',
    no_decision: 'conversation ended without a final decision',
    failed_to_dial: 'call did not connect',
  };
  return labels[value ?? ''] ?? (value || 'unknown outcome').replace(/_/g, ' ');
}

function recentCallDiscussion(call: typeof callOutcomes.$inferSelect): string {
  const summary = call.summary?.trim();
  if (summary) return summary.slice(0, 900);
  const transcript = call.transcript?.trim();
  if (transcript) return transcript.slice(-900);
  return '';
}

function returningCallerContext(
  call: typeof callOutcomes.$inferSelect,
  firstName: string,
  company: string | null | undefined,
): string {
  const agentName = agentDisplayName(call.createdByAgentId);
  const discussion = recentCallDiscussion(call);
  const lastStep = call.nextAction?.trim() || '';
  const companyPhrase = company ? ` at ${company}` : '';
  const priorResult = dispositionLabel(call.disposition);
  return [
    'RETURNING CALL MODE: this person is calling us inbound after an earlier APEX outreach call.',
    'Do NOT use the outbound cold-call opener, do NOT ask whether you reached them, and do NOT speak as though you placed this call.',
    `Answer warmly as ${agentName}: "Hi ${firstName}, this is ${agentName} with BuildMyBot. Thanks for calling me back."`,
    `You are speaking with ${firstName}${companyPhrase}. The previous call result was: ${priorResult}.`,
    discussion ? `Previous discussion: ${discussion}` : '',
    lastStep ? `Last recorded next step: ${lastStep}` : '',
    call.endedReason ? `Previous call ended because: ${call.endedReason.slice(0, 300)}` : '',
    'Continue naturally from that context. Briefly remind them why we reached out or what the last step was, then listen to why they called back. Do not restart the original pitch from the top unless they ask.',
  ].filter(Boolean).join(' ');
}

function dynamicVariablesForPerson(input: {
  fullName: string;
  callerNumber: string;
  company?: string | null;
  context?: string | null;
  knownCaller: boolean;
  previousCall?: typeof callOutcomes.$inferSelect | null;
}): Record<string, string> {
  const rawName = input.fullName.trim();
  const fullName = !rawName || /^first\s+name$/i.test(rawName) ? 'there' : rawName;
  const firstName = firstNameFrom(fullName);
  const previousCall = input.previousCall ?? null;
  const callbackContext = previousCall ? returningCallerContext(previousCall, firstName, input.company) : '';
  return {
    caller_number: input.callerNumber || 'unknown',
    call_direction: 'inbound',
    is_known_caller: String(input.knownCaller),
    is_returning_caller: String(Boolean(previousCall)),
    first_name: firstName,
    customer_name: firstName,
    full_name: fullName,
    caller_name: fullName,
    caller_company: input.company ?? '',
    returning_agent_name: previousCall ? agentDisplayName(previousCall.createdByAgentId) : 'Don',
    previous_call_disposition: previousCall?.disposition ?? '',
    previous_call_summary: previousCall ? recentCallDiscussion(previousCall) : '',
    previous_call_next_action: previousCall?.nextAction ?? '',
    previous_call_ended_reason: previousCall?.endedReason ?? '',
    previous_call_at: previousCall?.updatedAt?.toISOString() ?? '',
    caller_context: [callbackContext, input.context ?? ''].filter(Boolean).join(' '),
  };
}

/** Telnyx wraps a function-call's arguments per the OpenAI-aligned assistant
 *  API convention; tolerate either the wrapped or the flat shape. */
function extractToolArgs(body: Record<string, unknown>): Record<string, unknown> {
  const wrapped = body.arguments;
  if (wrapped && typeof wrapped === 'object') return wrapped as Record<string, unknown>;
  return body;
}

async function findKnownCaller(phone: string) {
  if (!phone) return null;
  const norm = normalizePhone(phone);
  if (norm.length < 7) return null;
  const variants = [...new Set([phone, norm, norm.length === 10 ? `+1${norm}` : '', norm.length === 10 ? `1${norm}` : ''].filter(Boolean))];
  const candidates = await db
    .select()
    .from(researchedLeads)
    .where(or(...variants.map((value) => eq(researchedLeads.contactPhone, value))))
    .limit(10);
  return candidates.find((candidate) => normalizePhone(candidate.contactPhone) === norm) ?? null;
}

async function findRecentCallHistory(phone: string, limit = 5) {
  if (!phone) return [];
  const norm = normalizePhone(phone);
  if (norm.length < 7) return [];
  const variants = [...new Set([phone, norm, norm.length === 10 ? `+1${norm}` : '', norm.length === 10 ? `1${norm}` : ''].filter(Boolean))];
  const rows = await db
    .select()
    .from(callOutcomes)
    .where(or(...variants.map((value) => eq(callOutcomes.customerNumber, value))))
    .orderBy(desc(callOutcomes.updatedAt))
    .limit(limit * 3);
  return rows.filter((row) => normalizePhone(row.customerNumber) === norm).slice(0, limit);
}

function memoryPhone(phone: string): string {
  const trimmed = phone.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const norm = normalizePhone(trimmed);
  return norm.length === 10 ? `+1${norm}` : trimmed;
}

function dynamicVariableEnvelope(
  dynamicVariables: Record<string, string>,
  callerNumber: string,
  metadata: Record<string, string> = {},
) {
  const e164 = memoryPhone(callerNumber);
  return {
    dynamic_variables: dynamicVariables,
    ...(e164
      ? {
          memory: {
            // Telnyx native conversation memory: automatically bring the last
            // five calls from this same caller into the next inbound callback.
            conversation_query: `metadata->telnyx_end_user_target=eq.${e164}&limit=5&order=last_message_at.desc`,
          },
          conversation: {
            metadata: {
              apex_caller_number: e164,
              apex_call_direction: 'inbound',
              ...metadata,
            },
          },
        }
      : {}),
  };
}

function telnyxEventData(body: Record<string, unknown>): Record<string, any> {
  const data = body.data;
  if (data && typeof data === 'object') return data as Record<string, any>;
  return body as Record<string, any>;
}

function telnyxCallOutcomeId(payload: Record<string, any>): string | null {
  const raw = payload.call_control_id || payload.call_session_id || payload.conversation_id;
  return typeof raw === 'string' && raw.trim() ? `telnyx-ai:${raw.trim()}` : null;
}

function stringifyInsightResult(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function flattenInsightText(results: unknown): string {
  if (!Array.isArray(results)) return '';
  return results
    .map((item) => {
      if (!item || typeof item !== 'object') return stringifyInsightResult(item);
      const result = (item as Record<string, unknown>).result;
      return stringifyInsightResult(result);
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

function extractNamedInsight(results: unknown, keys: RegExp): string | null {
  if (!Array.isArray(results)) return null;
  const walk = (value: unknown, depth = 0): string | null => {
    if (depth > 4 || value == null) return null;
    if (typeof value === 'string') return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = walk(entry, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (keys.test(key) && (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean')) {
        return String(child).trim().slice(0, 2000);
      }
      const nested = walk(child, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  return walk(results);
}

export function inferInboundDisposition(insightText: string, prior: string | null | undefined): string {
  if (prior && prior !== 'no_decision') return prior;
  const text = insightText.toLowerCase();
  if (/appointment.{0,30}(booked|scheduled|confirmed)|meeting.{0,30}(booked|scheduled|confirmed)/.test(text)) return 'appointment_booked';
  if (/callback requested|call back (?:later|tomorrow|next)|asked (?:us|me) to call back/.test(text)) return 'callback_requested';
  if (/not interested|declined|no interest|does not want/.test(text)) return 'not_interested';
  if (/qualified|good fit|strong fit|sales qualified/.test(text)) return 'qualified';
  return 'no_decision';
}

function normalizeConversationMessages(payload: unknown): Array<{ role: string; text: string }> {
  const root = payload as Record<string, any> | null;
  const candidates = [
    root?.data,
    root?.messages,
    root?.items,
    root?.data?.messages,
    root?.data?.items,
  ];
  const rows = candidates.find(Array.isArray) as unknown[] | undefined;
  if (!rows) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const item = row as Record<string, any>;
      const role = typeof item.role === 'string' ? item.role : typeof item.sender === 'string' ? item.sender : 'unknown';
      const text = typeof item.content === 'string'
        ? item.content
        : typeof item.text === 'string'
          ? item.text
          : typeof item.message === 'string'
            ? item.message
            : '';
      return text.trim() ? { role, text: text.trim() } : null;
    })
    .filter((row): row is { role: string; text: string } => Boolean(row));
}

async function telnyxApiGet(path: string): Promise<unknown | null> {
  const key = process.env.TELNYX_API_KEY?.trim();
  if (!key) return null;
  try {
    const response = await fetch(`https://api.telnyx.com/v2/${path.replace(/^\//, '')}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`[Telnyx Assistant] GET /${path} returned HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn('[Telnyx Assistant] Telnyx conversation enrichment failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function enrichInboundConversation(input: {
  outcomeCallId: string;
  conversationId?: string | null;
  results?: unknown;
}): Promise<void> {
  try {
    const [existing] = await db.select().from(callOutcomes).where(eq(callOutcomes.callId, input.outcomeCallId)).limit(1);
    if (!existing) return;

    let resultPayload = input.results;
    let transcript: string | null = existing.transcript ?? null;

    if (input.conversationId) {
      const [messagesResponse, insightsResponse] = await Promise.all([
        telnyxApiGet(`ai/conversations/${encodeURIComponent(input.conversationId)}/messages`),
        telnyxApiGet(`ai/conversations/${encodeURIComponent(input.conversationId)}/conversations-insights`),
      ]);

      const messages = normalizeConversationMessages(messagesResponse);
      if (messages.length > 0) {
        transcript = messages.map((message) => `${message.role}: ${message.text}`).join('\n').slice(0, 50000);
      }

      if (!resultPayload && insightsResponse) {
        const root = insightsResponse as Record<string, any>;
        resultPayload = root?.data ?? root?.results ?? root;
      }
    }

    const insightText = flattenInsightText(resultPayload);
    const explicitSummary = extractNamedInsight(resultPayload, /summary|conversation_summary|call_summary/i);
    const explicitNextAction = extractNamedInsight(resultPayload, /next.?action|next.?step|follow.?up/i);
    const explicitOutcome = extractNamedInsight(resultPayload, /disposition|outcome|result|status/i);
    const summary = (explicitSummary || insightText || existing.summary || 'Inbound callback completed.').slice(0, 2000);
    const nextAction = (explicitNextAction || existing.nextAction || 'Review the callback and continue from the recorded conversation context.').slice(0, 1000);
    const disposition = inferInboundDisposition([explicitOutcome, insightText, summary].filter(Boolean).join(' '), existing.disposition);

    await db.update(callOutcomes).set({
      disposition,
      transcript,
      summary,
      nextAction,
      updatedAt: new Date(),
    }).where(eq(callOutcomes.callId, input.outcomeCallId));

    await db.insert(logs).values({
      agentId: existing.createdByAgentId ?? 'apex-front-desk',
      taskId: null,
      level: 'acting',
      message: `📝 Inbound call history updated for ${existing.customerName ?? existing.customerNumber}: ${dispositionLabel(disposition)} — ${summary.slice(0, 220)}`,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('[Telnyx Assistant] inbound post-call enrichment failed:', err instanceof Error ? err.message : String(err));
  }
}


export async function processTelnyxAssistantLifecycleEvent(eventInput: Record<string, any>): Promise<{
  received: true;
  recorded?: boolean;
  ignored?: boolean;
  reason?: string;
  eventType?: string | null;
  callId?: string;
}> {
  try {
    const event = telnyxEventData(eventInput);
    const eventType = typeof event.event_type === 'string' ? event.event_type : '';
    const payload = event.payload && typeof event.payload === 'object'
      ? event.payload as Record<string, any>
      : eventInput;

    if (!['call.conversation.ended', 'call.conversation_insights.generated'].includes(eventType)) {
      return { received: true, ignored: true, eventType: eventType || null };
    }

    const callId = telnyxCallOutcomeId(payload);
    if (!callId) {
      console.warn('[Telnyx Assistant] post-call event missing call/conversation identifier', { eventType });
      return { received: true, ignored: true, reason: 'missing_call_id' };
    }

    if (eventType === 'call.conversation.ended') {
      const callerNumber = typeof payload.from === 'string' ? payload.from : '';
      const [lead, priorCalls] = await Promise.all([
        findKnownCaller(callerNumber),
        findRecentCallHistory(callerNumber, 5),
      ]);
      const previousOutbound = priorCalls.find((row) => !row.callId.startsWith('telnyx-ai:')) ?? priorCalls[0] ?? null;
      const name = lead?.decisionMakerName?.trim() || previousOutbound?.customerName?.trim() || lead?.companyName || null;
      const handlingAgentId = previousOutbound?.createdByAgentId ?? 'apex-front-desk';
      const duration = typeof payload.duration_sec === 'number' ? payload.duration_sec : null;
      const reason = typeof payload.reason === 'string' ? payload.reason : null;

      await db.insert(callOutcomes).values({
        id: crypto.randomUUID(),
        callId,
        leadId: lead?.id ?? previousOutbound?.leadId ?? null,
        customerNumber: callerNumber || previousOutbound?.customerNumber || 'unknown',
        customerName: name,
        disposition: 'no_decision',
        summary: duration != null ? `Inbound callback completed after ${duration} seconds.` : 'Inbound callback completed.',
        nextAction: 'Post-call conversation enrichment pending.',
        endedReason: reason,
        createdByAgentId: handlingAgentId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: callOutcomes.callId,
        set: {
          leadId: lead?.id ?? previousOutbound?.leadId ?? null,
          customerNumber: callerNumber || previousOutbound?.customerNumber || 'unknown',
          customerName: name,
          endedReason: reason,
          updatedAt: new Date(),
        },
      });

      await db.insert(logs).values({
        agentId: handlingAgentId,
        taskId: null,
        level: 'acting',
        message: `📞 Inbound callback completed from ${(name ?? callerNumber) || 'unknown caller'}${duration != null ? ` (${duration}s)` : ''}. Post-call transcript/insight enrichment queued.`,
        timestamp: new Date(),
      });

      void enrichInboundConversation({
        outcomeCallId: callId,
        conversationId: typeof payload.conversation_id === 'string' ? payload.conversation_id : null,
      });

      return { received: true, recorded: true, callId };
    }

    const results = payload.results;
    const [existing] = await db.select().from(callOutcomes).where(eq(callOutcomes.callId, callId)).limit(1);
    if (!existing) {
      await db.insert(callOutcomes).values({
        id: crypto.randomUUID(),
        callId,
        customerNumber: 'unknown',
        disposition: 'no_decision',
        summary: 'Inbound call insights received.',
        nextAction: 'Review generated call insights.',
        createdByAgentId: 'apex-front-desk',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoNothing();
    }
    void enrichInboundConversation({ outcomeCallId: callId, results });
    return { received: true, recorded: true, callId };
  } catch (err) {
    console.error('[Telnyx Assistant] post-call event error:', err instanceof Error ? err.message : String(err));
    return { received: true, recorded: false };
  }
}

export function createTelnyxAssistantRouter(ceo: ApexCEO): Router {
  const router = Router();

  // ── POST /dynamic-variables ─────────────────────────────────────────────
  router.post('/dynamic-variables', async (req, res) => {
    if (!verifyAssistantKey(req.query as Record<string, unknown>)) {
      return res.status(403).json({ error: 'Invalid or missing key' });
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const callerNumber = extractCallerNumber(body);
      const callControlId = extractCallControlId(body);
      const ownerNumber = process.env.TELNYX_OWNER_NUMBER ?? '';
      if (callerNumber && ownerNumber && normalizePhone(callerNumber) === normalizePhone(ownerNumber)) {
        console.log('[Telnyx Assistant] dynamic-variables request', {
          callerNumber,
          callControlId: callControlId || null,
          knownCaller: true,
          ownerSelfTest: true,
        });
        return res.json(dynamicVariableEnvelope(
          dynamicVariablesForPerson({
            fullName: 'Matthew Reardon',
            callerNumber,
            company: 'BuildMyBot / APEX',
            context: 'Owner-requested internal self-pitch test. Use the name Matthew Reardon. Never use Sam.',
            knownCaller: true,
          }),
          callerNumber,
          { apex_known_caller: 'true', apex_returning_agent: 'Don', apex_owner_self_test: 'true' },
        ));
      }

      if (callControlId) {
        const [bridgeSession] = await db
          .select()
          .from(callBridgeSessions)
          .where(or(eq(callBridgeSessions.customerCallControlId, callControlId), eq(callBridgeSessions.aiCallControlId, callControlId)))
          .limit(1);
        if (bridgeSession?.buyerName) {
          console.log('[Telnyx Assistant] dynamic-variables request', {
            callerNumber: callerNumber || '(none found in payload)',
            callControlId,
            knownCaller: true,
            callBridgeSession: bridgeSession.id,
          });
          const resolvedNumber = callerNumber || bridgeSession.customerNumber;
          return res.json(dynamicVariableEnvelope(
            dynamicVariablesForPerson({
              fullName: bridgeSession.buyerName,
              callerNumber: resolvedNumber,
              company: bridgeSession.operatorNumber === bridgeSession.customerNumber ? 'BuildMyBot / APEX' : '',
              context: bridgeSession.operatorNumber === bridgeSession.customerNumber
                ? 'Owner-requested internal self-pitch test. Use the saved buyer name. Never use Sam.'
                : '',
              knownCaller: true,
            }),
            resolvedNumber,
            { apex_known_caller: 'true', apex_bridge_session_id: bridgeSession.id },
          ));
        }
      }

      const [lead, recentCalls] = await Promise.all([
        findKnownCaller(callerNumber),
        findRecentCallHistory(callerNumber, 5),
      ]);
      const previousCall = recentCalls[0] ?? null;

      console.log('[Telnyx Assistant] dynamic-variables request', {
        callerNumber: callerNumber || '(none found in payload)',
        callControlId: callControlId || null,
        knownCaller: Boolean(lead || previousCall),
        returningCaller: Boolean(previousCall),
        previousDisposition: previousCall?.disposition ?? null,
      });

      if (lead || previousCall) {
        const name = lead?.decisionMakerName?.trim() || previousCall?.customerName?.trim() || lead?.companyName || 'there';
        if (previousCall) {
          await db.insert(logs).values({
            agentId: 'apex-front-desk',
            taskId: null,
            level: 'acting',
            message: `↩️ Inbound callback recognized from ${name} (${callerNumber || previousCall.customerNumber}). Previous result: ${dispositionLabel(previousCall.disposition)}. Resuming with ${agentDisplayName(previousCall.createdByAgentId)}.`,
            timestamp: new Date(),
          });
        }
        const resolvedNumber = callerNumber || previousCall?.customerNumber || '';
        const returningAgent = previousCall ? agentDisplayName(previousCall.createdByAgentId) : 'Don';
        return res.json(dynamicVariableEnvelope(
          dynamicVariablesForPerson({
            fullName: name,
            callerNumber: resolvedNumber,
            company: lead?.companyName ?? null,
            context: lead?.outreachAngle ?? null,
            knownCaller: true,
            previousCall,
          }),
          resolvedNumber,
          {
            apex_known_caller: 'true',
            apex_returning_caller: String(Boolean(previousCall)),
            apex_returning_agent: returningAgent,
            apex_lead_id: lead?.id ?? previousCall?.leadId ?? '',
          },
        ));
      }

      return res.json(dynamicVariableEnvelope(
        {
          caller_number: callerNumber || 'unknown',
          call_direction: 'inbound',
          is_known_caller: 'false',
          is_returning_caller: 'false',
          first_name: 'there',
          customer_name: 'there',
          full_name: 'there',
          caller_name: 'there',
          caller_company: '',
          returning_agent_name: 'Don',
          previous_call_disposition: '',
          previous_call_summary: '',
          previous_call_next_action: '',
          previous_call_ended_reason: '',
          previous_call_at: '',
          caller_context: 'This is an inbound call. Greet the caller as an inbound caller and ask how you can help; never use an outbound cold-call opener.',
        },
        callerNumber,
        { apex_known_caller: 'false', apex_returning_caller: 'false', apex_returning_agent: 'Don' },
      ));
    } catch (err) {
      console.error('[Telnyx Assistant] dynamic-variables error:', err instanceof Error ? err.message : String(err));
      // A blank variable set beats failing conversation start entirely.
      return res.json({ dynamic_variables: { caller_number: '', is_known_caller: 'false' } });
    }
  });

  // ── POST /events — inbound conversation lifecycle + insights ───────────
  router.post('/events', async (req, res) => {
    if (!verifyAssistantKey(req.query as Record<string, unknown>)) {
      return res.status(403).json({ error: 'Invalid or missing key' });
    }
    const result = await processTelnyxAssistantLifecycleEvent((req.body ?? {}) as Record<string, any>);
    return res.status(200).json(result);
  });

  // ── POST /tools/take-message ────────────────────────────────────────────
  router.post('/tools/take-message', async (req, res) => {
    if (!verifyAssistantKey(req.query as Record<string, unknown>)) {
      return res.status(403).json({ error: 'Invalid or missing key' });
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const args = extractToolArgs(body);
      const callerNumber = extractCallerNumber(body);

      const callerName = typeof args.callerName === 'string' && args.callerName.trim() ? args.callerName.trim() : 'Unknown caller';
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : '(no reason captured)';
      const callbackNumber = typeof args.callbackNumber === 'string' && args.callbackNumber.trim()
        ? args.callbackNumber.trim()
        : callerNumber || 'not provided';
      const urgent = args.urgency === 'urgent';

      const title = `Front desk message: ${callerName}`;
      const description = [
        `A caller reached the Apex front desk AI assistant and asked for a followup.`,
        `Caller: ${callerName} (callback: ${callbackNumber}).`,
        `What they need: ${reason}`,
        urgent ? 'Caller described this as urgent.' : '',
        `Follow up directly — this did not go through any qualification beyond what the caller stated.`,
      ].filter(Boolean).join(' ');

      const goalId = await ceo.submitGoal(title, description, urgent ? CALLER_NAME_GOAL_PRIORITY_URGENT : CALLER_NAME_GOAL_PRIORITY_NORMAL);

      await db.insert(logs).values({
        agentId: 'apex-front-desk',
        taskId: null,
        level: 'acting',
        message: `📞 Front desk took a message from ${callerName} (${callbackNumber}): ${reason.slice(0, 200)}`,
        timestamp: new Date(),
      });

      return res.json({
        result: {
          success: true,
          goalId,
          message: `Got it — I've logged this and someone will follow up with you at ${callbackNumber}.`,
        },
      });
    } catch (err) {
      console.error('[Telnyx Assistant] take-message error:', err instanceof Error ? err.message : String(err));
      return res.status(500).json({
        result: {
          success: false,
          message: `I wasn't able to log that just now, but I've noted it — please also try emailing if this is urgent.`,
        },
      });
    }
  });

  // ── POST /tools/send-confirmation ───────────────────────────────────────
  // Fixed-template only — see file header for why this doesn't take freeform
  // content from the assistant.
  router.post('/tools/send-confirmation', async (req, res) => {
    if (!verifyAssistantKey(req.query as Record<string, unknown>)) {
      return res.status(403).json({ error: 'Invalid or missing key' });
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const args = extractToolArgs(body);
      const callerNumber = extractCallerNumber(body);

      const contactName = typeof args.contactName === 'string' && args.contactName.trim() ? args.contactName.trim() : 'there';
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'your call to Apex';
      const toEmail = typeof args.toEmail === 'string' && args.toEmail.trim() ? args.toEmail.trim() : '';
      const toPhoneRaw = typeof args.toPhone === 'string' && args.toPhone.trim() ? args.toPhone.trim() : callerNumber;
      const channel = args.channel === 'email' || args.channel === 'sms' || args.channel === 'both' ? args.channel : 'both';

      const sentVia: string[] = [];
      const errors: string[] = [];

      if ((channel === 'email' || channel === 'both') && toEmail) {
        const { getToolRegistry } = await import('@workspace/core');
        const registry = getToolRegistry(process.env.WORKSPACE_ROOT ?? process.cwd());
        const html = `<p>Hi ${contactName},</p><p>Thanks for calling Apex. This confirms we received your message about: ${reason}.</p><p>Someone will follow up with you shortly.</p><p>— Apex Front Desk</p>`;
        try {
          const result = await registry.execute(
            'send_email',
            { toEmail, toName: contactName === 'there' ? undefined : contactName, subject: 'Apex — we received your message', html },
            { agentId: 'apex-front-desk', workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd(), requestApproval: async () => true },
          );
          if (result && typeof result === 'object' && 'success' in result && (result as { success?: boolean }).success === false) {
            errors.push(`email: ${(result as { error?: string }).error ?? 'unknown error'}`);
          } else {
            sentVia.push('email');
          }
        } catch (err) {
          errors.push(`email: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if ((channel === 'sms' || channel === 'both') && toPhoneRaw) {
        const normalized = toPhoneRaw.replace(/[\s()-]/g, '');
        const toPhone = normalized.startsWith('+') ? normalized : `+1${normalized.replace(/\D/g, '')}`;
        const apiKey = process.env.TELNYX_API_KEY;
        const from = process.env.APEX_FRONT_DESK_NUMBER;
        if (!apiKey || !from) {
          errors.push('sms: TELNYX_API_KEY or APEX_FRONT_DESK_NUMBER not configured');
        } else {
          const text = `Apex: thanks for calling — we received your message about "${reason}" and will follow up soon.`;
          try {
            await assertOutboundAllowed({
              channel: 'sms',
              destination: toPhone,
              purpose: 'front_desk_confirmation',
            });
            const smsRes = await fetch('https://api.telnyx.com/v2/messages', {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from, to: toPhone, text }),
            });
            if (!smsRes.ok) {
              errors.push(`sms: Telnyx returned ${smsRes.status}`);
            } else {
              sentVia.push('sms');
            }
            await db.insert(smsMessages).values({
              id: crypto.randomUUID(),
              direction: 'outbound',
              counterpartyNumber: toPhone,
              fromNumber: from,
              toNumber: toPhone,
              body: text,
              status: smsRes.ok ? 'sent' : 'failed',
              errorMessage: smsRes.ok ? null : `Telnyx returned ${smsRes.status}`,
              createdByAgentId: 'apex-front-desk',
              createdAt: new Date(),
            });
          } catch (err) {
            errors.push(`sms: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      await db.insert(logs).values({
        agentId: 'apex-front-desk',
        taskId: null,
        level: errors.length > 0 && sentVia.length === 0 ? 'error' : 'acting',
        message: `📧 Front desk confirmation to ${contactName} — sent via [${sentVia.join(', ') || 'none'}]${errors.length ? `, errors: ${errors.join('; ')}` : ''}`,
        timestamp: new Date(),
      });

      return res.json({
        result: {
          success: sentVia.length > 0,
          sentVia,
          message: sentVia.length > 0
            ? `Confirmation sent via ${sentVia.join(' and ')}.`
            : `I wasn't able to send that confirmation right now.`,
        },
      });
    } catch (err) {
      console.error('[Telnyx Assistant] send-confirmation error:', err instanceof Error ? err.message : String(err));
      return res.status(500).json({ result: { success: false, message: `I wasn't able to send that confirmation right now.` } });
    }
  });

  // ── POST /tools/lookup-caller-history ───────────────────────────────────
  // See file header for why this exists alongside dynamic-variables rather
  // than replacing it.
  router.post('/tools/lookup-caller-history', async (req, res) => {
    if (!verifyAssistantKey(req.query as Record<string, unknown>)) {
      return res.status(403).json({ error: 'Invalid or missing key' });
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const args = extractToolArgs(body);
      const phone = typeof args.phoneNumber === 'string' && args.phoneNumber.trim()
        ? args.phoneNumber.trim()
        : extractCallerNumber(body);

      const norm = normalizePhone(phone);
      if (norm.length < 7) {
        return res.json({ result: { found: false, message: 'No usable phone number to look up.' } });
      }
      const e164 = norm.length === 10 ? `+1${norm}` : phone;

      const [lead, recentMessages, recentCalls] = await Promise.all([
        findKnownCaller(phone),
        db
          .select({ direction: smsMessages.direction, body: smsMessages.body, createdAt: smsMessages.createdAt })
          .from(smsMessages)
          .where(or(eq(smsMessages.counterpartyNumber, phone), eq(smsMessages.counterpartyNumber, e164)))
          .orderBy(desc(smsMessages.createdAt))
          .limit(5),
        findRecentCallHistory(phone, 5),
      ]);

      return res.json({
        result: {
          found: Boolean(lead) || recentMessages.length > 0 || recentCalls.length > 0,
          isKnownLead: Boolean(lead),
          isReturningCaller: recentCalls.length > 0,
          leadCompany: lead?.companyName ?? null,
          leadContext: lead?.outreachAngle ?? null,
          leadStatus: lead?.status ?? null,
          callbackContext: recentCalls[0]
            ? returningCallerContext(
                recentCalls[0],
                firstNameFrom(lead?.decisionMakerName?.trim() || recentCalls[0].customerName?.trim() || lead?.companyName || 'there'),
                lead?.companyName,
              )
            : null,
          recentCalls: recentCalls.map((call) => ({
            disposition: call.disposition,
            summary: recentCallDiscussion(call) || null,
            nextAction: call.nextAction,
            endedReason: call.endedReason,
            agentName: agentDisplayName(call.createdByAgentId),
            when: call.updatedAt.toISOString(),
          })),
          recentMessages: recentMessages.map((m) => ({
            direction: m.direction,
            body: m.body.slice(0, 300),
            when: m.createdAt.toISOString(),
          })),
        },
      });
    } catch (err) {
      console.error('[Telnyx Assistant] lookup-caller-history error:', err instanceof Error ? err.message : String(err));
      return res.json({ result: { found: false, message: 'Lookup failed — proceed without history.' } });
    }
  });

  // ── POST /sms-inbound ────────────────────────────────────────────────────
  // Messaging-profile webhook_url for the front-desk number. A text to this
  // number gets the same "someone will see this" treatment as a missed call.
  router.post('/sms-inbound', async (req, res) => {
    if (!verifyAssistantKey(req.query as Record<string, unknown>)) {
      return res.status(403).json({ error: 'Invalid or missing key' });
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const payload = (body.data as Record<string, unknown> | undefined)?.payload as Record<string, unknown> | undefined;
      const fromField = payload?.from;
      const fromPhone = fromField && typeof fromField === 'object'
        ? (fromField as Record<string, unknown>).phone_number
        : fromField;
      const from = typeof fromPhone === 'string' && fromPhone
        ? fromPhone
        : (extractCallerNumber(body) || 'unknown');
      const text = typeof payload?.text === 'string' ? payload.text : '(no text)';
      const toField = payload?.to;
      const toEntry = Array.isArray(toField) ? (toField[0] as Record<string, unknown> | undefined) : undefined;
      const to = typeof toEntry?.phone_number === 'string'
        ? toEntry.phone_number
        : (process.env.APEX_FRONT_DESK_NUMBER ?? 'unknown');

      const goalId = await ceo.submitGoal(
        `Front desk SMS: ${from}`,
        `An inbound text arrived at the Apex front desk number from ${from}: "${text}". Follow up directly.`,
        CALLER_NAME_GOAL_PRIORITY_NORMAL,
      );

      // Persisted separately from the goal/log line above so the Sales
      // Operations SMS thread view has real conversation history to render,
      // not just a one-line summary buried in the agent log stream.
      await db.insert(smsMessages).values({
        id: crypto.randomUUID(),
        direction: 'inbound',
        counterpartyNumber: from,
        fromNumber: from,
        toNumber: to,
        body: text,
        status: 'received',
        createdAt: new Date(),
      });

      await db.insert(logs).values({
        agentId: 'apex-front-desk',
        taskId: null,
        level: 'acting',
        message: `💬 Front desk received SMS from ${from}: ${text.slice(0, 200)}`,
        timestamp: new Date(),
      });

      return res.status(200).json({ received: true, goalId });
    } catch (err) {
      console.error('[Telnyx Assistant] sms-inbound error:', err instanceof Error ? err.message : String(err));
      return res.status(200).json({ received: true });
    }
  });

  return router;
}
