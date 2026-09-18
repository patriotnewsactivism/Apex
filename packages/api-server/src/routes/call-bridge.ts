import { Router } from 'express';
import crypto from 'crypto';
import { db, callBridgeSessions } from '@workspace/db';
import { eq } from 'drizzle-orm';
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

interface ClientState {
  sessionId: string;
  role: 'operator' | 'customer' | 'ai';
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
      ((parsed as Record<string, unknown>).role === 'operator' ||
        (parsed as Record<string, unknown>).role === 'customer' ||
        (parsed as Record<string, unknown>).role === 'ai')
    ) {
      return parsed as unknown as ClientState;
    }
  } catch {
    // Not ours — fall through to null.
  }
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
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
}): Promise<{ callControlId: string } | { error: string }> {
  const apiKey = process.env.TELNYX_API_KEY;
  const connectionId = process.env.TELNYX_CALL_BRIDGE_CONNECTION_ID;
  const from = process.env.APEX_FRONT_DESK_NUMBER;
  if (!apiKey || !connectionId || !from) {
    return { error: 'TELNYX_API_KEY, TELNYX_CALL_BRIDGE_CONNECTION_ID, or APEX_FRONT_DESK_NUMBER is not configured.' };
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
          end_conference_on_exit: params.endConferenceOnExit,
        },
      }),
    });
    const json = (await res.json().catch(() => null)) as
      | { data?: { call_control_id?: string }; errors?: Array<{ detail?: string }> }
      | null;
    if (!res.ok) {
      return { error: json?.errors?.[0]?.detail ?? `Telnyx returned ${res.status}` };
    }
    const callControlId = json?.data?.call_control_id;
    if (!callControlId) {
      return { error: 'Telnyx accepted the dial but did not return a call_control_id.' };
    }
    return { callControlId };
  } catch (err) {
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
            await db
              .update(callBridgeSessions)
              .set({ customerCallControlId: result.callControlId, updatedAt: new Date() })
              .where(eq(callBridgeSessions.id, session.id));
          }
        } else if (state.role === 'customer') {
          await db.update(callBridgeSessions).set({ status: 'active', updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
        } else if (state.role === 'ai') {
          await db.update(callBridgeSessions).set({ status: 'ai_joined', updatedAt: new Date() }).where(eq(callBridgeSessions.id, session.id));
        }
      } else if (eventType === 'call.hangup') {
        const cause = typeof payload.hangup_cause === 'string' ? payload.hangup_cause : 'unknown';
        if (state.role === 'ai') {
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
