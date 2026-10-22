import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENESIS_PREV_HASH, canonicalize, computeRowHash, genesisFields, legacyDigest, linkRow, verifyChain,
  readEmailAuditFlags, sendViaGateway, senderAllowed, reconcile, toSheetRows, sanitizeCell, runExport,
  createEmailAuditWebhookRouter, createEmailAuditDashboardRouter,
  type AuditStore, type ChainedRow, type EmailEventInsert, type GatewaySendInput,
} from '../email-audit/index.js';
import { ipAllowed, normaliseEventType, snsCertUrlOk, snsStringToSign, verifySnsSignature } from '../email-audit/webhooks.js';
import { mountEmailAuditAdmin, mountEmailAuditPublic } from '../email-audit/mount.js';

function memStore(withGenesis = true) {
  const rows: ChainedRow[] = [];
  const events: EmailEventInsert[] = [];
  if (withGenesis) rows.push(linkRow(genesisFields({ id: 'g', createdAt: '2026-10-21T00:00:00.000Z', projectId: 'apex', legacy: { count: 0, digest: 'x' } }), GENESIS_PREV_HASH));
  const store: AuditStore & { failInsert?: boolean } = {
    async appendChained(build) {
      if (store.failInsert) throw new Error('db down');
      const t = rows.at(-1); const r = build(t ? { seq: t.seq, rowHash: t.rowHash } : null); rows.push(r); return r;
    },
    async insertEvent(ev) {
      if (events.some((e) => e.provider === ev.provider && e.providerEventId === ev.providerEventId)) return 'duplicate';
      events.push(ev); return 'inserted';
    },
  };
  return { store, rows, events };
}

const allOn = { gateway: true, providerSend: true, webhooks: true, reconcile: true, exportSheet: true, dashboard: true };
const input: GatewaySendInput = { projectId: 'apex', agent: 'marcus-cole', persona: 'Marcus Cole', from: 'apex@donmatthews.live',
  to: ['A@x.com'], subject: 'Hi', text: 'body', provider: 'resend', policyMode: 'owner_confirmed' };

describe('flags', () => {
  it('all default off', () => {
    expect(Object.values(readEmailAuditFlags({}))).toEqual([false, false, false, false, false, false]);
    expect(readEmailAuditFlags({ EMAIL_AUDIT_GATEWAY_ENABLED: '1' }).gateway).toBe(false);
    expect(readEmailAuditFlags({ EMAIL_AUDIT_GATEWAY_ENABLED: 'true' }).gateway).toBe(true);
  });
  it('mounts nothing by default', async () => {
    const app = express();
    expect(await mountEmailAuditPublic(app, {})).toBe(false);
    expect(await mountEmailAuditAdmin(app, {})).toBe(false);
    expect(await mountEmailAuditPublic(app, { EMAIL_AUDIT_WEBHOOKS_ENABLED: 'true' })).toBe(false); // no DB URL
  });
});

describe('hash chain', () => {
  it('canonicalisation is order/case-insensitive for address lists', () => {
    const f = genesisFields({ id: 'a', createdAt: 't', projectId: 'p', legacy: { count: 1, digest: 'd' } });
    expect(canonicalize({ ...f, toAddrs: ['B@x', 'a@x'] })).toBe(canonicalize({ ...f, toAddrs: ['a@x', 'b@x'] }));
  });
  it('verifies a good chain and detects tampering, gaps and bad genesis', async () => {
    const { store, rows } = memStore();
    for (let i = 0; i < 3; i++) await sendViaGateway({ ...input, subject: `s${i}` }, { flags: allOn, store, provider: { send: async () => ({ providerMsgId: `m${i}` }) }, verifiedResendDomains: ['donmatthews.live'] });
    expect(verifyChain(rows).ok).toBe(true);
    const tampered = rows.map((r) => ({ ...r })); tampered[2].subject = 'edited';
    expect(verifyChain(tampered).problems.map((p) => p.kind)).toContain('hash_mismatch');
    expect(verifyChain([rows[0], rows[2], rows[3]]).problems.map((p) => p.kind)).toEqual(expect.arrayContaining(['prev_mismatch', 'seq_gap']));
    expect(verifyChain(rows.slice(1)).problems[0].kind).toBe('bad_genesis');
  });
  it('row hash depends on prev hash', () => {
    const f = genesisFields({ id: 'a', createdAt: 't', projectId: 'p', legacy: { count: 1, digest: 'd' } });
    expect(computeRowHash(f, GENESIS_PREV_HASH)).not.toBe(computeRowHash(f, 'f'.repeat(64)));
  });
  it('legacy digest is order-independent and changes on edit', () => {
    const a = { id: '1', projectId: 'p', toolName: 't', destination: 'd', leadId: null, policyMode: 'm', providerId: null, rehearsal: false, detail: null, createdAt: '2026-01-01T00:00:00.000Z' };
    const b = { ...a, id: '2', createdAt: '2026-01-02T00:00:00.000Z' };
    expect(legacyDigest([a, b]).digest).toBe(legacyDigest([b, a]).digest);
    expect(legacyDigest([a, { ...b, detail: 'x' }]).digest).not.toBe(legacyDigest([a, b]).digest);
    expect(legacyDigest([a, b]).count).toBe(2);
  });
});

describe('gateway', () => {
  const deps = (o: Partial<Parameters<typeof sendViaGateway>[1]> = {}) => {
    const m = memStore(); let calls = 0;
    return { m, get calls() { return calls; }, d: { flags: allOn, store: m.store, verifiedResendDomains: ['donmatthews.live'],
      provider: { send: async () => { calls++; return { providerMsgId: 're_1' }; } }, ...o } };
  };
  it('disabled by default: no audit row, no provider call', async () => {
    const t = deps(); t.d.flags = readEmailAuditFlags({});
    expect(await sendViaGateway(input, t.d)).toEqual({ status: 'disabled' });
    expect(t.m.rows.length).toBe(1); expect(t.calls).toBe(0);
  });
  it('writes the audit row BEFORE the provider call', async () => {
    const m = memStore(); let rowsAtSend = -1;
    await sendViaGateway(input, { flags: allOn, store: m.store, verifiedResendDomains: ['donmatthews.live'], provider: { send: async () => { rowsAtSend = m.rows.length; return { providerMsgId: 'x' }; } } });
    expect(rowsAtSend).toBe(2);
    expect(m.events[0]).toMatchObject({ eventType: 'accepted', providerMsgId: 'x', auditId: m.rows[1].id });
  });
  it('fails closed when the audit write fails', async () => {
    const t = deps(); (t.m.store as { failInsert?: boolean }).failInsert = true;
    await expect(sendViaGateway(input, t.d)).rejects.toThrow(/audit write failed/); expect(t.calls).toBe(0);
  });
  it('refuses to send without a genesis row', async () => {
    const m = memStore(false); let calls = 0;
    await expect(sendViaGateway(input, { flags: allOn, store: m.store, verifiedResendDomains: ['donmatthews.live'], provider: { send: async () => { calls++; return { providerMsgId: 'x' }; } } })).rejects.toThrow(/genesis/);
    expect(calls).toBe(0);
  });
  it('dry run (providerSend off) audits but does not send', async () => {
    const t = deps(); t.d.flags = { ...allOn, providerSend: false };
    const r = await sendViaGateway(input, t.d);
    expect(r.status).toBe('dry_run'); expect(t.calls).toBe(0); expect(t.m.rows[1].detail).toBe('dry_run');
  });
  it('records provider failure as an event', async () => {
    const m = memStore();
    const r = await sendViaGateway(input, { flags: allOn, store: m.store, verifiedResendDomains: ['donmatthews.live'], provider: { send: async () => { throw new Error('422'); } } });
    expect(r.status).toBe('provider_failed'); expect(m.events[0].eventType).toBe('failed');
  });
  it('blocks wtpnews.org on Resend until verified', async () => {
    expect(senderAllowed('marcus@wtpnews.org', 'resend', ['donmatthews.live'])).toBe(false);
    expect(senderAllowed('apex@donmatthews.live', 'resend', ['donmatthews.live'])).toBe(true);
    const t = deps();
    await expect(sendViaGateway({ ...input, from: 'marcus@wtpnews.org' }, t.d)).rejects.toThrow(/not verified/);
    expect(t.m.rows.length).toBe(1);
  });
});

async function serve(router: express.Router, path: string, opts: { json?: boolean } = {}) {
  const app = express();
  app.set('trust proxy', false);
  if (opts.json !== false) app.use(express.json({ verify: (req, _r, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(path, router);
  const srv = app.listen(0);
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}${path}`, close: () => srv.close() };
}

describe('webhooks', () => {
  const closers: (() => void)[] = [];
  afterEach(() => { closers.splice(0).forEach((c) => c()); });

  it('resend: rejects bad signature, accepts good, dedupes', async () => {
    const key = crypto.randomBytes(24); const secret = `whsec_${key.toString('base64')}`;
    const m = memStore();
    const s = await serve(createEmailAuditWebhookRouter({ store: m.store, env: { EMAIL_AUDIT_RESEND_WEBHOOK_SECRET: secret } }), '/wh'); closers.push(s.close);
    const body = JSON.stringify({ type: 'email.delivered', created_at: '2026-10-21T00:00:00Z', data: { email_id: 're_1' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
    const post = (sigv: string) => fetch(`${s.url}/resend`, { method: 'POST', headers: { 'content-type': 'application/json', 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': sigv }, body });
    expect((await post('v1,AAAA')).status).toBe(403);
    expect(m.events.length).toBe(0);
    expect(await (await post(`v1,${sig}`)).json()).toMatchObject({ result: 'inserted' });
    expect(await (await post(`v1,${sig}`)).json()).toMatchObject({ result: 'duplicate' });
    expect(m.events[0]).toMatchObject({ provider: 'resend', eventType: 'delivered', providerMsgId: 're_1', signatureVerified: true });
  });

  it('unconfigured providers fail closed with 503', async () => {
    const m = memStore();
    const s = await serve(createEmailAuditWebhookRouter({ store: m.store, env: {} }), '/wh'); closers.push(s.close);
    for (const p of ['resend', 'brevo', 'ses']) expect((await fetch(`${s.url}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(503);
  });

  it('brevo: bearer token + IP allowlist', async () => {
    const m = memStore();
    const s = await serve(createEmailAuditWebhookRouter({ store: m.store, env: { EMAIL_AUDIT_BREVO_WEBHOOK_TOKEN: 'tok123' } }), '/wh'); closers.push(s.close);
    const body = JSON.stringify({ event: 'hard_bounce', 'message-id': '<m1@brevo>', ts_event: 1761000000 });
    const post = (auth: string) => fetch(`${s.url}/brevo`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body });
    expect((await post('Bearer nope')).status).toBe(403);
    expect((await post('Bearer tok123')).status).toBe(200);
    expect(m.events[0]).toMatchObject({ provider: 'brevo', eventType: 'bounced' });
    expect(ipAllowed('1.2.3.4', ['1.2.3.0/24'])).toBe(true);
    expect(ipAllowed('1.2.4.4', ['1.2.3.0/24'])).toBe(false);
    expect(ipAllowed('::ffff:1.2.3.4', ['1.2.3.4'])).toBe(true);
  });

  it('ses/sns: verifies RSA signature, pins topic + cert host, never auto-confirms', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const topic = 'arn:aws:sns:us-east-1:123:ses-events';
    const certUrl = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem';
    const sign = (m: Record<string, string>) => ({ ...m, SignatureVersion: '2', SigningCertURL: certUrl,
      Signature: crypto.createSign('RSA-SHA256').update(snsStringToSign(m)).sign(privateKey, 'base64') });
    const m = memStore();
    const s = await serve(createEmailAuditWebhookRouter({ store: m.store, env: { EMAIL_AUDIT_SES_TOPIC_ARN: topic }, fetchCert: async () => pem }), '/wh', { json: false }); closers.push(s.close);
    const post = (o: object) => fetch(`${s.url}/ses`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(o) });
    const note = sign({ Type: 'Notification', MessageId: 'sns-1', TopicArn: topic, Timestamp: '2026-10-21T00:00:00Z',
      Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'ses-1' } }) });
    expect((await post({ ...note, Message: '{"eventType":"Bounce"}' })).status).toBe(403);
    expect((await post({ ...note, TopicArn: 'arn:other' })).status).toBe(403);
    expect((await post(note)).status).toBe(200);
    expect(m.events[0]).toMatchObject({ provider: 'ses', eventType: 'delivered', providerMsgId: 'ses-1' });
    const sub = sign({ Type: 'SubscriptionConfirmation', MessageId: 'sns-2', TopicArn: topic, Timestamp: 't', Token: 'k', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?x', Message: 'm' });
    expect((await post(sub)).status).toBe(202);
    expect(snsCertUrlOk('https://evil.com/sns.us-east-1.amazonaws.com/x.pem')).toBe(false);
    expect(verifySnsSignature({ ...note, SignatureVersion: '9' }, pem)).toBe(false);
  });

  it('normalises event names', () => {
    expect(normaliseEventType('ses', 'Complaint')).toBe('complained');
    expect(normaliseEventType('brevo', 'soft_bounce')).toBe('bounced');
    expect(normaliseEventType('resend', 'email.sent')).toBe('accepted');
  });
});

describe('reconciliation', () => {
  it('flags provider-only, audit-only, status mismatch, unchained inserts and chain breaks', async () => {
    const m = memStore(); const flags = allOn; let n = 0;
    const provider = { send: async () => ({ providerMsgId: `m${++n}` }) };
    for (let i = 0; i < 2; i++) await sendViaGateway(input, { flags, store: m.store, provider, verifiedResendDomains: ['donmatthews.live'] });
    m.events.pop(); // second send lost its accepted event
    const r = reconcile({
      chained: m.rows, windowAuditIds: new Set(m.rows.slice(1).map((x) => x.id)), unchainedSinceGenesis: ['legacy_x'],
      events: m.events.map((e) => ({ provider: e.provider, providerMsgId: e.providerMsgId, auditId: e.auditId, eventType: e.eventType })),
      providerLogs: [
        { provider: 'resend', providerMsgId: 'm1', from: 'a', to: ['b'], sentAt: 't', status: 'bounced' },
        { provider: 'resend', providerMsgId: 'rogue', from: 'marcus@wtpnews.org', to: ['z'], sentAt: 't' },
      ],
      latestStatus: new Map([['resend:m1', 'delivered']]),
    });
    expect(r.chainOk).toBe(true);
    expect(r.findings.map((f) => f.kind).sort()).toEqual(['audit_only', 'provider_only', 'status_mismatch', 'unchained_insert']);
    const broken = m.rows.map((x) => ({ ...x })); broken[1].subject = 'x';
    expect(reconcile({ chained: broken, windowAuditIds: new Set(), unchainedSinceGenesis: [], events: [], providerLogs: [], latestStatus: new Map() }).chainOk).toBe(false);
  });
});

describe('export', () => {
  it('exports only rows after last seq and neutralises formulas', async () => {
    const m = memStore();
    await sendViaGateway({ ...input, subject: '=HYPERLINK("x")' }, { flags: allOn, store: m.store, provider: { send: async () => ({ providerMsgId: 'a' }) }, verifiedResendDomains: ['donmatthews.live'] });
    const rows = toSheetRows(m.rows, 1);
    expect(rows.length).toBe(1); expect(rows[0][9]).toBe(`'=HYPERLINK("x")`);
    expect(sanitizeCell('ok')).toBe('ok');
    const appended: string[][] = [];
    expect(await runExport({ enabled: false, rows: async () => m.rows, sheet: { lastExportedSeq: async () => 0, append: async (r) => { appended.push(...r); } } })).toEqual({ status: 'disabled' });
    expect(await runExport({ enabled: true, rows: async () => m.rows, sheet: { lastExportedSeq: async () => 1, append: async (r) => { appended.push(...r); } } })).toMatchObject({ exported: 1 });
    expect(appended.length).toBe(1);
  });
});

describe('dashboard', () => {
  it('is read-only and reports chain status', async () => {
    const m = memStore();
    const reader = { search: async () => [{ id: 'a' }], perAgentCounts: async () => [{ agent: 'marcus-cole', sends: 1 }], chainedRows: async () => m.rows };
    const s = await serve(createEmailAuditDashboardRouter(reader as never), '/d');
    try {
      expect(await (await fetch(`${s.url}/chain`)).json()).toMatchObject({ ok: true, length: 1 });
      expect((await fetch(`${s.url}/sends`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${s.url}/sends?limit=5`)).status).toBe(200);
    } finally { s.close(); }
  });
});
