import { Router } from 'express';
import crypto from 'crypto';
import { db, callBridgeSessions, integrationSettings } from '@workspace/db';
import { SendBlockedError, assertContactSendable, commitSendRecord } from '@workspace/core';
import { and, desc, eq } from 'drizzle-orm';
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
//   3. POST /:id/bring-in-ai — dial the AI LINE into the same conference as a
//      MUTED participant. That line's connection already routes inbound calls
//      to an AI assistant, so the assistant hears the whole conference while
//      it is muted and can be heard the instant it is unmuted. Joining at
//      /start instead (POST /start { autoJoinAi: true }) puts the assistant on
//      the bridge before the customer is even rung, so it has the context of
//      the entire conversation by the time the operator hands it the call.
//
// THE TAKEOVER IS A CONFERENCE MUTE, NOT A THIRD-PARTY ATTACH. The previous
// implementation called ai_assistant_start on the CUSTOMER's call_control_id —
// a leg that is already a conference participant. Telnyx accepts that command
// (HTTP 200, ok:true) and then ends the conversation about one second later:
// production session 89b6c4c7 shows the conversation created at 16:16:19.17,
// a greeting playback, and call.conversation.ended at 16:16:20.19, with
// GET /v2/ai/conversations/{id}/messages returning ZERO messages — the
// assistant never heard a word and never spoke one. The operator hears the
// customer and nothing else, which is exactly the reported symptom.
// APEX_BRIDGE_AI_TRANSPORT=attach restores that path for comparison only.
// Muting a conference participant changes only what the OTHER participants
// hear: a muted participant still receives the full conference mix, so the AI
// keeps listening the whole time it is held back.
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
    // What the operator told the AI this call is about. It replaces the
    // standing "no specific script is armed" default so a bridge takeover is
    // about the conversation actually happening on the line.
    fact: session.assistantTopic?.trim()
      ? sanitizeAssistantCopy(session.assistantTopic, firstName)
      : 'No specific script is armed for this call. Respond naturally per your standing newsroom rules.',
  };
}

export function configuredApexOutboundNumber(): string | null {
  const normalized = normalizeE164(process.env.APEX_FRONT_DESK_NUMBER);
  return normalized && APPROVED_APEX_OUTBOUND_NUMBERS.includes(normalized) ? normalized : null;
}

/** The lines a bridge leg may be dialed FROM. APEX only ever dials the
 *  operator/customer legs from caller IDs it owns and has approved, so an
 *  operator-supplied number is accepted only when it is already on this list —
 *  anything else would put an arbitrary number on a live outbound call. */
export function approvedCallerIdNumbers(): string[] {
  const extra = (process.env.APEX_BRIDGE_CALLER_ID_NUMBERS ?? '')
    .split(',')
    .map((value) => normalizeE164(value))
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set([...APPROVED_APEX_OUTBOUND_NUMBERS, ...extra]));
}

/** The line whose connection answers inbound calls with an AI assistant. A
 *  per-call override is only honored when it is on the approved list, for the
 *  same reason as the caller ID: the AI leg must land on a line we know
 *  answers with an assistant rather than whoever happens to pick up. */
/** Built-in AI lines, approved without any env change: the Don Voice / sales
 *  line (832-975-7665, the approved APEX outbound number) answers with a voice
 *  assistant too, so a takeover may be pointed at it. Env-only approval meant
 *  an operator who typed this line got a 400 and had to go and set
 *  APEX_BRIDGE_AI_LINES before the call could be placed at all. */
const BUILT_IN_APPROVED_AI_LINES: readonly string[] = [APPROVED_APEX_OUTBOUND_NUMBER];

export function approvedAssistantLines(): string[] {
  const extra = (process.env.APEX_BRIDGE_AI_LINES ?? '')
    .split(',')
    .map((value) => normalizeE164(value))
    .filter((value): value is string => Boolean(value));
  const fallback = normalizeE164(process.env.APEX_FRONT_DESK_NUMBER);
  return Array.from(new Set([...BUILT_IN_APPROVED_AI_LINES, ...(fallback ? [fallback] : []), ...extra]));
}

/** ─── Operator dial settings ───────────────────────────────────────────────
 *  The operator dials the same handful of numbers constantly, starting with
 *  their own cell. These are persisted so the operator never retypes them:
 *
 *   - defaultOperatorNumber — the operator's own line, dialed first. Ships
 *     hard-coded to the operator's cell so a takeover call needs no typing at
 *     all, and stays overridable (env APEX_DEFAULT_OPERATOR_NUMBER, then the
 *     API, then the UI) so it is a default, not a cage.
 *   - savedNumbers — recurring customer numbers, label + E.164, so they can be
 *     picked instead of typed.
 */
const DIAL_SETTINGS_KEY = 'call_dial_settings';

/** The operator's cell. Hard-coded default; a change is persisted, not lost. */
const HARDCODED_DEFAULT_OPERATOR_NUMBER =
  normalizeE164(process.env.APEX_DEFAULT_OPERATOR_NUMBER) ?? '+18328804970';

export type SavedDialNumber = { label: string; number: string };
export type DialSettings = { defaultOperatorNumber: string; savedNumbers: SavedDialNumber[] };

export async function readDialSettings(): Promise<DialSettings> {
  const [row] = await db
    .select()
    .from(integrationSettings)
    .where(eq(integrationSettings.key, DIAL_SETTINGS_KEY))
    .limit(1);
  let parsed: Partial<DialSettings> = {};
  if (row?.value) {
    try {
      parsed = JSON.parse(row.value) as Partial<DialSettings>;
    } catch {
      parsed = {};
    }
  }
  const savedNumbers = Array.isArray(parsed.savedNumbers)
    ? parsed.savedNumbers
        .map((entry) => ({ label: String(entry?.label ?? '').slice(0, 60), number: normalizeE164(entry?.number) ?? '' }))
        .filter((entry) => entry.number)
    : [];
  return {
    defaultOperatorNumber: normalizeE164(parsed.defaultOperatorNumber) ?? HARDCODED_DEFAULT_OPERATOR_NUMBER,
    savedNumbers,
  };
}

/** What GET/PATCH /dial-settings answers with: the persisted settings plus the
 *  AI lines a takeover may actually be pointed at. The panel renders these as
 *  a pick list, so the operator selects an approved line instead of typing one
 *  the API will then refuse. Derived from the same source as the guard, never
 *  stored — a stale copy in the settings row could outlive a code change. */
export type DialSettingsView = DialSettings & { approvedAiLines: string[] };

export async function readDialSettingsView(): Promise<DialSettingsView> {
  return { ...(await readDialSettings()), approvedAiLines: approvedAssistantLines() };
}

async function writeDialSettings(next: DialSettings): Promise<void> {
  const value = JSON.stringify(next);
  await db
    .insert(integrationSettings)
    .values({ key: DIAL_SETTINGS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: integrationSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

/** How the AI gets onto the bridge.
 *  'leg'    — dial the AI line into the conference muted (the working design).
 *  'attach' — legacy ai_assistant_start on the customer's conferenced leg.
 *
 *  SAFE DEFAULT IS 'attach'. The conference-leg transport is the correct fix,
 *  but it has not yet passed a controlled two-leg audio test, so an un-tested
 *  feature must not become production just because the code merged. Opt IN
 *  explicitly with APEX_BRIDGE_AI_TRANSPORT=leg (for the controlled test), and
 *  flip it back to unset/'attach' for the instant rollback. */
/** The AI reaches the bridge as its own dialed conference leg.
 *
 *  'leg' is the DEFAULT because it is the one that works. The legacy 'attach'
 *  starts an assistant on the CUSTOMER's conferenced leg, which takes that
 *  leg's audio out of the conference — both parties then hear silence, and
 *  Telnyx refuses a second attempt ("AI Assistant cannot be started more than
 *  once"). It is opt-IN only (APEX_BRIDGE_AI_TRANSPORT=attach), kept for a
 *  controlled comparison or a rollback, never a default. */
export function aiLegTransport(): 'leg' | 'attach' {
  return process.env.APEX_BRIDGE_AI_TRANSPORT === 'attach' ? 'attach' : 'leg';
}

function callBridgeWebhookUrl(): string {
  const publicUrl = process.env.PUBLIC_URL ?? 'https://apex.donmatthews.live';
  const secret = process.env.TELNYX_CALL_BRIDGE_WEBHOOK_SECRET ?? '';
  return `${publicUrl}/api/telnyx-assistant/call-bridge-webhook?key=${encodeURIComponent(secret)}`;
}

import { campaignForCustomer } from './call-bridge-campaigns.js';

/** PATCH the assistant's dynamic_variables. Telnyx ignores dial-level
 *  AIAssistantDynamicVariables on the ai_calls path (confirmed 2026-10-09),
 *  so campaign script payloads must be baked onto the assistant immediately
 *  before ai_assistant_start. The PATCH replaces the whole map. */
async function patchAssistantDynamicVariables(
  assistantId: string,
  dynamicVariables: Record<string, string>,
): Promise<string | null> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return 'TELNYX_API_KEY is not configured.';
  try {
    const res = await fetch(`https://api.telnyx.com/v2/ai/assistants/${encodeURIComponent(assistantId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dynamic_variables: dynamicVariables }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { errors?: Array<{ detail?: string }> } | null;
      return json?.errors?.[0]?.detail ?? `Telnyx assistant PATCH returned ${res.status}`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
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
  /** Join the conference already muted. This is how the AI listens without
   *  being heard until the operator hands it the call. */
  mute?: boolean;
  /** Caller ID for this leg. Defaults to the single approved APEX caller ID;
   *  only ever a number on approvedCallerIdNumbers(), validated by the caller. */
  fromNumber?: string | null;
  sendJobId?: string | null;
  /** True when the operator started this session themselves from the
   *  dashboard: the dial is their own explicit action, so the send job is
   *  opened as an operator test send (kill switch, lockout, and
   *  do-not-contact checks still run) instead of a tool send that would sit
   *  in Pending sends waiting for two confirmations nobody is going to give.
   *  Agent-initiated sessions keep the full confirm flow. */
  operatorInitiated?: boolean;
}): Promise<{ callControlId: string } | { error: string; awaitingSafeguard?: boolean; sendJobId?: string }> {
  const apiKey = process.env.TELNYX_API_KEY;
  const connectionId = process.env.TELNYX_CALL_BRIDGE_CONNECTION_ID;
  const from = params.fromNumber ?? configuredApexOutboundNumber();
  if (!apiKey || !connectionId || !from) {
    return { error: `TELNYX_API_KEY, TELNYX_CALL_BRIDGE_CONNECTION_ID, and APEX_FRONT_DESK_NUMBER=${APPROVED_APEX_OUTBOUND_NUMBER} are required for outbound Telnyx calls.` };
  }
  const { assertSendAllowed, openOutboundSendJob, recordOutboundSendResult, SendSafeguardError } = await import('@workspace/core');
  let sendJobId = params.sendJobId ?? null;
  let recipientId: string | null = null;
  try {
    if (!sendJobId) {
      const opened = await openOutboundSendJob({
        caller: params.operatorInitiated ? 'operator-dashboard' : 'tool',
        createdBy: params.operatorInitiated ? 'call-bridge-operator' : 'call-bridge',
        ...(params.operatorInitiated ? { operatorDirect: true } : {}),
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
          // The AI's listening leg never starts a conference of its own: it
          // only ever joins one the operator's leg already created.
          ...(params.role === 'ai' ? { start_conference_on_enter: false } : {}),
          // Muted on arrival. A muted conference participant still hears the
          // full mix — it just cannot be heard — which is the whole design.
          ...(params.mute ? { mute: true } : {}),
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

/** Mute or unmute ONE participant of a live conference.
 *
 *  This is the takeover mechanism. Muting changes only what the other
 *  participants hear: the muted participant still receives the conference mix,
 *  so a muted AI leg keeps listening to the whole conversation and can be
 *  handed the call by a single unmute. Returns null on success, or the Telnyx
 *  error detail. Exported for direct guard testing. */
export async function setConferenceParticipantMuted(
  conferenceName: string,
  callControlId: string,
  muted: boolean,
): Promise<string | null> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return 'TELNYX_API_KEY is not configured.';
  const action = muted ? 'mute' : 'unmute';
  try {
    const res = await fetch(
      `https://api.telnyx.com/v2/conferences/${encodeURIComponent(conferenceName)}/actions/${action}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_control_ids: [callControlId] }),
      },
    );
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { errors?: Array<{ detail?: string }> } | null;
      return json?.errors?.[0]?.detail ?? `Telnyx conference ${action} returned ${res.status}`;
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
    operatorInitiated: (input.createdByAgentId ?? 'operator') === 'operator',
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

/** The standing brief that turns the line's INBOUND assistant into a silent
 *  third participant on someone else's call.
 *
 *  The AI line answers with an assistant built to take tip calls: "Wait for
 *  the caller to speak. Then ask ONE question: How can I help you? … When you
 *  have their name, number and the issue, say Thank you and use the Hangup
 *  tool." Dropped onto a bridge with no brief, that assistant treats the
 *  operator as a tip caller and eventually hangs itself up. This brief is what
 *  the operator's "tell it what the call is about" setting rides on. Exported
 *  so the guard can execute it rather than pattern-match it. */
export function bridgeTakeoverBriefing(topic: string | null | undefined): string {
  const subject = typeof topic === 'string' && topic.trim() ? topic.trim() : '';
  return [
    'BRIDGE TAKEOVER BRIEFING',
    'You are on a live three-way call: our operator and the other party. You joined MUTED and you have been listening since the start, so you already have the context.',
    'This is NOT an inbound tip call. Do not greet anyone, do not open with "How can I help you?", do not ask for a name and number, and do not use the Hangup tool — the operator owns this call and only the operator ends it.',
    'Stay silent until the operator hands you the call on the line, then take over the conversation as Hank Vance.',
    subject
      ? `What this call is about, in the operator's words: ${subject}`
      : 'The operator gave no topic for this call. Follow what has actually been said on the line.',
    'If the operator tells you to stand down, go quiet immediately and keep listening.',
  ].join('\n');
}

/** The full dynamic_variables map to arm before the AI leg is dialed. Telnyx
 *  replaces the whole map on PATCH, so every key an assistant might read is
 *  written every time — including the keys the campaign scripts use. */
export function assistantArmVariablesForBridge(
  session: typeof callBridgeSessions.$inferSelect,
  campaign: { dynamicVariables: Record<string, string> } | null,
): Record<string, string> {
  return {
    desk_name: 'Hank Vance',
    callback_number: '(346) 646-1352',
    office: campaign?.dynamicVariables['office'] ?? '',
    contact_name_or_role: campaign?.dynamicVariables['contact_name_or_role'] ?? 'the operator',
    question_list: campaign?.dynamicVariables['question_list'] ?? '',
    fact: session.assistantTopic?.trim()
      ? session.assistantTopic.trim()
      : campaign?.dynamicVariables['fact'] ?? '',
    caller_context: bridgeTakeoverBriefing(session.assistantTopic),
  };
}

/** The assistant bound to a line that answers inbound calls with an AI
 *  assistant. Telnyx exposes those as connections named
 *  `ai-assistant-<assistant uuid>`, so the assistant that will actually pick
 *  up is discoverable from the line itself. This matters: TELNYX_AI_ASSISTANT_ID
 *  is the OUTBOUND persona, and arming that one while the line answers with the
 *  inbound one silently arms a different assistant than the one on the call.
 *  Best-effort — null means "could not discover", never a thrown error. */
async function assistantIdForLine(line: string): Promise<string | null> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return null;
  const cached = assistantIdByLine.get(line);
  if (cached !== undefined) return cached;
  let resolved: string | null = null;
  try {
    const listRes = await fetch(
      `https://api.telnyx.com/v2/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(line)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const list = (await listRes.json().catch(() => null)) as
      | { data?: Array<{ connection_id?: string }> }
      | null;
    const connectionId = list?.data?.find((entry) => entry.connection_id)?.connection_id;
    if (connectionId) {
      const connRes = await fetch(`https://api.telnyx.com/v2/connections/${encodeURIComponent(connectionId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const conn = (await connRes.json().catch(() => null)) as { data?: { connection_name?: string } } | null;
      const match = /^ai-assistant-([0-9a-f-]{36})$/i.exec(conn?.data?.connection_name ?? '');
      if (match) resolved = `assistant-${match[1]}`;
    }
  } catch (err) {
    console.warn('[Call Bridge] assistant discovery failed', err instanceof Error ? err.message : String(err));
  }
  assistantIdByLine.set(line, resolved);
  return resolved;
}

/** Which assistant handles the AI leg: the per-session choice, then an
 *  explicit env binding, then whatever the line itself answers with. */
async function resolveBridgeAssistantId(session: typeof callBridgeSessions.$inferSelect, line: string): Promise<string | null> {
  return (
    session.assistantId?.trim() ||
    process.env.APEX_BRIDGE_AI_ASSISTANT_ID?.trim() ||
    (await assistantIdForLine(line)) ||
    process.env.TELNYX_AI_ASSISTANT_ID?.trim() ||
    null
  );
}

/** Dial the AI line into the session's conference as a MUTED participant.
 *
 *  The assistant joins before it can speak and hears everything from then on.
 *  `unmuteNow` skips the listening phase (the operator asked for the takeover
 *  straight away). Everything about this path is a documented conference
 *  behaviour: join muted, then POST …/actions/unmute to hand over the call. */
async function dialAiLegMuted(
  session: typeof callBridgeSessions.$inferSelect,
  options: { unmuteNow?: boolean; operatorInitiated?: boolean } = {},
): Promise<void> {
  const line = session.assistantLine?.trim() || normalizeE164(process.env.APEX_FRONT_DESK_NUMBER);
  if (!line) {
    await db
      .update(callBridgeSessions)
      .set({ status: 'active', lastError: 'Set APEX_FRONT_DESK_NUMBER to the line that answers with an AI assistant.', updatedAt: new Date() })
      .where(eq(callBridgeSessions.id, session.id));
    return;
  }
  const assistantId = await resolveBridgeAssistantId(session, line);
  if (assistantId) {
    const campaign = campaignForCustomer(session.customerNumber);
    const armError = await patchAssistantDynamicVariables(assistantId, assistantArmVariablesForBridge(session, campaign));
    console.info('[Call Bridge] AI leg armed', { sessionId: session.id, assistantId, ok: !armError, error: armError ?? undefined });
    if (armError) {
      // A stale brief puts the wrong instructions in front of a live call.
      await db
        .update(callBridgeSessions)
        .set({ status: 'active', lastError: `AI attach aborted: ${armError}`, updatedAt: new Date() })
        .where(eq(callBridgeSessions.id, session.id));
      return;
    }
  } else {
    console.warn('[Call Bridge] AI leg armed with no assistant briefing', { sessionId: session.id, line });
  }
  const unmuteNow = options.unmuteNow === true;
  const result = await dialBridgeLeg({
    to: line,
    role: 'ai',
    sessionId: session.id,
    endConferenceOnExit: false,
    mute: !unmuteNow,
    fromNumber: session.fromNumber ?? null,
    operatorInitiated: options.operatorInitiated ?? false,
  });
  if ('error' in result) {
    await db
      .update(callBridgeSessions)
      .set({ status: 'active', lastError: result.error, updatedAt: new Date() })
      .where(eq(callBridgeSessions.id, session.id));
    return;
  }
  await db
    .update(callBridgeSessions)
    .set({
      // A dial the API ACCEPTED is not an assistant that joined. Stay
      // 'ai_dialing' until conference.participant.joined confirms this leg is
      // really in the conference — a successful command is not proof of a
      // working AI conversation (the exact false-positive this fix removes).
      status: 'ai_dialing',
      aiCallControlId: result.callControlId,
      aiMuted: !unmuteNow,
      assistantLine: line,
      assistantId,
      ...(unmuteNow ? { aiTakeoverAt: new Date() } : {}),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(callBridgeSessions.id, session.id));
}

/** The line -> assistant binding is stable for the life of the process. */
const assistantIdByLine = new Map<string, string | null>();

async function attachSalesAi(
  sessionId: string,
  options: { phase?: 'call_start' | 'mid_call'; unmuteNow?: boolean; operatorInitiated?: boolean } = {},
): Promise<void> {
  const phase = options.phase ?? 'call_start';
  const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, sessionId)).limit(1);
  if (!session) return;
  // The AI reaches the bridge as its own dialed conference leg. That is the
  // only design in which the operator and the customer BOTH hear the AI and
  // the AI hears BOTH of them; see the file header.
  if (aiLegTransport() === 'leg') {
    if (!session.customerCallControlId) {
      console.warn('[Call Bridge] AI leg requested before the customer leg existed', { sessionId: session.id });
    }
    await dialAiLegMuted(session, { unmuteNow: options.unmuteNow, operatorInitiated: options.operatorInitiated });
    return;
  }
  if (!session.customerCallControlId) return;
  let greeting = session.assistantGreeting?.trim() || '';
  let instructions = session.assistantInstructions?.trim() || '';
  // Newsroom mode: when the bridge is configured for a newsroom assistant
  // (APEX_BRIDGE_AI_MODE=newsroom), never fall back to the BuildMyBot sales
  // playbook. The configured assistant (e.g. Hank Vance) speaks from its own
  // base prompt and greeting instead of being overridden as a sales rep.
  if ((!greeting || !instructions) && process.env.APEX_BRIDGE_AI_MODE !== 'newsroom') {
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
  const campaign = campaignForCustomer(session.customerNumber);
  if (assistantId && !greeting && process.env.APEX_BRIDGE_AI_MODE === 'newsroom') {
    // A silent join reads as a dead line to the operator and the contact.
    // The configured assistant must always speak first when it comes onto the
    // bridge: Hank's mandated opening on a fresh outbound call, a short
    // joining announcement when it is brought in mid-call. When the customer
    // number is a registered campaign target, mid-call joins also open with
    // the mandated line so the assistant engages the script immediately.
    if (phase === 'mid_call' && !campaign) {
      greeting = 'This is Hank Vance from On Your Side Investigations with We The People News. I am joining the call.';
    } else {
      greeting = process.env.TELNYX_AI_ASSISTANT_GREETING?.trim()
        || 'Hi, this is Hank Vance from On Your Side Investigations with We The People News. I am calling to speak with someone regarding a matter that was brought to our Newsroom attention.';
    }
  }
  if (assistantId) {
    const startedAt = Date.now();
    // Arm the assistant for this session's campaign target, or neutralize any
    // leftover script from a previous campaign call so the assistant never
    // recites the wrong office's questions. The PATCH replaces the whole
    // dynamic_variables map, and dial-level variables are ignored by Telnyx.
    let armError: string | null = null;
    if (campaign) {
      armError = await patchAssistantDynamicVariables(assistantId, campaign.dynamicVariables);
      console.info('[Call Bridge] campaign arm PATCH completed', {
        sessionId: session.id,
        ok: !armError,
        error: armError ?? undefined,
        office: campaign.dynamicVariables['office'],
      });
    } else {
      armError = await patchAssistantDynamicVariables(assistantId, {
        desk_name: 'Hank Vance',
        callback_number: '(346) 646-1352',
        office: '',
        fact: 'No specific script is armed for this call. Respond naturally per your standing newsroom rules.',
        contact_name_or_role: 'the caller',
        question_list: '',
      });
    }
    if (armError) {
      // Attaching with a stale or missing script would put the wrong questions
      // in front of a live contact. Fail the attach loudly instead.
      await db.update(callBridgeSessions).set({ status: 'active', lastError: `AI attach aborted: ${armError}`, updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
      return;
    }
    const startDynamicVariables: Record<string, string> = { ...dynamicVariables };
    if (campaign) Object.assign(startDynamicVariables, campaign.dynamicVariables);
    // Omit empty overrides so the assistant's own base prompt/greeting govern
    // (newsroom mode). Telnyx replaces the assistant's instructions entirely
    // when `instructions` is present, so never send an empty string.
    const assistantPayload: Record<string, unknown> = { id: assistantId, dynamic_variables: startDynamicVariables };
    if (instructions) assistantPayload.instructions = instructions;
    const startPayload: Record<string, unknown> = { assistant: assistantPayload };
    if (greeting) startPayload.greeting = greeting;
    const error = await telnyxCommand(session.customerCallControlId, 'ai_assistant_start', startPayload);
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

  // ── GET /dial-settings — the operator's own number and saved customer
  //    numbers, so a takeover call needs no typing. ──────────────────────────
  router.get('/dial-settings', async (_req, res) => {
    try {
      res.json(await readDialSettingsView());
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── PATCH /dial-settings — change the default operator number and/or the
  //    saved numbers. Persisted, so the next call remembers. ────────────────
  router.patch('/dial-settings', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        defaultOperatorNumber?: string;
        savedNumbers?: Array<{ label?: string; number?: string }>;
      };
      const current = await readDialSettings();
      const next: DialSettings = { ...current };
      if (body.defaultOperatorNumber !== undefined) {
        const normalized = normalizeE164(body.defaultOperatorNumber);
        if (!normalized) {
          res.status(400).json({ error: 'defaultOperatorNumber must be a valid E.164 number.' });
          return;
        }
        next.defaultOperatorNumber = normalized;
      }
      if (Array.isArray(body.savedNumbers)) {
        next.savedNumbers = body.savedNumbers
          .map((entry) => ({
            label: String(entry?.label ?? '').slice(0, 60).trim() || 'Saved number',
            number: normalizeE164(entry?.number) ?? '',
          }))
          .filter((entry) => entry.number);
      }
      await writeDialSettings(next);
      res.json({ ...next, approvedAiLines: approvedAssistantLines() });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── GET /sessions — recent bridge calls for the live call monitor. Newest
  //    first; the monitor polls this. ────────────────────────────────────────
  router.get('/sessions', async (_req, res) => {
    try {
      const rows = await db
        .select()
        .from(callBridgeSessions)
        .orderBy(desc(callBridgeSessions.createdAt))
        .limit(25);
      res.json({ sessions: rows });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /start — dial the operator; the customer follows once answered ──
  router.post('/start', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        operatorNumber?: string;
        customerNumber?: string;
        /** Caller ID every leg of this call dials from. Must be a number APEX
         *  has approved; anything else is refused rather than dialed. */
        fromNumber?: string;
        /** The line that answers with an AI assistant — i.e. which agent ends
         *  up on the bridge (the agent is bound to the line, not to the call). */
        assistantLine?: string;
        /** Explicit assistant override, `assistant-<uuid>`. */
        assistantId?: string;
        /** What the call is about, in the operator's words. Goes onto the AI's
         *  brief so a takeover lands on-topic instead of opening cold. */
        topic?: string;
        /** Put the AI on the bridge, muted, before the customer is rung, so it
         *  hears the call from the first word. */
        autoJoinAi?: boolean;
      };
      // The operator's own line defaults to the saved number, so a takeover
      // call never needs it typed. An explicit operatorNumber still wins, and
      // an explicitly malformed one is refused rather than silently defaulted.
      const operatorNumber =
        normalizeE164(body.operatorNumber) ??
        (body.operatorNumber === undefined ? (await readDialSettings()).defaultOperatorNumber : null);
      const customerNumber = normalizeE164(body.customerNumber);
      if (!operatorNumber || !customerNumber) {
        res.status(400).json({
          error: 'A valid customerNumber in E.164 format is required (operatorNumber defaults to the saved operator line).',
        });
        return;
      }
      const requestedFrom = body.fromNumber === undefined ? null : normalizeE164(body.fromNumber);
      if (body.fromNumber !== undefined && !requestedFrom) {
        res.status(400).json({ error: 'fromNumber must be a number in E.164 format.' });
        return;
      }
      if (requestedFrom && !approvedCallerIdNumbers().includes(requestedFrom)) {
        res.status(400).json({ error: `fromNumber ${requestedFrom} is not an approved APEX caller ID.` });
        return;
      }
      const requestedLine = body.assistantLine === undefined ? null : normalizeE164(body.assistantLine);
      if (body.assistantLine !== undefined && !requestedLine) {
        res.status(400).json({ error: 'assistantLine must be a number in E.164 format.' });
        return;
      }
      if (requestedLine && !approvedAssistantLines().includes(requestedLine)) {
        res.status(400).json({ error: `assistantLine ${requestedLine} is not an approved AI line.` });
        return;
      }
      const requestedAssistantId = typeof body.assistantId === 'string' ? body.assistantId.trim() : '';
      if (requestedAssistantId && !/^assistant-[0-9a-f-]{36}$/i.test(requestedAssistantId)) {
        res.status(400).json({ error: 'assistantId must look like assistant-<uuid>.' });
        return;
      }
      const topic = typeof body.topic === 'string' ? body.topic.trim().slice(0, 600) : null;

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
      const autoJoinAi = body.autoJoinAi === true;
      await db.insert(callBridgeSessions).values({
        id,
        status: 'dialing_operator',
        operatorNumber,
        customerNumber,
        conferenceName: id,
        createdByAgentId: 'operator',
        fromNumber: requestedFrom,
        assistantLine: requestedLine,
        assistantId: requestedAssistantId || null,
        assistantTopic: topic,
        aiAutoJoin: autoJoinAi,
        aiMuted: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // The listening AI is NOT dialed here. A conference leg only exists once
      // the operator's leg has actually entered the conference, and the operator
      // has not even been rung yet — a leg dialed now has nothing to join and is
      // silently dropped. It is dialed from the operator's call.answered handler
      // below, where the conference exists.
      const result = await dialBridgeLeg({
        to: operatorNumber,
        role: 'operator',
        sessionId: id,
        endConferenceOnExit: true,
        fromNumber: requestedFrom,
        operatorInitiated: true,
      });
      if ('error' in result) {
        await db
          .update(callBridgeSessions)
          .set({ status: 'failed', lastError: result.error, updatedAt: new Date() })
          .where(eq(callBridgeSessions.id, id));
        res.status(409).json({ error: result.error, id, ...(result.awaitingSafeguard ? { awaitingSafeguard: true, sendJobId: result.sendJobId } : {}) });
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

      // Default is the listening join: the AI takes its place on the bridge
      // muted and hears everything from here on. { unmute: true } is the
      // operator asking for the hand-over at the same moment.
      const unmuteNow = (req.body as { unmute?: unknown } | undefined)?.unmute === true;
      await db.update(callBridgeSessions).set({ status: 'ai_dialing', aiMuted: !unmuteNow, updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
      await attachSalesAi(session.id, { phase: 'mid_call', unmuteNow, operatorInitiated: true });
      const [updated] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, session.id)).limit(1);
      if (updated?.lastError) {
        res.status(502).json({ error: updated.lastError });
        return;
      }
      res.status(200).json({ ok: true, status: updated?.status ?? 'ai_dialing', aiMuted: updated?.aiMuted ?? true });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /:id/takeover — hand the call to the AI (unmute its leg) ──────────
  router.post('/:id/takeover', async (req, res) => {
    try {
      const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, req.params.id)).limit(1);
      if (!session) {
        res.status(404).json({ error: 'Call bridge session not found.' });
        return;
      }
      if (session.status === 'ended' || session.status === 'failed') {
        res.status(409).json({ error: `Cannot hand this call over while it is ${session.status}.` });
        return;
      }
      // No listening leg yet: dial it straight into the takeover.
      if (!session.aiCallControlId) {
        await attachSalesAi(session.id, { phase: 'mid_call', unmuteNow: true, operatorInitiated: true });
        const [dialed] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, session.id)).limit(1);
        if (dialed?.lastError) {
          res.status(502).json({ error: dialed.lastError });
          return;
        }
        res.status(200).json({ ok: true, status: dialed?.status ?? 'ai_dialing', aiMuted: false });
        return;
      }
      const error = await setConferenceParticipantMuted(session.conferenceName, session.aiCallControlId, false);
      await db
        .update(callBridgeSessions)
        .set({ aiMuted: Boolean(error), status: error ? session.status : 'ai_joined', lastError: error, aiTakeoverAt: error ? session.aiTakeoverAt : new Date(), updatedAt: new Date() })
        .where(eq(callBridgeSessions.id, session.id));
      if (error) {
        res.status(502).json({ error });
        return;
      }
      res.status(200).json({ ok: true, status: 'ai_joined', aiMuted: false });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /:id/hand-back — take the call back (mute the AI's leg) ───────────
  router.post('/:id/hand-back', async (req, res) => {
    try {
      const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, req.params.id)).limit(1);
      if (!session) {
        res.status(404).json({ error: 'Call bridge session not found.' });
        return;
      }
      if (!session.aiCallControlId) {
        res.status(409).json({ error: 'No AI is on this call yet.' });
        return;
      }
      const error = await setConferenceParticipantMuted(session.conferenceName, session.aiCallControlId, true);
      await db
        .update(callBridgeSessions)
        .set({ aiMuted: error ? session.aiMuted : true, lastError: error, updatedAt: new Date() })
        .where(eq(callBridgeSessions.id, session.id));
      if (error) {
        res.status(502).json({ error });
        return;
      }
      res.status(200).json({ ok: true, status: session.status, aiMuted: true });
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
        res.status(409).json(started);
        return;
      }
      res.status(201).json({ id: started.id, status: 'dialing_customer' });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /:id/dtmf — press digits on the live call ────────────────────────
  // For getting past an auto attendant ("press 1 for billing"): the digits are
  // sent TO the far end of the chosen leg, exactly as if a keypad on that call
  // were pressed. Default target is the customer leg, since that is the leg
  // talking to the IVR.
  router.post('/:id/dtmf', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { digits?: string; target?: string };
      const digits = String(body.digits ?? '').trim();
      // 0-9, *, #, A-D, and `,` for a pause. Nothing else reaches the wire.
      if (!digits || !/^[0-9A-Da-d*#,]{1,32}$/.test(digits)) {
        res.status(400).json({ error: 'digits must be 1-32 characters of 0-9, *, #, A-D or , (pause).' });
        return;
      }
      const target = body.target === 'ai' || body.target === 'operator' ? body.target : 'customer';
      const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, req.params.id)).limit(1);
      if (!session) {
        res.status(404).json({ error: 'Call bridge session not found.' });
        return;
      }
      const targetCallControlId =
        target === 'ai' ? session.aiCallControlId
        : target === 'operator' ? session.operatorCallControlId
        : session.customerCallControlId;
      if (!targetCallControlId) {
        res.status(409).json({ error: `The ${target} leg is not on this call yet.` });
        return;
      }
      const error = await telnyxCommand(targetCallControlId, 'send_dtmf', { digits });
      if (error) {
        res.status(409).json({ error });
        return;
      }
      console.info('[Call Bridge] dtmf sent', { sessionId: session.id, target, digits: digits.length });
      res.json({ ok: true, target, digits });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /:id/operator-mute — talk, or listen without being heard ─────────
  // The operator's side of AI-first: the AI is running the call and the
  // operator listens in without being heard, then unmutes to take it over.
  // Telnyx holds the state; nothing is persisted, so a reload re-asks.
  router.post('/:id/operator-mute', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { muted?: boolean };
      if (typeof body.muted !== 'boolean') {
        res.status(400).json({ error: 'muted must be a boolean.' });
        return;
      }
      const [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, req.params.id)).limit(1);
      if (!session) {
        res.status(404).json({ error: 'Call bridge session not found.' });
        return;
      }
      if (!session.operatorCallControlId) {
        res.status(409).json({ error: 'The operator leg is not on this call yet.' });
        return;
      }
      if (session.status === 'ended' || session.status === 'failed') {
        res.status(409).json({ error: `This call is already ${session.status}.` });
        return;
      }
      const error = await telnyxCommand(
        session.operatorCallControlId,
        body.muted ? 'mute' : 'unmute',
        {},
      );
      if (error) {
        res.status(409).json({ error });
        return;
      }
      console.info('[Call Bridge] operator mute', { sessionId: session.id, muted: body.muted });
      res.json({ ok: true, operatorMuted: body.muted });
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
        operatorInitiated: true,
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

      // Conference-participant events identify the participant by
      // call_control_id and may omit our client_state, so look the session up
      // by that id when the state is absent. Everything else needs client_state.
      const participantCcid = () =>
        typeof payload.call_control_id === 'string'
          ? payload.call_control_id
          : typeof (payload.participant as Record<string, unknown> | undefined)?.call_control_id === 'string'
            ? ((payload.participant as Record<string, unknown>).call_control_id as string)
            : undefined;
      let session: typeof callBridgeSessions.$inferSelect | undefined;
      if (state) {
        [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.id, state.sessionId)).limit(1);
      } else if (eventType.startsWith('conference.participant.')) {
        const ccid = participantCcid();
        if (ccid) {
          [session] = await db.select().from(callBridgeSessions).where(eq(callBridgeSessions.aiCallControlId, ccid)).limit(1);
        }
      }
      // Not one of ours — ack and ignore.
      if (!session) {
        res.status(200).json({ received: true });
        return;
      }

      // Conference-participant events are the ONLY authoritative proof the AI
      // actually joined the bridge, and they carry no client_state — handle
      // them before the state-dependent events below.
      if (eventType === 'conference.participant.joined' || eventType === 'conference.participant.left') {
        const ccid = participantCcid();
        if (session.aiCallControlId && ccid && ccid === session.aiCallControlId) {
          if (eventType === 'conference.participant.joined') {
            await db
              .update(callBridgeSessions)
              .set({ status: 'ai_joined', lastError: null, updatedAt: new Date() })
              .where(eq(callBridgeSessions.id, session.id));
            console.info('[Call Bridge] AI conference participant joined', { sessionId: session.id, callControlId: ccid });
          } else if (session.status === 'ai_joined') {
            await db
              .update(callBridgeSessions)
              .set({ status: 'active', aiCallControlId: null, aiMuted: true, updatedAt: new Date() })
              .where(eq(callBridgeSessions.id, session.id));
          }
        }
        res.status(200).json({ received: true });
        return;
      }

      // Everything below keys off the dialed leg's client_state.
      if (!state) {
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
            operatorInitiated: session.createdByAgentId === 'operator',
          });
          if ('error' in result) {
            await db
              .update(callBridgeSessions)
              .set({ status: 'failed', lastError: result.error, updatedAt: new Date() })
              .where(eq(callBridgeSessions.id, session.id));
          } else {
            await recordCustomerLegDialed(session.id, result.callControlId);
          }
          // The operator's leg has now entered the conference, so the muted
          // listening AI can join it. Dialed any earlier it has no conference to
          // join and never reaches the bridge — which is silence on takeover.
          if (session.aiAutoJoin && aiLegTransport() === 'leg' && !session.aiCallControlId) {
            await dialAiLegMuted(session, { operatorInitiated: true });
          }
        } else if (state.role === 'customer') {
          await db.update(callBridgeSessions).set({ status: 'active', updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
          if ((session.sessionMode ?? 'operator_first') === 'ai_first') {
            // ai_first exists so the AI is the one talking to the buyer from
            // pickup: it joins the bridge already handed the call.
            await attachSalesAi(session.id, { phase: 'call_start', unmuteNow: true, operatorInitiated: true });
          }
        } else if (state.role === 'ai') {
          // Answering the call is NOT joining the conference. Only the legacy
          // attach transport (which has no conference leg of its own) treats an
          // answer as joined; the leg transport waits for the authoritative
          // conference.participant.joined event handled above.
          if (aiLegTransport() === 'attach') {
            await db.update(callBridgeSessions).set({ status: 'ai_joined', updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
          }
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
            .set({ status: session.status === 'ended' ? 'ended' : 'active', aiCallControlId: null, aiMuted: true, updatedAt: new Date() })
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
