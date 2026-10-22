import crypto from 'crypto';
import express, { Router, type Request } from 'express';
import { verifySvixSignature } from '../routes/resend-webhook.js';
import type { AuditStore, EmailEventInsert } from './gateway.js';

// Signature-verified provider webhooks -> email_events. Mounted only when
// EMAIL_AUDIT_WEBHOOKS_ENABLED=true (see mountEmailAudit in index.ts). Each
// provider fails closed: missing secret = 503, bad signature = 403, nothing
// is written. Secrets are read from env and never logged.

export function normaliseEventType(provider: string, raw: string): string {
  const r = raw.toLowerCase();
  if (/deliver/.test(r)) return 'delivered';
  if (/bounce|hard_bounce|soft_bounce|blocked|invalid/.test(r)) return 'bounced';
  if (/complain|spam/.test(r)) return 'complained';
  if (/open/.test(r)) return 'opened';
  if (/click/.test(r)) return 'clicked';
  if (/defer|delay/.test(r)) return 'deferred';
  if (/sent|send|request|accept/.test(r)) return 'accepted';
  if (/reject|fail|error/.test(r)) return 'failed';
  return provider ? 'other' : 'other';
}

// ── Brevo ──────────────────────────────────────────────────────────────────
// Brevo transactional webhooks do not HMAC-sign payloads; they support
// HTTP Basic or a custom bearer header configured on the webhook. We require
// `Authorization: Bearer <BREVO_WEBHOOK_TOKEN>` (constant-time compare) and,
// optionally, a source-IP allowlist (BREVO_WEBHOOK_ALLOWED_CIDRS, comma list
// of exact IPs or IPv4 /n CIDRs).
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function ipAllowed(ip: string, allow: string[]): boolean {
  if (allow.length === 0) return true;
  const v4 = ip.replace(/^::ffff:/, '');
  const toInt = (s: string) => s.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  return allow.some((entry) => {
    const [base, bitsStr] = entry.trim().split('/');
    if (!bitsStr) return base === v4;
    const bits = Number(bitsStr);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4) || !Number.isInteger(bits)) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (toInt(v4) & mask) === (toInt(base) & mask);
  });
}

export function verifyBrevo(authHeader: string | undefined, token: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  return constantTimeEqual(authHeader.slice(7), token);
}

// ── SES via SNS ────────────────────────────────────────────────────────────
// SES event publishing -> SNS topic -> HTTPS subscription. Every SNS message
// is RSA-signed; we verify with the cert at SigningCertURL, which MUST be an
// https://sns.<region>.amazonaws.com/*.pem URL, and pin TopicArn.
export type SnsMessage = Record<string, string | undefined>;

export function snsCertUrlOk(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname) && u.pathname.endsWith('.pem');
  } catch { return false; }
}

export function snsStringToSign(m: SnsMessage): string {
  const keys = m.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.filter((k) => m[k] !== undefined).map((k) => `${k}\n${m[k]}\n`).join('');
}

export function verifySnsSignature(m: SnsMessage, certPem: string): boolean {
  const alg = m.SignatureVersion === '2' ? 'RSA-SHA256' : m.SignatureVersion === '1' ? 'RSA-SHA1' : null;
  if (!alg || !m.Signature) return false;
  try {
    return crypto.createVerify(alg).update(snsStringToSign(m), 'utf8').verify(certPem, m.Signature, 'base64');
  } catch { return false; }
}

export type WebhookDeps = {
  store: AuditStore;
  env?: NodeJS.ProcessEnv;
  fetchCert?: (url: string) => Promise<string>;
  now?: () => Date;
};

const certCache = new Map<string, string>();
async function defaultFetchCert(url: string): Promise<string> {
  const hit = certCache.get(url); if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cert fetch ${res.status}`);
  const pem = await res.text(); certCache.set(url, pem); return pem;
}

export function createEmailAuditWebhookRouter(deps: WebhookDeps): Router {
  const env = deps.env ?? process.env;
  const router = Router();
  const record = async (ev: Omit<EmailEventInsert, 'id' | 'auditId' | 'signatureVerified'>) =>
    deps.store.insertEvent({ ...ev, id: `ev_${crypto.randomUUID()}`, auditId: null, signatureVerified: true });

  router.post('/resend', async (req, res) => {
    const secret = env.EMAIL_AUDIT_RESEND_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'not configured' });
    const id = req.headers['svix-id'] as string | undefined;
    const ts = req.headers['svix-timestamp'] as string | undefined;
    const sig = req.headers['svix-signature'] as string | undefined;
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!id || !ts || !sig || !raw || !verifySvixSignature(secret, id, ts, raw, sig)) return res.status(403).json({ error: 'bad signature' });
    const body = req.body as { type?: string; created_at?: string; data?: { email_id?: string } };
    const r = await record({ provider: 'resend', providerEventId: id, providerMsgId: body.data?.email_id ?? null,
      eventType: normaliseEventType('resend', body.type ?? ''), rawType: body.type ?? null, occurredAt: body.created_at ?? null, payload: body });
    return res.status(200).json({ received: true, result: r });
  });

  router.post('/brevo', async (req, res) => {
    const token = env.EMAIL_AUDIT_BREVO_WEBHOOK_TOKEN;
    if (!token) return res.status(503).json({ error: 'not configured' });
    const allow = (env.EMAIL_AUDIT_BREVO_ALLOWED_CIDRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!verifyBrevo(req.headers.authorization, token) || !ipAllowed(req.ip ?? '', allow)) return res.status(403).json({ error: 'unauthorized' });
    const b = req.body as { event?: string; 'message-id'?: string; ts_event?: number; date?: string; id?: number };
    const msgId = b['message-id'] ?? null;
    const eventKey = `${msgId}:${b.event}:${b.ts_event ?? b.date ?? ''}`;
    const r = await record({ provider: 'brevo', providerEventId: eventKey, providerMsgId: msgId,
      eventType: normaliseEventType('brevo', b.event ?? ''), rawType: b.event ?? null,
      occurredAt: b.ts_event ? new Date(b.ts_event * 1000).toISOString() : b.date ?? null, payload: b });
    return res.status(200).json({ received: true, result: r });
  });

  router.post('/ses', express.text({ type: () => true, limit: '256kb' }), async (req, res) => {
    const topic = env.EMAIL_AUDIT_SES_TOPIC_ARN;
    if (!topic) return res.status(503).json({ error: 'not configured' });
    let m: SnsMessage;
    try {
      m = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as SnsMessage);
    } catch { return res.status(400).json({ error: 'bad json' }); }
    if (m.TopicArn !== topic || !snsCertUrlOk(m.SigningCertURL)) return res.status(403).json({ error: 'bad topic/cert' });
    let pem: string;
    try { pem = await (deps.fetchCert ?? defaultFetchCert)(m.SigningCertURL!); } catch { return res.status(502).json({ error: 'cert fetch failed' }); }
    if (!verifySnsSignature(m, pem)) return res.status(403).json({ error: 'bad signature' });
    if (m.Type === 'SubscriptionConfirmation') {
      // Deliberately NOT auto-confirmed: subscribing is an operator action (approval list).
      return res.status(202).json({ received: true, confirm: 'manual' });
    }
    if (m.Type !== 'Notification') return res.status(200).json({ received: true });
    let inner: { eventType?: string; notificationType?: string; mail?: { messageId?: string; timestamp?: string } } = {};
    try { inner = JSON.parse(m.Message ?? '{}'); } catch { /* keep empty */ }
    const raw = inner.eventType ?? inner.notificationType ?? '';
    const r = await record({ provider: 'ses', providerEventId: m.MessageId ?? crypto.randomUUID(), providerMsgId: inner.mail?.messageId ?? null,
      eventType: normaliseEventType('ses', raw), rawType: raw || null, occurredAt: m.Timestamp ?? null, payload: inner });
    return res.status(200).json({ received: true, result: r });
  });

  return router;
}
