/**
 * Guard tests for the Resend webhook's monotonic status transitions.
 *
 * Resend delivers lifecycle events through Svix, which retries with backoff, so
 * the same event can be redelivered late and events can arrive out of order.
 * The old handler wrote emailSends.status unconditionally from the event alone,
 * which let a late redelivery regress a more advanced status (e.g. a redelivered
 * `email.delivered` downgraded an `opened` row back to `delivered`, silently
 * understating open/click rates; a retried `email.failed` overwrote a bounce or
 * complaint, hiding a compliance signal). SECURITY.md mandates "Provider
 * retries/webhook redelivery must be idempotent."
 *
 * These tests assert the pure decision function directly (following the repo
 * convention of exporting pure helpers "for direct guard testing"), plus one
 * handler-level test proving a rejected (null) transition issues NO db.update.
 */
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { resolveEmailSendEvent, verifySvixSignature } from '../routes/resend-webhook.js';

// ─── Pure decision function ─────────────────────────────────────────────────────

describe('resolveEmailSendEvent', () => {
  const at = new Date('2026-09-25T12:00:00.000Z');

  it('delivered + email.delivered -> null (idempotent redelivery)', () => {
    expect(resolveEmailSendEvent('delivered', 'email.delivered', at, {})).toBeNull();
  });

  it('opened + email.delivered -> null (no regression of an open)', () => {
    expect(resolveEmailSendEvent('opened', 'email.delivered', at, {})).toBeNull();
  });

  it('clicked + email.delivered -> null', () => {
    expect(resolveEmailSendEvent('clicked', 'email.delivered', at, {})).toBeNull();
  });

  it('bounced + email.delivered -> null and suppress must not re-fire', () => {
    expect(resolveEmailSendEvent('bounced', 'email.delivered', at, {})).toBeNull();
  });

  it('bounced + email.failed -> null (terminal negative not overwritten)', () => {
    expect(resolveEmailSendEvent('bounced', 'email.failed', at, {})).toBeNull();
  });

  it('complained + email.clicked -> null (compliance signal preserved)', () => {
    expect(resolveEmailSendEvent('complained', 'email.clicked', at, {})).toBeNull();
  });

  it('bounced + email.complained -> applied, status complained, suppress true', () => {
    const t = resolveEmailSendEvent('bounced', 'email.complained', at, {});
    expect(t).not.toBeNull();
    expect(t!.status).toBe('complained');
    expect(t!.complainedAt).toBe(at);
    expect(t!.suppress).toBe(true);
  });

  it('delivered + email.opened -> applied, openedAt set', () => {
    const t = resolveEmailSendEvent('delivered', 'email.opened', at, {});
    expect(t).not.toBeNull();
    expect(t!.status).toBe('opened');
    expect(t!.openedAt).toBe(at);
    expect(t!.suppress).toBe(false);
  });

  it('opened + email.clicked -> applied, clickedAt set, openedAt preserved', () => {
    const t = resolveEmailSendEvent('opened', 'email.clicked', at, { openedAt: new Date('2026-09-25T11:00:00.000Z') });
    expect(t).not.toBeNull();
    expect(t!.status).toBe('clicked');
    expect(t!.clickedAt).toBe(at);
    expect(t!.openedAt).toBeUndefined();
    expect(t!.suppress).toBe(false);
  });

  it('queued + email.bounced -> applied, bouncedAt set, suppress true', () => {
    const t = resolveEmailSendEvent('queued', 'email.bounced', at, {});
    expect(t).not.toBeNull();
    expect(t!.status).toBe('bounced');
    expect(t!.bouncedAt).toBe(at);
    expect(t!.suppress).toBe(true);
  });

  it('unknown current status fails safe: a recognized event is a rank increase and is recorded', () => {
    // Unknown statuses are treated as rank 0, so any recognized event is a
    // strict rank increase and is applied (never regresses a KNOWN status).
    const t = resolveEmailSendEvent('mystery-status', 'email.delivered', at, {});
    expect(t).not.toBeNull();
    expect(t!.status).toBe('delivered');
    expect(t!.deliveredAt).toBe(at);
  });

  it('unknown current status fails safe: a non-status event still yields null', () => {
    expect(resolveEmailSendEvent('mystery-status', 'email.delivery_delayed', at, {})).toBeNull();
  });

  it('deliveredAt is set only on the first transition into delivered (never overwritten)', () => {
    // A redelivered email.delivered on an already-delivered row is null, so the
    // existing deliveredAt is never rewritten (time-to-delivery does not drift).
    expect(resolveEmailSendEvent('delivered', 'email.delivered', at, {})).toBeNull();
  });

  it('openedAt/clickedAt preserve the first event (row.openedAt ?? at semantics)', () => {
    const first = new Date('2026-09-25T10:00:00.000Z');
    const t = resolveEmailSendEvent('delivered', 'email.opened', at, { openedAt: first });
    expect(t!.openedAt).toBe(first);
  });
});

// ─── Handler-level: rejected transition issues NO db.update ──────────────────

const state = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  row: null as Record<string, unknown> | null,
}));

vi.mock('@workspace/db', () => {
  const emailSends = { __name: 'email_sends', id: 'email_sends.id', providerId: 'email_sends.provider_id' };
  const emailSuppressions = { __name: 'email_suppressions', email: 'email_suppressions.email' };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (state.row ? [state.row] : []),
        }),
      }),
    }),
    update: (table: { __name: string }) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push({ table: table.__name, values });
        },
      }),
    }),
  };
  return { db, emailSends, emailSuppressions };
});

vi.mock('@workspace/core', () => ({
  applyDoNotContact: async () => undefined,
  commitSendRecord: async (_fn: (tx: unknown) => Promise<unknown>) => _fn({}),
}));

const { createResendWebhookRouter } = await import('../routes/resend-webhook.js');

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
    server.on('error', reject);
  });
}

function signPayload(secret: string, svixId: string, svixTimestamp: string, body: string): string {
  const secretB64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(secretB64, 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const sig = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('resend webhook handler', () => {
  const secret = 'whsec_dGVzdHNlY3JldA=='; // base64 of "testsecret"

  beforeEach(() => {
    state.updates = [];
    state.row = null;
    process.env.RESEND_WEBHOOK_SECRET = secret;
  });

  it('acks a stale/out-of-order redelivery without issuing any db.update', async () => {
    // Row is already `opened`; a redelivered `email.delivered` must be rejected.
    state.row = {
      id: 'send-1',
      providerId: 'resend-email-1',
      status: 'opened',
      toEmail: 'lead@example.com',
      subject: 'Hello',
      openedAt: new Date('2026-09-25T11:00:00.000Z'),
    };

    const app = express();
    app.use(express.json({ verify: (_req, _res, buf) => { (_req as { rawBody?: Buffer }).rawBody = buf; } }));
    app.use('/', createResendWebhookRouter());

    const server = await listen(app);
    try {
      const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'resend-email-1' } });
      const svixId = 'msg_test';
      const svixTimestamp = String(Math.floor(Date.now() / 1000));
      const signature = signPayload(secret, svixId, svixTimestamp, body);

      const res = await fetch(`http://127.0.0.1:${server.port}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': signature,
        },
        body,
      });

      expect(res.status).toBe(200);
      const payload = await res.json() as { received: boolean; matched: boolean; applied?: boolean; reason?: string };
      expect(payload).toMatchObject({ received: true, matched: true, applied: false, reason: 'stale-or-out-of-order' });
      // The rejected transition must NOT touch the row.
      expect(state.updates).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('applies a valid transition and issues exactly one db.update', async () => {
    state.row = {
      id: 'send-2',
      providerId: 'resend-email-2',
      status: 'delivered',
      toEmail: 'lead2@example.com',
      subject: 'Hello 2',
    };

    const app = express();
    app.use(express.json({ verify: (_req, _res, buf) => { (_req as { rawBody?: Buffer }).rawBody = buf; } }));
    app.use('/', createResendWebhookRouter());

    const server = await listen(app);
    try {
      const body = JSON.stringify({ type: 'email.opened', data: { email_id: 'resend-email-2' } });
      const svixId = 'msg_test2';
      const svixTimestamp = String(Math.floor(Date.now() / 1000));
      const signature = signPayload(secret, svixId, svixTimestamp, body);

      const res = await fetch(`http://127.0.0.1:${server.port}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': signature,
        },
        body,
      });

      expect(res.status).toBe(200);
      const payload = await res.json() as { applied?: boolean };
      expect(payload.applied).toBe(true);
      expect(state.updates).toHaveLength(1);
      expect(state.updates[0]!.table).toBe('email_sends');
      expect(state.updates[0]!.values.status).toBe('opened');
      expect(state.updates[0]!.values.openedAt).toBeInstanceOf(Date);
    } finally {
      await server.close();
    }
  });

  it('verifySvixSignature accepts a correctly signed payload and rejects a tampered one', () => {
    const body = '{"type":"email.delivered","data":{"email_id":"x"}}';
    const svixId = 'msg_sig';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const sig = signPayload(secret, svixId, svixTimestamp, body);
    expect(verifySvixSignature(secret, svixId, svixTimestamp, Buffer.from(body, 'utf8'), sig)).toBe(true);
    expect(verifySvixSignature(secret, svixId, svixTimestamp, Buffer.from(body + 'x', 'utf8'), sig)).toBe(false);
  });
});
