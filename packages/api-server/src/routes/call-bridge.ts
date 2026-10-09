import { Router } from 'express';
import crypto from 'crypto';
import { db, callBridgeSessions } from '@workspace/db';
import { SendBlockedError, assertContactSendable, commitSendRecord } from '@workspace/core';
import { and, eq } from 'drizzle-orm';
import { normalizeE164 } from './sales-ops.js';

// ─── Call Bridge — operator call with live AI takeover ─────────────────────
//
// Bridges the operator's own phone with a customer's via a Telnyx conference,
// so the operator can talk directly, then optionally bring the Apex Front
// Desk AI assistant in as a third live participant who can listen and speak.
// Three Telnyx Call Control legs, each dialed with `conference_config` so
// Telnyx joins it into the same named conference on answer — no separate
// conference-create or join-actions call needed:
//
//   1. POST /start          — dial the operator. Confirmed via webhook
//      (call.answered) before the customer is dialed, so the customer never
//      rings into an empty conference.
//   2. (webhook-driven)      — once the operator answers, dial the customer
//      into the same conference.
//   3. POST /:id/bring-in-ai — dial the Apex Front Desk NUMBER (not a direct
//      "call an assistant" API, which Telnyx does not appear to expose) into
//      the same conference. That number's connection already routes inbound
//      calls to the Apex Front Desk AI Assistant (see telnyx-assistant.ts),
//      so redialing it here reuses a mechanism already confirmed working
//      end-to-end, rather than guessing at an unconfirmed primitive for
//      something this consequential — a live customer call.
//
// The operator's and customer's legs are dialed with
// conference_config.end_conference_on_exit = true, so if either one hangs up
// for ANY reason, Telnyx itself hangs up whichever other legs remain — this
// does not depend on this webhook handler running correctly. The AI leg does
// NOT set that flag: the AI leaving must not end the operator/customer call.
//
// Auth: this file exports two routers with different trust boundaries.
// createCallBridgeRouter() holds the operator-facing control endpoints,
// mounted behind requireAdminAuth like the rest of /api/sales-ops.
// createCallBridgeWebhookRouter() is a pre-auth Telnyx Call Control webhook
// (Telnyx cannot carry a Bearer token) verified by a query-string secret —
// same reasoning as telnyx-assistant.ts: the secret lives in the URL
// registered with Telnyx, not in a header Telnyx may or may not forward.

export type BridgeLegRole = 'operator' | 'customer' | 'ai' | 'monitor' | 'whisper' | 'barge';

const BRIDGE_ROLES = new Set<BridgeLegRole>(['operator', 'customer', 'ai', 'monitor', 'whisper', 'barge']);
export const APPROVED_APEX_OUTBOUND_NUMBER = '+18329757665';
// Hank's newsroom line (CNAM 'ON YOUR SIDE'): approved so bridge legs show the
// newsroom caller ID and the bring-in-ai leg reaches Hank directly.
export const NEWSROOM_BRIDGE_NUMBER = '+13466461352';
const APPROVED_APEX_OUTBOUND_NUMBERS: readonly string[] = [
  APPROVED_APEX_OUTBOUND_NUMBER,
  NEWSROOM_BRIDGE_NUMBER,
];

interface ClientState {
  sessionId: string;
  role: BridgeLegRole;
}

/** Timing-safe query-string secret check. Exported for direct guard testing. */
export function verifyCallBridgeKey(query: Record<string, unknown>): boolean {
  const secret = process.env.TELNYX_CALL_BRIDGE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Call Bridge] TELNYX_CALL_BRIDGE_WEBHOOK_SECRET is not configured; rejecting request.');
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

/** Encode session id + leg role into Telnyx's client_state field (must be
 *  base64). Exported for direct guard testing. */
export function encodeClientState(state: ClientState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

/** Decode and validate client_state from an inbound webhook. Returns null for
 *  anything malformed or not shaped like ours, rather than throwing — a
 *  webhook handler must never crash on a payload it does not recognize.
 *  Exported for direct guard testing. */
export function decodeClientState(raw: unknown): ClientState | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).sessionId === 'string' &&
      BRIDGE_ROLES.has((parsed as Record<string, unknown>).role as BridgeLegRole)
    ) {
      return parsed as unknown as ClientState;
    }
  } catch {
    // Not ours — fall through to null.
  }
  return null;
}

function extractTranscript(payload: Record<string, unknown>): string {
  const nested = payload.transcription_data as Record<string, unknown> | undefined;
  const candidates = [payload.transcript, nested?.transcript, nested?.text, payload.text];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}

function firstNameFromDisplayName(name: string | null | undefined): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || /^first\s+name$/i.test(trimmed)) return 'there';
  return trimmed.split(/\s+/)[0] || 'there';
}

function sanitizeAssistantCopy(text: string, firstName: string): string {
  return text
    .replace(/\{\{\s*first_?name\s*\}\}/gi, firstName)
    .replace(/\bFIRST\s+NAME\b/g, firstName)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function assistantDynamicVariablesForSession(session: typeof callBridgeSessions.$inferSelect): Record<string, string> {
  const rawName = session.buyerName?.trim() || '';
  const fullName = !rawName || /^first\s+name$/i.test(rawName) ? 'there' : rawName;
  const firstName = firstNameFromDisplayName(fullName);
  const selfTest = session.operatorNumber === session.customerNumber;
  return {
    first_name: firstName,
    customer_name: firstName,
    full_name: fullName,
    caller_name: fullName,
    company_name: selfTest ? 'BuildMyBot / APEX' : '',
    call_context: selfTest
      ? 'Owner-requested internal self-pitch test. Use the saved buyer name. Never use Sam. Do not pretend they called you first.'
      : 'Outbound BuildMyBot sales call.',
    requested_first_message: sanitizeAssistantCopy(session.assistantGreeting ?? '', firstName),
  };
}

export function configuredApexOutboundNumber(): string | null {
  const normalized = normalizeE164(process.env.APEX_FRONT_DESK_NUMBER);
  return APPROVED_APEX_OUTBOUND_NUMBERS.includes(normalized) ? normalized : null;
}

function callBridgeWebhookUrl(): string {
  const publicUrl = process.env.PUBLIC_URL ?? 'https://apex.donmatthews.live';
  const secret = process.env.TELNYX_CALL_BRIDGE_WEBHOOK_SECRET ?? '';
  return `${publicUrl}/api/telnyx-assistant/call-bridge-webhook?key=${encodeURIComponent(secret)}`;
}

/** Originate one outbound call leg and join it into the session's conference.
 *  Exported for direct guard testing of its request-shape logic; the network
 *  call itself is not exercised in CI (no live Telnyx account). */
export async function dialBridgeLeg(params: {
  to: string;
  role: ClientState['role'];
  sessionId: string;
  endConferenceOnExit: boolean;
  supervisorRole?: 'monitor' | 'whisper' | 'barge';
  whisperCallControlIds?: string[];
  sendJobId?: string | null;
}): Promise<{ callControlId: string } | { error: string; awaitingSafeguard?: boolean; sendJobId?: string }> {
  const apiKey = process.env.TELNYX_API_KEY;
  const connectionId = process.env.TELNYX_CALL_BRIDGE_CONNECTION_ID;
  const from = configuredApexOutboundNumber();
  if (!apiKey || !connectionId || !from) {
    return { error: `TELNYX_API_KEY, TELNYX_CALL_BRIDGE_CONNECTION_ID, and APEX_FRONT_DESK_NUMBER=${APPROVED_APEX_OUTBOUND_NUMBER} are required for outbound Telnyx calls.` };
  }
  const { assertSendAllowed, openOutboundSendJob, recordOutboundSendResult, SendSafeguardError } = await import('@workspace/core');
  let sendJobId = params.sendJobId ?? null;
  let recipientId: string | null = null;
  try {
    if (!sendJobId) {
      const opened = await openOutboundSendJob({
        caller: 'tool',
        createdBy: 'call-bridge',
        recipients: [{
          channel: 'phone',
          destination: params.to,
          messageText: `Bridge ${params.role} for session ${params.sessionId}`,
          payload: {
            kind: 'telnyx_call',
            role: params.role,
            sessionId: params.sessionId,
            endConferenceOnExit: params.endConferenceOnExit,
            ...(params.supervisorRole ? { supervisorRole: params.supervisorRole } : {}),
            ...(params.whisperCallControlIds?.length ? { whisperCallControlIds: params.whisperCallControlIds } : {}),
          },
        }],
      });
      sendJobId = opened.jobId;
    }
    const cleared = await assertSendAllowed(sendJobId, params.to, 'phone');
    recipientId = cleared.id;
  } catch (error) {
    if (error instanceof SendSafeguardError) {
      return { error: 'Nothing was sent. Clear this send in Pending sends.', awaitingSafeguard: true, sendJobId: error.jobId ?? sendJobId ?? undefined };
    }
    return { error: 'Send safeguard failed closed.' };
  }
  if (!sendJobId || !recipientId) {
    return { error: 'Send safeguard failed closed.' };
  }
  try {
    const res = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_id: connectionId,
        from,
        to: params.to,
        webhook_url: callBridgeWebhookUrl(),
        client_state: encodeClientState({ sessionId: params.sessionId, role: params.role }),
        timeout_secs: 30,
        conference_config: {
          conference_name: params.sessionId,
          early_media: false,
          // A supervisor hanging up must not tear down the buyer's call.
          end_conference_on_exit: params.supervisorRole ? false : params.endConferenceOnExit,
          ...(params.supervisorRole ? { supervisor_role: params.supervisorRole } : {}),
          ...(params.supervisorRole === 'whisper' && params.whisperCallControlIds?.length
            ? { whisper_call_control_ids: params.whisperCallControlIds }
            : {}),
        },
      }),
    });
    const json = (await res.json().catch(() => null)) as
      | { data?: { call_control_id?: string }; errors?: Array<{ detail?: string }> }
      | null;
    if (!res.ok) {
      if (recipientId) await recordOutboundSendResult(sendJobId, recipientId, 'failed', null);
      return { error: json?.errors?.[0]?.detail ?? `Telnyx returned ${res.status}` };
    }
    const callControlId = json?.data?.call_control_id;
    if (!callControlId) {
      if (recipientId) await recordOutboundSendResult(sendJobId, recipientId, 'failed', null);
      return { error: 'Telnyx accepted the dial but did not return a call_control_id.' };
    }
    if (recipientId) await recordOutboundSendResult(sendJobId, recipientId, 'sent', callControlId);
    return { callControlId };
  } catch (err) {
    if (recipientId) await recordOutboundSendResult(sendJobId, recipientId, 'failed', null);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Best-effort hangup for the operator-initiated "End call" action. Failures
 *  are logged, never thrown — cleanup must not fail the request that asked
 *  for it, and a leg that is already down is not an error worth surfacing. */
async function hangupBridgeLeg(callControlId: string): Promise<void> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return;
  try {
    await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    console.warn('[Call Bridge] hangup failed:', callControlId, err instanceof Error ? err.message : String(err));
  }
}

async function telnyxCommand(callControlId: string, action: string, body: Record<string, unknown>): Promise<string | null> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return 'TELNYX_API_KEY is not configured.';
  try {
    const res = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { errors?: Array<{ detail?: string }> } | null;
      return json?.errors?.[0]?.detail ?? `Telnyx ${action} returned ${res.status}`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Dial the buyer first and attach the sales assistant when they answer.
 *  The operator is not on the call until they join to listen, whisper, or talk. */
export async function startAiFirstSession(input: {
  customerNumber: string;
  operatorNumber: string;
  buyerName?: string;
  playbookId?: string;
  leadId?: string;
  assistantGreeting?: string;
  assistantInstructions?: string;
  createdByAgentId?: string;
}): Promise<{ id: string } | { error: string; awaitingSafeguard?: boolean; sendJobId?: string }> {
  const id = crypto.randomUUID();
  try {
    await assertContactSendable({ channel: 'phone', destination: input.customerNumber });
  } catch (error) {
    if (error instanceof SendBlockedError) return { error: error.message };
    throw error;
  }
  await db.insert(callBridgeSessions).values({
    id,
    status: 'dialing_customer',
    operatorNumber: input.operatorNumber,
    customerNumber: input.customerNumber,
    conferenceName: id,
    sessionMode: 'ai_first',
    buyerName: input.buyerName ?? null,
    playbookId: input.playbookId ?? null,
    leadId: input.leadId ?? null,
    assistantGreeting: input.assistantGreeting ?? null,
    assistantInstructions: input.assistantInstructions ?? null,
    createdByAgentId: input.createdByAgentId ?? 'operator',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const dialStartedAt = Date.now();
  const result = await dialBridgeLeg({
    to: input.customerNumber,
    role: 'customer',
    sessionId: id,
    endConferenceOnExit: true,
  });
  console.info('[Call Bridge] ai-first customer dial completed', {
    sessionId: id,
    elapsedMs: Date.now() - dialStartedAt,
    ok: !('error' in result),
    error: 'error' in result ? result.error : undefined,
  });
  if ('error' in result) {
    await db.update(callBridgeSessions)
      .set({ status: 'failed', lastError: result.error, updatedAt: new Date() })
      .where(eq(callBridgeSessions.id, id));
    return result.awaitingSafeguard
      ? { error: result.error, awaitingSafeguard: true, sendJobId: result.sendJobId }
      : { error: result.error };
  }
  await recordCustomerLegDialed(id, result.callControlId);
  return { id };
}

// Only the customer leg reaches the contact, so it alone writes the CRM
// timeline row, and only once Telnyx accepted the dial: a leg still held in
// Pending sends never gets here. The release hook uses this too, and there the
// session was marked failed while the leg was held and has no customer leg id
// yet, which attachSalesAi needs when the buyer answers.
async function recordCustomerLegDialed(sessionId: string, callControlId: string): Promise<void> {
  const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, sessionId)).limit(1);
  if (!session) return;
  const aiFirst = (session.sessionMode ?? 'operator_first') === 'ai_first';
  const now = new Date();
  try {
    await commitSendRecord(async (tx) => {
      await tx.update(callBridgeSessions)
        .set({ customerCallControlId: callControlId, updatedAt: now })
        .where(eq(callBridgeSessions.id, sessionId));
      await tx.update(callBridgeSessions)
        .set({ status: 'dialing_customer', lastError: null, updatedAt: now })
        .where(and(eq(callBridgeSessions.id, sessionId), eq(callBridgeSessions.status, 'failed')));
      return sessionId;
    }, {
      destination: session.customerNumber,
      channel: 'call',
      direction: 'outbound',
      actorType: aiFirst ? 'agent' : 'operator',
      actorName: aiFirst ? (session.createdByAgentId ?? 'operator') : 'Matthew',
      eventKind: 'call',
      bodyText: aiFirst ? (session.assistantGreeting ?? 'AI-first call bridge started.') : 'Operator call bridge started.',
      provider: 'telnyx',
      providerMessageId: `bridge:${sessionId}:${callControlId}`,
      sendRecordTable: 'call_bridge_sessions',
      sendRecordId: sessionId,
    });
  } catch (error) {
    // The call is already ringing. Keep the leg id so the AI can attach, and
    // leave the missing timeline row visible in the log rather than failing the call.
    console.error('[Call Bridge] customer leg timeline write failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    await db.update(callBridgeSessions)
      .set({ customerCallControlId: callControlId, updatedAt: now })
      .where(eq(callBridgeSessions.id, sessionId));
    await db.update(callBridgeSessions)
      .set({ status: 'dialing_customer', lastError: null, updatedAt: now })
      .where(and(eq(callBridgeSessions.id, sessionId), eq(callBridgeSessions.status, 'failed')));
  }
}

async function attachSalesAi(sessionId: string): Promise<void> {
  const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, sessionId)).limit(1);
  if (!session?.customerCallControlId) return;
  let greeting = session.assistantGreeting?.trim() || '';
  let instructions = session.assistantInstructions?.trim() || '';
  if (!greeting || !instructions) {
    const { getSalesPlaybook, renderPlaybookTemplate, rehearsalPersonaFields, loadOutboundPolicy } = await import('@workspace/core');
    const { researchedLeads } = await import('@workspace/db');
    const policy = await loadOutboundPolicy();
    let fields = rehearsalPersonaFields({
      buyerName: session.buyerName || policy?.personaName || 'there',
      companyName: policy?.personaCompany || 'the company',
      industry: policy?.personaIndustry || 'local service',
      city: policy?.personaCity || 'your area',
    });
    if (session.leadId) {
      const [lead] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, session.leadId)).limit(1);
      if (lead) {
        fields = {
          buyerName: lead.decisionMakerName?.trim() || lead.companyName,
          companyName: lead.companyName,
          industry: lead.industry || 'local service',
          city: lead.city || 'your area',
          outreachAngle: lead.outreachAngle,
        };
      }
    }
    const playbook = session.playbookId ? getSalesPlaybook(session.playbookId) : getSalesPlaybook('buildmybot-intro');
    greeting = playbook ? renderPlaybookTemplate(playbook.call.firstMessage, fields).text : 'Hi, this is Alex with BuildMyBot. Do you have a minute?';
    instructions = playbook ? renderPlaybookTemplate(playbook.call.assistantPrompt, fields).text : greeting;
  }
  const firstName = firstNameFromDisplayName(session.buyerName);
  greeting = sanitizeAssistantCopy(greeting, firstName);
  instructions = sanitizeAssistantCopy(instructions, firstName);
  const dynamicVariables = assistantDynamicVariablesForSession(session);
  const transcriptionStartedAt = Date.now();
  const transcriptionPromise = telnyxCommand(session.customerCallControlId, 'transcription_start', { language: 'en' })
    .then((transcriptionError) => {
      console.info('[Call Bridge] transcription_start completed', {
        sessionId: session.id,
        elapsedMs: Date.now() - transcriptionStartedAt,
        ok: !transcriptionError,
        error: transcriptionError ?? undefined,
      });
      return transcriptionError;
    });
  const assistantId = process.env.TELNYX_AI_ASSISTANT_ID;
  if (assistantId) {
    const startedAt = Date.now();
    const error = await telnyxCommand(session.customerCallControlId, 'ai_assistant_start', {
      assistant: { id: assistantId, instructions, dynamic_variables: dynamicVariables },
      greeting,
    });
    console.info('[Call Bridge] ai_assistant_start completed', {
      sessionId: session.id,
      elapsedMs: Date.now() - startedAt,
      ok: !error,
      error: error ?? undefined,
    });
    await db.update(callBridgeSessions).set({
      status: error ? 'active' : 'ai_joined',
      lastError: error,
      updatedAt: new Date(),
    }).where(eq(callBridgeSessions.id, session.id));
  } else {
    const frontDeskNumber = process.env.APEX_FRONT_DESK_NUMBER;
    if (!frontDeskNumber) {
      await db.update(callBridgeSessions).set({
        status: 'active',
        lastError: 'Set TELNYX_AI_ASSISTANT_ID or APEX_FRONT_DESK_NUMBER to put an AI on this call.',
        updatedAt: new Date(),
      }).where(eq(callBridgeSessions.id, session.id));
      return;
    }
    const startedAt = Date.now();
    const result = await dialBridgeLeg({
      to: frontDeskNumber,
      role: 'ai',
      sessionId: session.id,
      endConferenceOnExit: false,
    });
    console.info('[Call Bridge] front-desk AI leg dial completed', {
      sessionId: session.id,
      elapsedMs: Date.now() - startedAt,
      ok: !('error' in result),
      error: 'error' in result ? result.error : undefined,
    });
    await db.update(callBridgeSessions).set({
      status: 'error' in result ? 'active' : 'ai_dialing',
      aiCallControlId: 'error' in result ? null : result.callControlId,
      lastError: 'error' in result ? result.error : null,
      updatedAt: new Date(),
    }).where(eq(callBridgeSessions.id, session.id));
  }
  await transcriptionPromise;
}

async function maybeSendRehearsalFollowUp(sessionId: string): Promise<void> {
  const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, sessionId)).limit(1);
  if (!session || session.followUpSent || session.sessionMode !== 'ai_first') return;
  const {
    loadOutboundPolicy,
    samePhone,
    getSalesPlaybook,
    renderPlaybookTemplate,
    rehearsalPersonaFields,
    createQueuedEmailSend,
    deliverQueuedEmailSend,
    recordOutboundAudit,
  } = await import('@workspace/core');
  const policy = await loadOutboundPolicy();
  if (!policy?.rehearsalEmail || !samePhone(session.customerNumber, policy.rehearsalPhone)) return;
  const playbook = getSalesPlaybook(session.playbookId || 'buildmybot-intro');
  if (!playbook) return;
  const fields = rehearsalPersonaFields({
    buyerName: session.buyerName || policy.personaName || 'there',
    companyName: policy.personaCompany || 'the company',
    industry: policy.personaIndustry || 'local service',
    city: policy.personaCity || 'your area',
  });
  if (session.transcriptTail) fields.transcriptSnippet = session.transcriptTail.slice(0, 400);
  const rendered = renderPlaybookTemplate(playbook.followUpEmail.html, fields);
  const subject = renderPlaybookTemplate(playbook.followUpEmail.subject, fields);
  const text = renderPlaybookTemplate(playbook.followUpEmail.text, fields);
  if (rendered.missing.length || subject.missing.length) return;
  const { randomUUID } = await import('crypto');
  const sendId = randomUUID();
  await createQueuedEmailSend({
    id: sendId,
    leadId: session.leadId,
    toEmail: policy.rehearsalEmail,
    toName: fields.buyerName ?? null,
    subject: subject.text,
    createdByAgentId: 'operator',
  });
  let result: Awaited<ReturnType<typeof deliverQueuedEmailSend>>;
  try {
    result = await deliverQueuedEmailSend(sendId, policy.rehearsalEmail, subject.text, rendered.text, { text: text.text });
  } catch (error) {
    const { SendSafeguardError } = await import('@workspace/core');
    if (error instanceof SendSafeguardError) {
      await db.update(callBridgeSessions).set({
        followUpSent: false,
        lastError: 'Nothing was sent. Clear this send in Pending sends.',
        updatedAt: new Date(),
      }).where(eq(callBridgeSessions.id, session.id));
      return;
    }
    throw error;
  }
  await db.update(callBridgeSessions).set({
    followUpSent: result.success,
    lastError: result.success ? session.lastError : result.error ?? session.lastError,
    updatedAt: new Date(),
  }).where(eq(callBridgeSessions.id, session.id));
  if (result.success) {
    await recordOutboundAudit({
      toolName: 'send_email',
      destination: policy.rehearsalEmail,
      leadId: session.leadId,
      policyMode: policy.mode,
      providerId: result.providerId ?? null,
      rehearsal: true,
      detail: 'playbook follow-up after rehearsal call',
    });
  }
}

/** Operator-facing control endpoints. Mount behind requireAdminAuth. */
export function createCallBridgeRouter(): Router {
  const router = Router();

  // ── POST /start — dial the operator; the customer follows once answered ──
  router.post('/start', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { operatorNumber?: string; customerNumber?: string };
      const operatorNumber = normalizeE164(body.operatorNumber);
      const customerNumber = normalizeE164(body.customerNumber);
      if (!operatorNumber || !customerNumber) {
        res.status(400).json({ error: 'A valid operatorNumber and customerNumber in E.164 format are required.' });
        return;
      }

      const id = crypto.randomUUID();
      try {
        await assertContactSendable({ channel: 'phone', destination: customerNumber });
      } catch (error) {
        if (error instanceof SendBlockedError) {
          res.status(409).json({ error: error.message, doNotContact: true });
          return;
        }
        throw error;
      }
      // The customer's timeline row is written when their leg is dialed, after
      // the operator answers, not here: this dial only rings the operator.
      await db.insert(callBridgeSessions).values({
        id,
        status: 'dialing_operator',
        operatorNumber,
        customerNumber,
        conferenceName: id,
        createdByAgentId: 'operator',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await dialBridgeLeg({ to: operatorNumber, role: 'operator', sessionId: id, endConferenceOnExit: true });
      if ('error' in result) {
        await db
          .update(callBridgeSessions)
          .set({ status: 'failed', lastError: result.error, updatedAt: new Date() })
          .where(eq(callBridgeSessions.id, id));
        res.status(502).json({ error: result.error, id });
        return;
      }

      await db
        .update(callBridgeSessions)
        .set({ operatorCallControlId: result.callControlId, updatedAt: new Date() })
        .where(eq(callBridgeSessions.id, id));
      res.status(201).json({ id, status: 'dialing_operator' });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /:id/bring-in-ai — dial the Front Desk number into the call ────────
  router.post('/:id/bring-in-ai', async (req, res) => {
    try {
      const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, req.params.id)).limit(1);
      if (!session) {
        res.status(404).json({ error: 'Call bridge session not found.' });
        return;
      }
      if (session.status !== 'active') {
        res.status(409).json({ error: `Cannot bring the AI in while the call is ${session.status}. Wait until it is active.` });
        return;
      }

      const frontDeskNumber = process.env.APEX_FRONT_DESK_NUMBER;
      if (!frontDeskNumber) {
        res.status(500).json({ error: 'APEX_FRONT_DESK_NUMBER is not configured.' });
        return;
      }

      await db.update(callBridgeSessions).set({ status: 'ai_dialing', updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));

      const result = await dialBridgeLeg({ to: frontDeskNumber, role: 'ai', sessionId: session.id, endConferenceOnExit: false });
      if ('error' in result) {
        await db
          .update(callBridgeSessions)
          .set({ status: 'active', lastError: result.error, updatedAt: new Date() })
          .where(eq(callBridgeSessions.id, session.id));
        res.status(502).json({ error: result.error });
        return;
      }

      await db
        .update(callBridgeSessions)
        .set({ aiCallControlId: result.callControlId, updatedAt: new Date() })
        .where(eq(callBridgeSessions.id, session.id));
      res.status(200).json({ ok: true, status: 'ai_dialing' });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /:id/end — operator hangs up everything ────────────────────────────
  router.post('/:id/end', async (req, res) => {
    try {
      const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, req.params.id)).limit(1);
      if (!session) {
        res.status(404).json({ error: 'Call bridge session not found.' });
        return;
      }
      const legs = [session.operatorCallControlId, session.customerCallControlId, session.aiCallControlId].filter(
        (id): id is string => Boolean(id),
      );
      await Promise.all(legs.map((id) => hangupBridgeLeg(id)));
      await db.update(callBridgeSessions).set({ status: 'ended', updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
      res.status(200).json({ ok: true, status: 'ended' });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── GET /:id — poll for live status ─────────────────────────────────────────
  router.get('/:id', async (req, res) => {
    try {
      const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, req.params.id)).limit(1);
      if (!session) {
        res.status(404).json({ error: 'Call bridge session not found.' });
        return;
      }
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /ai-first — the AI calls the buyer; you join afterwards ───────────
  router.post('/ai-first', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        customerNumber?: string;
        operatorNumber?: string;
        buyerName?: string;
        playbookId?: string;
        leadId?: string;
      };
      const customerNumber = normalizeE164(body.customerNumber);
      const operatorNumber = normalizeE164(body.operatorNumber);
      if (!customerNumber || !operatorNumber) {
        res.status(400).json({ error: 'A valid operatorNumber and customerNumber in E.164 format are required.' });
        return;
      }
      const started = await startAiFirstSession({
        customerNumber,
        operatorNumber,
        buyerName: body.buyerName,
        playbookId: body.playbookId,
        leadId: body.leadId,
      });
      if ('error' in started) {
        res.status(502).json(started);
        return;
      }
      res.status(201).json({ id: started.id, status: 'dialing_customer' });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /:id/join — dial the operator in as monitor, whisper, or barge ────
  router.post('/:id/join', async (req, res) => {
    try {
      const role = (req.body ?? {}).role as string;
      if (role !== 'monitor' && role !== 'whisper' && role !== 'barge') {
        res.status(400).json({ error: 'role must be monitor, whisper, or barge.' });
        return;
      }
      const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, req.params.id)).limit(1);
      if (!session) {
        res.status(404).json({ error: 'Call bridge session not found.' });
        return;
      }
      if (session.status === 'ended' || session.status === 'failed') {
        res.status(409).json({ error: `This call is already ${session.status}.` });
        return;
      }
      if (session.operatorNumber === session.customerNumber) {
        res.status(409).json({ error: 'You are already the buyer on this call. A second join would ring the same phone.' });
        return;
      }
      if (role === 'whisper' && !session.aiCallControlId) {
        res.status(409).json({ error: 'Whisper needs a separate AI leg. Use Listen or Talk on this call.' });
        return;
      }
      const result = await dialBridgeLeg({
        to: session.operatorNumber,
        role,
        sessionId: session.id,
        endConferenceOnExit: false,
        supervisorRole: role,
        whisperCallControlIds: session.aiCallControlId ? [session.aiCallControlId] : undefined,
      });
      if ('error' in result) {
        res.status(502).json({ error: result.error });
        return;
      }
      await db.update(callBridgeSessions).set({
        operatorCallControlId: result.callControlId,
        operatorJoinRole: role,
        updatedAt: new Date(),
      }).where(eq(callBridgeSessions.id, session.id));
      res.status(200).json({ ok: true, role });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /:id/coach — store a note for the operator. Does not email anyone.
  router.post('/:id/coach', async (req, res) => {
    try {
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
      if (!note) {
        res.status(400).json({ error: 'A coach note is required.' });
        return;
      }
      const [updated] = await db.update(callBridgeSessions)
        .set({ coachNote: note, updatedAt: new Date() })
        .where(eq(callBridgeSessions.id, req.params.id))
        .returning({ id: callBridgeSessions.id });
      if (!updated) {
        res.status(404).json({ error: 'Call bridge session not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}

/** Pre-auth Telnyx Call Control webhook. Mount BEFORE requireAdminAuth. */
export function createCallBridgeWebhookRouter(): Router {
  const router = Router();

  router.post('/call-bridge-webhook', async (req, res) => {
    if (!verifyCallBridgeKey(req.query as Record<string, unknown>)) {
      res.status(403).json({ error: 'Invalid or missing key' });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const event = (body.data ?? {}) as Record<string, unknown>;
      const eventType = typeof event.event_type === 'string' ? event.event_type : '';
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const state = decodeClientState(payload.client_state);

      // Not one of ours (or a webhook with no client_state) — ack and ignore.
      if (!state) {
        res.status(200).json({ received: true });
        return;
      }

      const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, state.sessionId)).limit(1);
      if (!session) {
        res.status(200).json({ received: true });
        return;
      }

      if (eventType === 'call.answered') {
        console.info('[Call Bridge] call answered', {
          sessionId: session.id,
          role: state.role,
          callControlId: typeof payload.call_control_id === 'string' ? payload.call_control_id : undefined,
          receivedAt: new Date().toISOString(),
        });
        if (state.role === 'operator') {
          await db
            .update(callBridgeSessions)
            .set({ status: 'dialing_customer', updatedAt: new Date() })
            .where(eq(callBridgeSessions.id, session.id));
          const result = await dialBridgeLeg({
            to: session.customerNumber,
            role: 'customer',
            sessionId: session.id,
            endConferenceOnExit: true,
          });
          if ('error' in result) {
            await db
              .update(callBridgeSessions)
              .set({ status: 'failed', lastError: result.error, updatedAt: new Date() })
              .where(eq(callBridgeSessions.id, session.id));
          } else {
            await recordCustomerLegDialed(session.id, result.callControlId);
          }
        } else if (state.role === 'customer') {
          await db.update(callBridgeSessions).set({ status: 'active', updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
          if ((session.sessionMode ?? 'operator_first') === 'ai_first') {
            await attachSalesAi(session.id);
          }
        } else if (state.role === 'ai') {
          await db.update(callBridgeSessions).set({ status: 'ai_joined', updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
        } else if (state.role === 'monitor' || state.role === 'whisper' || state.role === 'barge') {
          await db.update(callBridgeSessions).set({ operatorJoinRole: state.role, updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
        }
      } else if (eventType === 'call.transcription' || eventType === 'call.speak.ended') {
        const transcript = extractTranscript(payload);
        if (transcript) {
          const prior = session.transcriptTail ?? '';
          const next = `${prior} ${transcript}`.trim().slice(-800);
          await db.update(callBridgeSessions).set({ transcriptTail: next, updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
        }
      } else if (eventType === 'call.hangup') {
        const cause = typeof payload.hangup_cause === 'string' ? payload.hangup_cause : 'unknown';
        if (state.role === 'monitor' || state.role === 'whisper' || state.role === 'barge') {
          await db.update(callBridgeSessions).set({
            operatorJoinRole: null,
            operatorCallControlId: null,
            updatedAt: new Date(),
          }).where(eq(callBridgeSessions.id, session.id));
        } else if (state.role === 'ai') {
          // The AI leaving never ends the operator/customer call — its leg
          // deliberately does not set end_conference_on_exit.
          await db
            .update(callBridgeSessions)
            .set({ status: session.status === 'ended' ? 'ended' : 'active', aiCallControlId: null, updatedAt: new Date() })
            .where(eq(callBridgeSessions.id, session.id));
        } else if (state.role === 'customer' && session.status === 'dialing_customer') {
          // Customer never answered — keep the operator on the line so they
          // can retry or hang up themselves, rather than silently dropping them.
          await db
            .update(callBridgeSessions)
            .set({ status: 'failed', lastError: `Customer did not answer: ${cause}`, customerCallControlId: null, updatedAt: new Date() })
            .where(eq(callBridgeSessions.id, session.id));
        } else {
          // Operator hung up (at any stage) or the customer hung up mid-call.
          // end_conference_on_exit on both their legs already told Telnyx to
          // hang up whichever other legs remain — this just reflects that.
          await db.update(callBridgeSessions).set({ status: 'ended', updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
          if ((session.sessionMode ?? 'operator_first') === 'ai_first') {
            await maybeSendRehearsalFollowUp(session.id);
          }
        }
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[Call Bridge Webhook] error:', err instanceof Error ? err.message : String(err));
      res.status(200).json({ received: true });
    }
  });

  return router;
}

void import('@workspace/core').then(({ registerSendTransport }) => {
  registerSendTransport('telnyx_call', async (jobId, recipient) => {
    const role = recipient.payload.role;
    const sessionId = recipient.payload.sessionId;
    if (typeof role !== 'string' || !BRIDGE_ROLES.has(role as BridgeLegRole) || typeof sessionId !== 'string') {
      const { recordOutboundSendResult } = await import('@workspace/core');
      await recordOutboundSendResult(jobId, recipient.id, 'failed', null);
      return false;
    }
    const whisper = Array.isArray(recipient.payload.whisperCallControlIds)
      ? recipient.payload.whisperCallControlIds.filter((id): id is string => typeof id === 'string')
      : undefined;
    const supervisor = recipient.payload.supervisorRole;
    const result = await dialBridgeLeg({
      to: recipient.destination,
      role: role as BridgeLegRole,
      sessionId,
      endConferenceOnExit: recipient.payload.endConferenceOnExit !== false,
      supervisorRole: supervisor === 'monitor' || supervisor === 'whisper' || supervisor === 'barge' ? supervisor : undefined,
      whisperCallControlIds: whisper,
      sendJobId: jobId,
    });
    if (!('callControlId' in result)) return false;
    if (role === 'customer') await recordCustomerLegDialed(sessionId, result.callControlId);
    return true;
  });
});
