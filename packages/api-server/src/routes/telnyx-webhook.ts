import { Router } from 'express';
import crypto from 'crypto';
import { answerAndStartStreaming } from '../telnyx-deepgram-agent.js';

// ─── Telnyx Webhook Route ─────────────────────────────────────────────────────
//
// Receives HTTP webhooks from Telnyx for inbound BuildMyBot calls.
// Mounted BEFORE requireAdminAuth (Telnyx cannot carry a Bearer token).
// Protected by TELNYX_WEBHOOK_SECRET via timing-safe comparison.
//
// Handled events:
//   call.initiated  — inbound call arrived; answer it and start PCMU streaming
//   call.hangup     — call ended; nothing to do server-side (WS cleanup handles it)
//
// The stream WebSocket URL is derived from PUBLIC_URL env var (same as other
// external-facing URL references in APEX). The call_control_id is passed as a
// query parameter so DeepgramVoiceSession can call Telnyx call-control APIs
// for barge-in clearing and transfers.

export function createTelnyxWebhookRouter(): Router {
  const router = Router();

  router.post('/webhook', async (req, res) => {
    try {
      // ── Secret verification ───────────────────────────────────────────────
      const secret = process.env.TELNYX_WEBHOOK_SECRET;

      if (!secret) {
        console.error(
          '[Telnyx Webhook] TELNYX_WEBHOOK_SECRET is not configured; rejecting webhook.',
        );
        return res.status(500).json({ error: 'Webhook secret not configured' });
      }

      const received = req.headers['x-webhook-secret'] as string | undefined;

      if (!received || received.length !== secret.length) {
        return res.status(403).json({ error: 'Invalid webhook secret' });
      }

      try {
        if (
          !crypto.timingSafeEqual(
            Buffer.from(received),
            Buffer.from(secret),
          )
        ) {
          return res.status(403).json({ error: 'Invalid webhook secret' });
        }
      } catch {
        return res.status(403).json({ error: 'Invalid webhook secret' });
      }

      // ── Event dispatch ────────────────────────────────────────────────────
      const event = req.body?.data;

      if (!event?.event_type) {
        return res.status(200).json({ received: true });
      }

      const payload = event.payload ?? {};
      const callControlId: string = payload.call_control_id ?? '';
      const callerNumber: string = payload.from ?? '';

      console.info(
        `[Telnyx Webhook] ${event.event_type} — call_control_id=${callControlId}`,
      );

      switch (event.event_type) {
        case 'call.initiated': {
          // Answer inbound calls only (direction === 'incoming').
          if (payload.direction !== 'incoming') {
            console.info(
              `[Telnyx Webhook] Skipping outbound leg ${callControlId}`,
            );
            break;
          }

          if (!callControlId) {
            console.error(
              '[Telnyx Webhook] call.initiated missing call_control_id',
            );
            break;
          }

          const publicUrl =
            process.env.PUBLIC_URL ?? 'https://apex.donmatthews.live';

          const streamUrl = `wss://${new URL(publicUrl).host}/api/voice/telnyx-media?call_control_id=${encodeURIComponent(callControlId)}&caller=${encodeURIComponent(callerNumber)}`;

          // Fire-and-forget: answer + streaming_start must complete before
          // Telnyx times out the call (~30 s), but we don't want to hold
          // the HTTP response open for both round trips.
          void answerAndStartStreaming(callControlId, streamUrl).catch(
            (err: unknown) => {
              console.error(
                `[Telnyx Webhook] answerAndStartStreaming failed for ${callControlId}:`,
                err instanceof Error ? err.message : String(err),
              );
            },
          );

          break;
        }

        case 'call.hangup':
          // Telnyx closes the media WebSocket on hangup; DeepgramVoiceSession
          // handles cleanup via the 'stop' event or WS close. No action needed.
          console.info(
            `[Telnyx Webhook] Hangup for ${callControlId}: ${payload.hangup_cause ?? 'unknown'}`,
          );
          break;

        default:
          break;
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      console.error(
        '[Telnyx Webhook] Unhandled error:',
        err instanceof Error ? err.message : String(err),
      );
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}
