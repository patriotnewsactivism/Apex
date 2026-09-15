import { Router } from 'express';
import crypto from 'crypto';
import { db, researchedLeads, logs } from '@workspace/db';
import { eq, or } from 'drizzle-orm';
import type { ApexCEO } from '@workspace/agents';

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
//
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
  const candidates = [
    body.telnyx_end_user_target,
    body.end_user_target,
    body.from,
    body.caller_number,
    (body.call as Record<string, unknown> | undefined)?.from,
    (body.payload as Record<string, unknown> | undefined)?.from,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
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
  const candidates = await db
    .select()
    .from(researchedLeads)
    .where(or(eq(researchedLeads.contactPhone, phone), eq(researchedLeads.contactPhone, `+1${norm}`)))
    .limit(5);
  return candidates.find((c) => normalizePhone(c.contactPhone) === norm) ?? null;
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
      const lead = await findKnownCaller(callerNumber);

      console.log('[Telnyx Assistant] dynamic-variables request', {
        callerNumber: callerNumber || '(none found in payload)',
        knownCaller: Boolean(lead),
      });

      return res.json({
        dynamic_variables: {
          caller_number: callerNumber || 'unknown',
          is_known_caller: Boolean(lead),
          caller_company: lead?.companyName ?? '',
          caller_context: lead?.outreachAngle ?? '',
        },
      });
    } catch (err) {
      console.error('[Telnyx Assistant] dynamic-variables error:', err instanceof Error ? err.message : String(err));
      // A blank variable set beats failing conversation start entirely.
      return res.json({ dynamic_variables: { caller_number: '', is_known_caller: false } });
    }
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
          try {
            const smsRes = await fetch('https://api.telnyx.com/v2/messages', {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from,
                to: toPhone,
                text: `Apex: thanks for calling — we received your message about "${reason}" and will follow up soon.`,
              }),
            });
            if (!smsRes.ok) {
              errors.push(`sms: Telnyx returned ${smsRes.status}`);
            } else {
              sentVia.push('sms');
            }
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

      const goalId = await ceo.submitGoal(
        `Front desk SMS: ${from}`,
        `An inbound text arrived at the Apex front desk number from ${from}: "${text}". Follow up directly.`,
        CALLER_NAME_GOAL_PRIORITY_NORMAL,
      );

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
