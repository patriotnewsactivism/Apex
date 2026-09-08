import { Router } from 'express';
import type { Request } from 'express';
import crypto from 'crypto';

// ─── Resend Webhook Route ──────────────────────────────────────────────────────
//
// Receives delivery-lifecycle events from Resend for outbound sales email sent
// via send_email / send_email_campaign_batch (packages/core/src/tool-registry.ts).
// Mounted BEFORE requireAdminAuth in index.ts because Resend's server can't
// send our Bearer token — it's a server-to-server webhook, authenticated
// instead by a Svix HMAC signature over the raw request body.
//
// Unlike vapi.ts's webhook (a simple constant-time shared-secret header
// compare), Resend signs webhooks the way Svix does: HMAC-SHA256 over
// "{svix-id}.{svix-timestamp}.{body}", keyed by the base64 payload of
// RESEND_WEBHOOK_SECRET after its "whsec_" prefix. That requires the EXACT
// raw request bytes, not a re-serialized req.body — see the `verify` callback
// on express.json() in index.ts, which stashes them on req.rawBody for
// exactly this route.
//
// Every event carries Resend's own email id in data.email_id. We correlate
// purely on that id against email_sends.providerId — set by tool-registry.ts
// the moment Resend accepts a send — and never trust anything else the
// webhook body claims about which campaign/lead/agent this was. A webhook hit
// for an id we don't recognize (sent before this route existed, or sent
// through a different Resend account/key) is logged and ignored, not errored.

const SVIX_TOLERANCE_SECONDS = 5 * 60; // reject events signed more than 5 minutes off "now" — replay protection

function verifySvixSignature(
  secretHeaderValue: string,
  svixId: string,
  svixTimestamp: string,
  rawBody: Buffer,
  svixSignatureHeader: string,
): boolean {
  // Resend/Svix secrets look like "whsec_base64bytes"; the HMAC key is the
  // decoded bytes after the prefix, not the literal string.
  const secretB64 = secretHeaderValue.startsWith('whsec_') ? secretHeaderValue.slice('whsec_'.length) : secretHeaderValue;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secretB64, 'base64');
  } catch {
    return false;
  }

  const tsNum = Number(svixTimestamp);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > SVIX_TOLERANCE_SECONDS) {
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected);

  // svix-signature can carry multiple space-separated "v1,<sig>" values
  // (e.g. during a secret rotation); any valid v1 match is accepted.
  for (const part of svixSignatureHeader.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(sig, 'base64');
    } catch {
      continue;
    }
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

export function createResendWebhookRouter(): Router {
  const router = Router();

  router.post('/webhook', async (req, res) => {
    try {
      const secret = process.env.RESEND_WEBHOOK_SECRET;
      if (!secret) {
        console.error('[Resend] RESEND_WEBHOOK_SECRET is not configured; rejecting webhook');
        return res.status(500).json({ error: 'Webhook secret not configured' });
      }

      const svixId = req.headers['svix-id'] as string | undefined;
      const svixTimestamp = req.headers['svix-timestamp'] as string | undefined;
      const svixSignature = req.headers['svix-signature'] as string | undefined;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

      if (!svixId || !svixTimestamp || !svixSignature || !rawBody) {
        return res.status(403).json({ error: 'Missing signature headers' });
      }
      if (!verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSignature)) {
        return res.status(403).json({ error: 'Invalid webhook signature' });
      }

      const event = req.body as { type?: string; data?: Record<string, unknown> };
      const type = event?.type;
      const data = event?.data ?? {};
      const providerId = typeof data.email_id === 'string' ? data.email_id : undefined;

      if (!type || !providerId) {
        return res.status(200).json({ received: true });
      }

      const { db, emailSends, emailSuppressions } = await import('@workspace/db');
      const { eq } = await import('drizzle-orm');

      const [row] = await db.select().from(emailSends).where(eq(emailSends.providerId, providerId)).limit(1);
      if (!row) {
        // Not one of ours (or predates this route) — ack so Resend stops
        // retrying, but don't pretend we processed anything.
        console.log(`[Resend] Webhook for unknown email_id ${providerId} (${type}) — ignored`);
        return res.status(200).json({ received: true, matched: false });
      }

      const now = new Date();
      switch (type) {
        case 'email.delivered':
          await db.update(emailSends).set({ status: 'delivered', deliveredAt: now }).where(eq(emailSends.id, row.id));
          break;
        case 'email.opened':
          await db.update(emailSends).set({ status: 'opened', openedAt: row.openedAt ?? now }).where(eq(emailSends.id, row.id));
          break;
        case 'email.clicked':
          await db.update(emailSends).set({ status: 'clicked', clickedAt: row.clickedAt ?? now }).where(eq(emailSends.id, row.id));
          break;
        case 'email.bounced': {
          await db.update(emailSends).set({ status: 'bounced', bouncedAt: now }).where(eq(emailSends.id, row.id));
          // Auto-suppress: a bounced address must never be re-emailed by a
          // later campaign. onConflictDoNothing — a manual suppression
          // already covering this address should not be overwritten.
          await db.insert(emailSuppressions)
            .values({ email: row.toEmail, reason: 'bounced', createdAt: now })
            .onConflictDoNothing();
          break;
        }
        case 'email.complained': {
          await db.update(emailSends).set({ status: 'complained', complainedAt: now }).where(eq(emailSends.id, row.id));
          await db.insert(emailSuppressions)
            .values({ email: row.toEmail, reason: 'complained', createdAt: now })
            .onConflictDoNothing();
          console.warn(`[Resend] SPAM COMPLAINT from ${row.toEmail} (send ${row.id}) — address suppressed`);
          break;
        }
        case 'email.delivery_delayed':
          console.log(`[Resend] Delivery delayed for send ${row.id} (${row.toEmail})`);
          break;
        case 'email.failed':
          await db.update(emailSends).set({ status: 'failed', errorMessage: 'Resend reported delivery failure post-send' }).where(eq(emailSends.id, row.id));
          break;
        default:
          break;
      }

      return res.status(200).json({ received: true, matched: true });
    } catch (err) {
      console.error('[Resend] Webhook error:', err instanceof Error ? err.message : String(err));
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}
