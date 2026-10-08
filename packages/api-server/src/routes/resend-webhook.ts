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

export const SVIX_TOLERANCE_SECONDS = 5 * 60; // reject events signed more than 5 minutes off "now" — replay protection

export function verifySvixSignature(
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
  // digest('base64') returns the base64 STRING; Buffer.from(expected) alone
  // would default to utf8 and re-encode that string's characters (44 bytes
  // for a 32-byte SHA-256 digest) instead of decoding it back to raw HMAC
  // bytes. That made every real Resend webhook fail the length check below
  // and get rejected as an "Invalid webhook signature" — never a security
  // hole (fail-closed), but a total observability blackout: no delivery,
  // bounce, complaint, open, or click event has ever actually been recorded.
  const expectedBuf = Buffer.from(expected, 'base64');

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

// ─── Monotonic status transitions ───────────────────────────────────────────────
//
// emailSends.status is the authoritative funnel field. summarizeEmailCampaign()
// (src/routes/email-campaigns.ts) computes queued/sent/delivered/opened/clicked/
// bounced/complained/failed/suppressed purely by counting distinct status values,
// and its own header comment states a row is "queued, then exactly one of
// sent/delivered/opened/clicked/bounced/complained/failed/suppressed, never more
// than one at a time."
//
// Resend delivers these events through Svix, which retries with backoff, so the
// same event can be redelivered late and events can arrive out of order. The
// old handler wrote status unconditionally from the event alone, which let a
// late redelivery regress a more advanced status (e.g. a redelivered
// `email.delivered` downgraded an `opened` row back to `delivered`, silently
// understating open/click rates; a retried `email.failed` overwrote a bounce or
// complaint, hiding a compliance signal from the operator's campaign view).
// SECURITY.md mandates "Provider retries/webhook redelivery must be idempotent."
//
// The fix is a single explicit total order over the lifecycle. A transition is
// applied only when the incoming event's rank is STRICTLY greater than the
// current status's rank; otherwise the event is a stale/out-of-order redelivery
// and must not touch the row.
//
//   queued(0) < sent(1) < delivered(2) < opened(3) < clicked(4)
//            < failed(5) < bounced(6) < complained(7) < suppressed(8)
//
// WHY this order:
//   - Engagement events (`opened`, `clicked`) rank above `delivered`/`sent`:
//     an open/click is strictly more advanced than a delivery, so a late
//     `email.delivered` can never regress an open/click.
//   - The negative terminal events (`failed`, `bounced`, `complained`,
//     `suppressed`) rank above ALL engagement/delivery, so a later-arriving
//     `delivered`/`opened`/`clicked` can never overwrite a bounce/complaint/
//     failure — a compliance signal is never erased from the funnel.
//   - `complained` outranks `bounced` (a complaint is the stronger negative
//     signal and supersedes a bounce), and `clicked` outranks `opened`.
//   - `bounced`/`complained` outrank `failed`, so a retried `email.failed`
//     cannot downgrade a bounce/complaint.
//   - `suppressed` is the most terminal state (set via the suppression insert);
//     nothing may overwrite it.
//
// Unknown/unexpected current statuses fail safe: they are treated as rank 0
// (the lowest), so any recognized event is a strict rank increase and is
// recorded. This never regresses a KNOWN status (the monotonic rule still
// holds for every status we understand) while avoiding dropping a legitimate
// delivery signal just because the row carries a value we don't recognize.

export interface EmailSendTransition {
  status: string;
  deliveredAt?: Date;
  openedAt?: Date;
  clickedAt?: Date;
  bouncedAt?: Date;
  complainedAt?: Date;
  errorMessage?: string;
  suppress: boolean;
}

// Rank of every status value that can appear in email_sends.status.
const EMAIL_SEND_STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  failed: 5,
  bounced: 6,
  complained: 7,
  suppressed: 8,
};

// Rank of every Resend event that maps to a status transition. Events not
// listed here (e.g. `email.delivery_delayed`) are informational only and never
// produce a transition.
const EMAIL_SEND_EVENT_RANK: Record<string, number> = {
  'email.delivered': 2,
  'email.opened': 3,
  'email.clicked': 4,
  'email.failed': 5,
  'email.bounced': 6,
  'email.complained': 7,
};

/** Decide the resulting row state for (currentStatus, event). Returns null when
 *  the event must not change the row (a stale/out-of-order redelivery, or an
 *  event that is not a status transition). */
export function resolveEmailSendEvent(
  currentStatus: string,
  event: string,
  at: Date,
  row: { openedAt?: Date | null; clickedAt?: Date | null },
): EmailSendTransition | null {
  const eventRank = EMAIL_SEND_EVENT_RANK[event];
  if (eventRank === undefined) {
    // Not a status event (e.g. email.delivery_delayed) — no transition.
    return null;
  }

  // Unknown current statuses fail safe as rank 0 (see WHY above).
  const currentRank = EMAIL_SEND_STATUS_RANK[currentStatus] ?? 0;
  if (eventRank <= currentRank) {
    // Not a strict rank increase — stale/out-of-order redelivery. Never regress.
    return null;
  }

  switch (event) {
    case 'email.delivered':
      // deliveredAt is set only on the first transition INTO delivered (rank 2
      // is only reachable from queued/sent), so a redelivery can never rewrite
      // an existing deliveredAt — time-to-delivery does not drift.
      return { status: 'delivered', deliveredAt: at, suppress: false };
    case 'email.opened':
      // Preserve an existing openedAt (first open wins) — matches the original
      // `row.openedAt ?? now` semantics.
      return { status: 'opened', openedAt: row.openedAt ?? at, suppress: false };
    case 'email.clicked':
      // Preserve an existing clickedAt (first click wins) — matches the
      // original `row.clickedAt ?? now` semantics.
      return { status: 'clicked', clickedAt: row.clickedAt ?? at, suppress: false };
    case 'email.bounced':
      return { status: 'bounced', bouncedAt: at, suppress: true };
    case 'email.complained':
      return { status: 'complained', complainedAt: at, suppress: true };
    case 'email.failed':
      return { status: 'failed', errorMessage: 'Resend reported delivery failure post-send', suppress: false };
    default:
      return null;
  }
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

      // email.delivery_delayed is informational only — never a status change.
      if (type === 'email.delivery_delayed') {
        console.log(`[Resend] Delivery delayed for send ${row.id} (${row.toEmail})`);
        return res.status(200).json({ received: true, matched: true });
      }

      // Unknown event types are a no-op (kept from the original default branch).
      if (!(type in EMAIL_SEND_EVENT_RANK)) {
        return res.status(200).json({ received: true, matched: true });
      }

      const transition = resolveEmailSendEvent(row.status, type, now, row);
      if (!transition) {
        // Stale or out-of-order redelivery (Svix retries with backoff, so the
        // same event can arrive late or events can arrive out of order). Ack so
        // Svix stops retrying, but do NOT touch the row — a redelivered event
        // must never regress a more advanced status.
        return res.status(200).json({ received: true, matched: true, applied: false, reason: 'stale-or-out-of-order' });
      }

      // `suppress` is a decision flag, not a column — strip it before the set().
      const { suppress, ...patch } = transition;

      if (suppress) {
        const complained = transition.status === 'complained';
        const { applyDoNotContact, commitSendRecord } = await import('@workspace/core');
        await commitSendRecord(async (tx) => {
          await tx.update(emailSends).set(patch).where(eq(emailSends.id, row.id));
          await tx.insert(emailSuppressions)
            .values({ email: row.toEmail, reason: complained ? 'complained' : 'bounced', createdAt: now })
            .onConflictDoNothing();
          await applyDoNotContact(tx, {
            destination: row.toEmail,
            reason: complained ? 'complaint' : 'bounced',
            setBy: 'resend',
            channel: 'email',
            providerMessageId: `optout:${type}:${row.id}`,
          });
          return row.id;
        }, {
          destination: row.toEmail,
          channel: 'email',
          direction: 'inbound',
          actorType: 'provider',
          actorName: 'resend',
          eventKind: complained ? 'complaint' : 'bounce',
          subject: row.subject,
          bodyText: complained ? `Spam complaint from ${row.toEmail}` : `Email bounced for ${row.toEmail}`,
          provider: 'resend',
          providerMessageId: `${type}:${row.id}`,
          sendRecordTable: 'email_sends',
          sendRecordId: row.id,
        });
        if (complained) console.warn(`[Resend] SPAM COMPLAINT from ${row.toEmail} (send ${row.id}) — address suppressed`);
      } else {
        await db.update(emailSends).set(patch).where(eq(emailSends.id, row.id));
      }

      return res.status(200).json({ received: true, matched: true, applied: true });
    } catch (err) {
      console.error('[Resend] Webhook error:', err instanceof Error ? err.message : String(err));
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // Inbound mail on APEX_REPLY_DOMAIN (for example reply.example.com). Signed
  // the same way as delivery webhooks. Unmatched mail stays in the queue.
  router.post('/inbound', async (req, res) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const svixId = req.header('svix-id') ?? '';
    const svixTimestamp = req.header('svix-timestamp') ?? '';
    const svixSignature = req.header('svix-signature') ?? '';
    if (!secret || !rawBody || !verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSignature)) {
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }
    try {
      const event = req.body as { type?: string; data?: Record<string, unknown> };
      const data = event.data ?? {};
      const { ingestInboundEmail } = await import('@workspace/core');
      const headers = (data.headers ?? {}) as Record<string, string>;
      const result = await ingestInboundEmail({
        from: typeof data.from === 'string' ? data.from : '',
        to: Array.isArray(data.to) ? data.to.filter((value): value is string => typeof value === 'string') : [],
        cc: Array.isArray(data.cc) ? data.cc.filter((value): value is string => typeof value === 'string') : [],
        bcc: Array.isArray(data.bcc) ? data.bcc.filter((value): value is string => typeof value === 'string') : [],
        subject: typeof data.subject === 'string' ? data.subject : null,
        text: typeof data.text === 'string' ? data.text : null,
        html: typeof data.html === 'string' ? data.html : null,
        messageId: typeof data.message_id === 'string' ? data.message_id : headers['message-id'] ?? null,
        inReplyTo: typeof headers['in-reply-to'] === 'string' ? headers['in-reply-to'] : null,
        references: typeof headers['references'] === 'string' ? headers.references : null,
        providerMessageId: typeof data.email_id === 'string' ? data.email_id : null,
      });
      return res.status(200).json({ received: true, ...result });
    } catch (err) {
      console.error('[Resend] Inbound error:', err instanceof Error ? err.message : String(err));
      return res.status(500).json({ error: 'Inbound processing failed' });
    }
  });

  return router;
}
