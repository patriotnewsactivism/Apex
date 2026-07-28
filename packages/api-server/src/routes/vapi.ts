import { Router } from 'express';

// ─── Vapi Webhook Route ──────────────────────────────────────────────────────
//
// Receives server events from Vapi.ai (end-of-call-report, status-update,
// transcript, etc.) when an outbound AI call completes. Mounted BEFORE
// requireAdminAuth because Vapi's server can't send a Bearer token — it's
// a server-to-server webhook. Optionally protected by a shared-secret
// header (VAPI_WEBHOOK_SECRET) if configured.
//
// The webhook logs call outcomes (transcript, analysis, cost) to the
// standard logs table so they appear in the dashboard's Log Stream.

export function createVapiWebhookRouter(): Router {
  const router = Router();

  router.post('/webhook', async (req, res) => {
    try {
      // Optional shared-secret verification
      const secret = process.env.VAPI_WEBHOOK_SECRET;
      if (secret) {
        const received = req.headers['x-webhook-secret'] as string | undefined;
        if (received !== secret) {
          res.status(403).json({ error: 'Invalid webhook secret' });
          return;
        }
      }

      const message = req.body?.message;
      if (!message || !message.type) {
        res.status(200).json({ received: true });
        return;
      }

      const { db, logs } = await import('@workspace/db');
      const now = new Date();

      switch (message.type) {
        case 'end-of-call-report': {
          const call = message.call ?? {};
          const analysis = call.analysis ?? {};
          const transcript = call.artifact?.transcript ?? message.artifact?.transcript ?? '';
          const endedReason = message.endedReason ?? call.endedReason ?? 'unknown';
          const cost = call.cost ?? 0;

          // Log the call outcome
          await db.insert(logs).values({
            agentId: 'apex-sales-001',
            taskId: null,
            level: 'info',
            message: `📞 Outbound call ended — ${endedReason}. Cost: $${Number(cost).toFixed(2)}. Summary: ${analysis.summary ?? 'N/A'}${transcript ? ` | Transcript: ${transcript.slice(0, 500)}...` : ''}`,
            timestamp: now,
          });

          console.log(`[Vapi] Call ended: ${call.id}, reason: ${endedReason}, cost: $${cost}, summary: ${(analysis.summary ?? '').slice(0, 100)}`);
          break;
        }

        case 'status-update': {
          const status = message.status ?? 'unknown';
          const callId = message.call?.id ?? 'unknown';
          console.log(`[Vapi] Call ${callId} status: ${status}`);

          if (status === 'ringing' || status === 'in-progress') {
            await db.insert(logs).values({
              agentId: 'apex-sales-001',
              taskId: null,
              level: 'acting',
              message: `📞 Outbound call ${status}${callId !== 'unknown' ? ` (ID: ${callId})` : ''}`,
              timestamp: now,
            });
          }
          break;
        }

        case 'transcript': {
          // Don't log partial transcripts — only final
          if (message.transcriptType === 'final') {
            console.log(`[Vapi] Final transcript segment received`);
          }
          break;
        }

        default:
          // Other event types (speech-update, conversation-update, etc.)
          // are informational — no action needed.
          break;
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[Vapi] Webhook error:', err instanceof Error ? err.message : String(err));
      res.status(200).json({ received: true }); // Always return 200 so Vapi doesn't retry
    }
  });

  return router;
}
