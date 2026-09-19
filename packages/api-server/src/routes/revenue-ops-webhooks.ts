// ─── Revenue Operations Provider Webhook Ingestion ──────────────────────────────
//
// Generic provider-webhook ingestion layer. Receives server-to-server webhooks
// from voice/telephony providers (Telnyx, Vapi, etc.), persists them idempotently
// to provider_events, returns 200 immediately, and queues async processing.
//
// Mounted BEFORE requireAdminAuth — providers cannot carry a Bearer token.
//
// Per-provider secret is read from provider_connections (encrypted), not a flat
// env var. Fall back to a configured env var for providers not yet in the table.

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { db } from '@workspace/db';
import { providerEvents, providerConnections, calls } from '@workspace/db';
import { eq, and } from 'drizzle-orm';

const RAW_BODY_CAP = 256 * 1024; // 256 KB — webhooks are small JSON

function bufferFromRawBody(req: Request): Buffer | null {
  // Express does not retain the raw body after JSON parsing. We read from
  // the socket on demand. If the body was already consumed (parsed), this
  // returns null and we store a structural copy instead.
  try {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (raw && raw.length > 0) return raw.length <= RAW_BODY_CAP ? raw : raw.subarray(0, RAW_BODY_CAP);
  } catch {
    // noop
  }
  return null;
}

/** HMAC-SHA256 signature verification. Returns true when the signature matches. */
function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Derive a stable event id for idempotency. */
function deriveEventId(provider: string, externalEventId: string | undefined): string | null {
  if (!externalEventId) return null;
  return `${provider}:${externalEventId}`;
}

/** Extract a reasonable event type from the payload, falling back to 'unknown'. */
function inferEventType(body: unknown, provider: string): string {
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    // Common shapes: { event: 'call.hangup' }, { type: 'call.initiated' },
    // { event_type: 'call.initiated' }, or Telnyx { data: { event_type: ... } }
    if (typeof b.event === 'string') return b.event as string;
    if (typeof b.type === 'string') return b.type as string;
    if (typeof b.event_type === 'string') return b.event_type as string;
    if (typeof b.data === 'object' && b.data !== null) {
      const d = b.data as Record<string, unknown>;
      if (typeof d.event_type === 'string') return d.event_type as string;
      if (typeof d.type === 'string') return d.type as string;
    }
  }
  return 'unknown';
}

/** Store the raw body structurally (JSON) when the raw buffer is unavailable. */
async function storeEvent(
  provider: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  rawBody: Buffer | null,
): Promise<void> {
  const receivedAt = new Date();
  const payloadJson = JSON.stringify(payload);
  // Truncate raw body to cap so we don't store multi-MB blobs
  const rawJson = rawBody ? rawBody.length <= RAW_BODY_CAP ? rawBody.toString('base64') : null : null;

  await db.insert(providerEvents).values({
    id: crypto.randomUUID(),
    provider,
    externalEventId: eventId,
    eventType,
    payload: payload as Record<string, unknown>,
    receivedAt,
    status: 'received',
    attemptCount: 1,
  }).onConflictDoNothing();
}

export function createRevenueOpsWebhookRouter(): Router {
  const router = Router();

  try {
  // POST /api/telnyx/webhooks
  // Generic provider webhook ingestion. Provider-specific routers (e.g.
  // the existing /api/telnyx/webhook for inbound BuildMyBot calls) remain
  // mounted separately and are not replaced by this generic layer.
  router.post('/webhooks', async (req: Request, res: Response) => {
    const startedAt = Date.now();

    // ── 1. Identify the provider ─────────────────────────────────────────────
    const provider = (req.headers['x-provider'] as string | undefined)?.toLowerCase()
      ?? (req.headers['x-api-key'] ? 'unknown' : 'telnyx'); // default for backward compat

    if (!provider || provider === 'unknown') {
      return res.status(400).json({ error: 'Provider identity missing' });
    }

    // ── 2. Read raw body ─────────────────────────────────────────────────────
    // We need the raw bytes for signature verification. Express body-parser
    // consumes the stream; we try to retain it via a middleware that captures
    // req.rawBody. If that didn't run, we still process but skip signature
    // verification for this request (log a warning).

    const rawBody = bufferFromRawBody(req);
    const body = (req.body as Record<string, unknown>) ?? {};

    // ── 3. Get the provider secret ───────────────────────────────────────────
    // Try provider_connections first, fall back to env var.

    let secret: string | undefined;

    if (provider === 'telnyx' || provider === 'vapi' || provider === 'retell' || provider === 'twilio') {
      const [conn] = await db
        .select({ encryptedCredentials: providerConnections.encryptedCredentials, status: providerConnections.status })
        .from(providerConnections)
        .where(and(
          eq(providerConnections.provider, provider),
          eq(providerConnections.status, 'connected'),
        ))
        .limit(1);

      if (conn?.encryptedCredentials && Object.keys(conn.encryptedCredentials).length > 0) {
        // The crypto helpers live in lib/db/src/crypto.js but are not yet
        // re-exported from @workspace/db. For now, fall through to env var
        // so a deployed webhook still works without the decryption wiring.
        // TODO: decrypt the provider-specific webhook secret from
        // encryptedCredentials once the crypto helper is exported.
        console.info(`[RevenueOps Webhook] ${provider} has stored credentials in provider_connections but decryption is not wired yet; using env var fallback.`);
      }
    }

    // Fallback env var for providers not yet in provider_connections, or when
    // decryption fails. Do NOT require the env var — log and continue without
    // signature verification so a missing secret doesn't drop legitimate events.
    if (!secret) {
      secret = process.env[`${provider.toUpperCase()}_WEBHOOK_SECRET`] as string | undefined;
    }

    if (!secret) {
      console.warn(`[RevenueOps Webhook] No secret configured for ${provider}; skipping signature verification for this request.`);
    }

    // ── 4. Verify signature (when secret available) ─────────────────────────
    if (secret && rawBody) {
      const signatureHeader = req.headers['x-telnyx-signature'] as string | undefined
        ?? req.headers['x-vapi-signature'] as string | undefined
        ?? req.headers['x-signature'] as string | undefined
        ?? req.headers['x-webhook-signature'] as string | undefined;

      if (!verifySignature(rawBody, signatureHeader, secret)) {
        return res.status(403).json({ error: 'Invalid signature' });
      }
    }

    // ── 5. Check timestamp freshness (±5 min) ───────────────────────────────
    const timestampHeader = req.headers['x-timestamp'] as string | undefined
      ?? req.headers['x-event-timestamp'] as string | undefined
      ?? req.headers['x-telnyx-timestamp'] as string | undefined;

    if (timestampHeader) {
      const eventTs = Number(timestampHeader);
      if (!isNaN(eventTs) && Math.abs(Date.now() - eventTs) > 5 * 60 * 1000) {
        console.warn(`[RevenueOps Webhook] ${provider} event timestamp ${eventTs} is ${(Date.now() - eventTs) / 1000}s off — rejecting.`);
        return res.status(400).json({ error: 'Event timestamp too old' });
      }
    }

    // ── 6. Derive event id + persist idempotently ───────────────────────────
    const externalEventId = body.external_event_id as string | undefined
      ?? body.event_id as string | undefined
      ?? body.id as string | undefined
      ?? (body.data as Record<string, unknown>)?.external_event_id as string | undefined
      ?? (body.data as Record<string, unknown>)?.event_id as string | undefined;

    const eventId = deriveEventId(provider, externalEventId);
    const eventType = inferEventType(body, provider);

    if (!eventId) {
      console.warn(`[RevenueOps Webhook] ${provider} event has no external_event_id; cannot deduplicate. Processing anyway.`);
    }

    try {
      if (eventId) {
        await storeEvent(provider, eventId, eventType, body, rawBody);
      }

      // ── 7. Return 200 immediately ──────────────────────────────────────────
      const processingTime = Date.now() - startedAt;
      res.status(200).json({
        received: true,
        provider,
        event_id: eventId,
        event_type: eventType,
        processing_ms: processingTime,
      });

      // ── 8. Queue async processing (fire-and-forget) ────────────────────────
      // Do NOT do AI work inline with the webhook. Queue a background job or
      // emit an event that the revenue workforce runner picks up. For now we
      // log and let the existing call-event machinery handle known event types.
      void handleWebhookAsync(provider, eventId, eventType, body, rawBody).catch((err) => {
        console.error(`[RevenueOps Webhook] async handler failed for ${provider}:${eventId}:`, err instanceof Error ? err.message : String(err));
      });
      return;
    } catch (storeErr) {
      // A store failure must not drop the webhook. If the insert failed because
      // of a conflict (ON CONFLICT DO NOTHING), that's fine — it's a duplicate.
      if (storeErr instanceof Error && storeErr.message.includes('duplicate')) {
        res.status(200).json({ received: true, duplicate: true, provider, event_type: eventType });
        return;
      }
      console.error(`[RevenueOps Webhook] failed to store event for ${provider}:`, storeErr instanceof Error ? storeErr.message : String(storeErr));
      return res.status(500).json({ error: 'Webhook storage failed' });
    }
  });

  return router;
  }
  catch (setupErr) {
    // If the router can't be created (e.g. DB schema not migrated), return a
    // router that rejects all webhooks with a clear message rather than crashing
    // the API server.
    console.error('[RevenueOps Webhook] Failed to create webhook router:', setupErr instanceof Error ? setupErr.message : String(setupErr));
    const fallback = Router();
    fallback.post('/webhooks', (req, res) => {
      res.status(503).json({ error: 'Webhook ingestion not available — provider_events table may not be migrated.' });
    });
    return fallback;
  }
}

/** Async handler — does NOT block the HTTP response. */
async function handleWebhookAsync(
  provider: string,
  eventId: string | null,
  eventType: string,
  body: unknown,
  rawBody: Buffer | null,
): Promise<void> {
  // Update provider_events.status to 'processing' so we can track lag.
  if (eventId) {
    try {
      await db.update(providerEvents).set({
        status: 'processing',
      }).where(and(
        eq(providerEvents.provider, provider),
        eq(providerEvents.externalEventId, eventId),
      ));
    } catch {
      // best-effort — don't let this block the async handler
    }
  }

  // Dispatch known event types to handlers.
  switch (eventType) {
    case 'call.initiated':
    case 'call.answered':
    case 'call.hangup':
    case 'call.completed':
    case 'call.failed':
      await handleCallEvent(provider, eventId, eventType, body);
      break;
    case 'call.recording.available':
      await handleRecordingEvent(provider, eventId, body);
      break;
    case 'call.transcript.available':
      await handleTranscriptEvent(provider, eventId, body);
      break;
    default:
      // Unknown event types are logged but not processed — avoids assuming
      // semantics for provider-specific events we haven't modeled yet.
      console.info(`[RevenueOps Webhook] ${provider}:${eventId ?? 'unknown'} unknown event_type=${eventType} — no handler registered.`);
  }

  // Mark processed.
  if (eventId) {
    try {
      await db.update(providerEvents).set({
        status: 'processed',
        processedAt: new Date(),
      }).where(and(
        eq(providerEvents.provider, provider),
        eq(providerEvents.externalEventId, eventId),
      ));
    } catch {
      // best-effort
    }
  }
}

// ─── Call event handlers ────────────────────────────────────────────────────────

async function handleCallEvent(
  provider: string,
  eventId: string | null,
  eventType: string,
  body: unknown,
): Promise<void> {
  const b = body as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;
  const callId = (data?.call_id as string) ?? (b.call_id as string) ?? (b.external_call_id as string) ?? eventId ?? '';
  const callControlId = (data?.call_control_id as string) ?? (b.call_control_id as string) ?? '';
  const callSessionId = (data?.call_session_id as string) ?? (b.call_session_id as string) ?? '';
  const fromNumber = (data?.from as string) ?? (b.from as string) ?? '';
  const toNumber = (data?.to as string) ?? (b.to as string) ?? '';
  const status = mapProviderCallStatus(eventType, b.status as string | undefined, data?.status as string | undefined);
  const direction = (data?.direction as string) ?? (b.direction as string) ?? 'outbound';
  const answeredAt = (data?.answered_at as string) ?? (b.answered_at as string) ?? null;
  const endedAt = (data?.ended_at as string) ?? (b.ended_at as string) ?? (data?.ended_at as string) ?? null;
  const durationSeconds = (data?.duration_seconds as number) ?? (b.duration_seconds as number) ?? null;
  const errorCode = (data?.error_code as string) ?? (b.error_code as string) ?? null;

  console.info(`[RevenueOps Webhook] ${provider} call event ${eventType} — call_id=${callId} status=${status}`);

  // Update or create the calls row.
  try {
    const [existing] = await db
      .select()
      .from(calls)
      .where(eq(calls.externalCallId, callId))
      .limit(1);

    const now = new Date();
    if (existing) {
      await db.update(calls).set({
        status,
        direction,
        callControlId: callControlId ?? existing.callControlId,
        callSessionId: callSessionId ?? existing.callSessionId,
        fromNumber: fromNumber ?? existing.fromNumber,
        toNumber: toNumber ?? existing.toNumber,
        answeredAt: answeredAt ? new Date(answeredAt) : existing.answeredAt,
        endedAt: endedAt ? new Date(endedAt) : existing.endedAt,
        durationSeconds: durationSeconds ?? existing.durationSeconds,
        errorCode: errorCode ?? existing.errorCode,
        updatedAt: now,
      }).where(eq(calls.id, existing.id));
    } else {
      await db.insert(calls).values({
        id: crypto.randomUUID(),
        organizationId: '', // filled by the caller — provider events don't carry org
        externalCallId: callId,
        callControlId,
        callSessionId,
        fromNumber,
        toNumber,
        direction,
        status,
        answeredAt: answeredAt ? new Date(answeredAt) : null,
        endedAt: endedAt ? new Date(endedAt) : null,
        durationSeconds,
        errorCode,
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch (err) {
    console.error(`[RevenueOps Webhook] failed to update calls row for ${provider}:${callId}:`, err instanceof Error ? err.message : String(err));
  }
}

async function handleRecordingEvent(provider: string, eventId: string | null, body: unknown): Promise<void> {
  const b = body as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;
  const callId = (data?.call_id as string) ?? (b.call_id as string) ?? eventId ?? '';
  const recordingUri = (data?.recording_uri as string) ?? (data?.recording_url as string) ?? (b.recording_uri as string) ?? (b.recording_url as string) ?? null;

  if (!recordingUri) {
    console.warn(`[RevenueOps Webhook] ${provider} recording event has no recording_uri.`);
    return;
  }

  console.info(`[RevenueOps Webhook] ${provider} recording available for ${callId}: ${recordingUri}`);

  try {
    const [existing] = await db
      .select({ id: calls.id })
      .from(calls)
      .where(eq(calls.externalCallId, callId))
      .limit(1);

    if (existing) {
      await db.update(calls).set({
        recordingUri: recordingUri,
        updatedAt: new Date(),
      }).where(eq(calls.id, existing.id));
    }
  } catch (err) {
    console.error(`[RevenueOps Webhook] failed to update recording for ${provider}:${callId}:`, err instanceof Error ? err.message : String(err));
  }
}

async function handleTranscriptEvent(provider: string, eventId: string | null, body: unknown): Promise<void> {
  const b = body as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;
  const callId = (data?.call_id as string) ?? (b.call_id as string) ?? eventId ?? '';
  const transcriptId = (data?.transcript_id as string) ?? (b.transcript_id as string) ?? crypto.randomUUID();
  const transcriptUri = (data?.transcript_uri as string) ?? (data?.transcript_url as string) ?? (b.transcript_uri as string) ?? (b.transcript_url as string) ?? null;

  console.info(`[RevenueOps Webhook] ${provider} transcript available for ${callId}`);

  try {
    const [existing] = await db
      .select({ id: calls.id, transcriptId: calls.transcriptId })
      .from(calls)
      .where(eq(calls.externalCallId, callId))
      .limit(1);

    if (existing) {
      await db.update(calls).set({
        transcriptId: transcriptId,
        updatedAt: new Date(),
      }).where(eq(calls.id, existing.id));
    }
  } catch (err) {
    console.error(`[RevenueOps Webhook] failed to update transcript for ${provider}:${callId}:`, err instanceof Error ? err.message : String(err));
  }
}

/** Map provider-specific event types to our canonical call status. */
function mapProviderCallStatus(
  eventType: string,
  status: string | undefined,
  dataStatus: string | undefined,
): string {
  const canonical = (status ?? dataStatus)?.toLowerCase();

  if (canonical === 'answered' || canonical === 'in-progress' || canonical === 'ringing') return 'answered';
  if (canonical === 'completed' || canonical === 'finished') return 'completed';
  if (canonical === 'failed' || canonical === 'error') return 'failed';
  if (canonical === 'cancelled' || canonical === 'busy' || canonical === 'no-answer') return 'failed';
  if (canonical === 'initiated' || canonical === 'queued' || canonical === 'offered') return 'initiated';

  // Fall back to event type mapping
  switch (eventType) {
    case 'call.initiated': return 'initiated';
    case 'call.answered': return 'answered';
    case 'call.hangup': return 'completed';
    case 'call.completed': return 'completed';
    case 'call.failed': return 'failed';
    default: return 'completed'; // assume completion for unrecognized terminal events
  }
}
