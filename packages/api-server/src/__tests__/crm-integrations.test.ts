import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Everything that would touch Postgres is mocked; the pure masking/validation
// helpers are imported from source below so they are exercised for real.
const mocks = vi.hoisted(() => ({
  saveMarketingConnection: vi.fn(async () => ({ provider: 'mailchimp', status: 'configured', fields: [] })),
  deleteMarketingConnection: vi.fn(async () => ({ removed: true })),
  testMarketingConnection: vi.fn(async () => ({ ok: true, status: 200, detail: 'reachable' })),
  syncAudience: vi.fn(async () => ({ pushed: 1, skipped: 0, failed: 0 })),
  listMarketingConnections: vi.fn(async () => []),
  listMarketingSyncs: vi.fn(async () => []),
  searchContacts: vi.fn(async () => [
    { email: 'a@b.com', firstName: 'A', lastName: 'B', organizationName: null, phoneE164: null, tags: [] },
  ]),
  findContactIdsByDestination: vi.fn(async () => ['c1', 'c2']),
  setDoNotContact: vi.fn(async () => undefined),
  reportingOverview: vi.fn(async () => ({ generatedAt: 'now', pipeline: {}, winLoss: {} })),
}));

vi.mock('@workspace/core', () => {
  const lifecycle = ['prospect', 'lead', 'qualified', 'client', 'churned'];
  const providers = ['mailchimp', 'klaviyo', 'activecampaign', 'hubspot'];
  class CrmIntegrationError extends Error {}
  class CrmWriteError extends Error {}
  class ContactExistsError extends Error {}
  return {
    OPERATOR_ACTOR: 'Matthew',
    CRM_DISPLAY_TIMEZONE: 'America/Chicago',
    formatChicago: vi.fn(),
    CONTACT_LIFECYCLE_STAGES: lifecycle,
    TASK_PRIORITIES: ['low', 'normal', 'high'],
    CrmIntegrationError,
    CrmWriteError,
    ContactExistsError,
    isContactLifecycleStage: (value: unknown) => typeof value === 'string' && lifecycle.includes(value),
    isMarketingProvider: (value: unknown) => typeof value === 'string' && providers.includes(value),
    normalizeWebhookEvent: (provider: string, body: unknown) => {
      if (body === null || typeof body !== 'object') return null;
      const record = body as Record<string, unknown>;
      const data = (record.data as Record<string, unknown> | undefined) ?? {};
      const type = String(record.type ?? record.event_type ?? '').toLowerCase();
      const email = (record.email ?? data.email ?? null) as string | null;
      const kind = /unsub/.test(type)
        ? 'unsubscribe'
        : /bounce/.test(type)
          ? 'bounce'
          : /creat|subscrib/.test(type)
            ? 'subscribe'
            : 'other';
      return { provider, kind, email, eventType: type || 'unknown' };
    },
    MARKETING_CONNECTORS: [{ id: 'mailchimp', name: 'Mailchimp', category: 'email' }],
    ...mocks,
    // Route helpers this test never reaches, present so the module evaluates.
    applyResearchedLeadImport: vi.fn(),
    attachUnmatched: vi.fn(),
    cancelTask: vi.fn(),
    closeDeal: vi.fn(),
    completeTask: vi.fn(),
    contactsToCsv: vi.fn(),
    createContact: vi.fn(),
    createDeal: vi.fn(),
    createTask: vi.fn(),
    duplicateSuggestions: vi.fn(),
    getCompanyPage: vi.fn(),
    getContact: vi.fn(),
    getContactActivity: vi.fn(),
    getTimeline: vi.fn(),
    gmailAuthUrl: vi.fn(),
    gmailSyncEnabled: vi.fn(() => false),
    liftSuppression: vi.fn(),
    listActiveSuppressions: vi.fn(),
    listCompanies: vi.fn(),
    listContactSuppressions: vi.fn(),
    listDeals: vi.fn(),
    listDueTasks: vi.fn(),
    listLeadImports: vi.fn(),
    listTasks: vi.fn(),
    listUnmatched: vi.fn(),
    logManualCall: vi.fn(),
    mergeContacts: vi.fn(),
    moveDeal: vi.fn(),
    pipelineBoard: vi.fn(),
    planResearchedLeadImport: vi.fn(),
    rescheduleTask: vi.fn(),
    searchResearchedLeads: vi.fn(),
    setContactTags: vi.fn(),
    setLifecycleStage: vi.fn(),
    syncGmailReadonly: vi.fn(),
    undoResearchedLeadImport: vi.fn(),
    updateContact: vi.fn(),
    updateDeal: vi.fn(),
    activityReport: vi.fn(async () => ({})),
    contactGrowthReport: vi.fn(async () => ({})),
    pipelineFunnelReport: vi.fn(async () => ({})),
    revenueForecastReport: vi.fn(async () => ({})),
    sourceAttributionReport: vi.fn(async () => []),
    winLossReport: vi.fn(async () => ({})),
  };
});

vi.mock('@workspace/db', () => ({
  db: {
    insert: () => {
      throw new Error('no database in this test');
    },
    select: () => {
      throw new Error('no database in this test');
    },
  },
  operatorDashboardSessions: {},
  crmMarketingSyncs: {},
  providerConnections: {},
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

import { createCrmRouter } from '../routes/crm.js';
import { issueOperatorDashboardSession } from '../operator-session.js';
// Imported straight from source: the barrel is mocked above, but the pure
// credential helpers must run for real to prove a secret never leaves.
import { maskCredentials, validateCredentials } from '../../../core/src/crm/integrations.js';

let base = '';
let close: () => Promise<void> = async () => undefined;
let session = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', createCrmRouter());
  await new Promise<void>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/crm`;
      close = () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done())));
      resolve();
    });
  });
  session = await issueOperatorDashboardSession('crm-integrations-test');
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMarketingConnections.mockResolvedValue([]);
  mocks.listMarketingSyncs.mockResolvedValue([]);
  mocks.searchContacts.mockResolvedValue([
    { email: 'a@b.com', firstName: 'A', lastName: 'B', organizationName: null, phoneE164: null, tags: [] },
  ]);
  mocks.findContactIdsByDestination.mockResolvedValue(['c1', 'c2']);
});

function headers(operatorSession?: string): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json' };
  if (operatorSession) out['X-Apex-Operator-Session'] = operatorSession;
  return out;
}

function post(path: string, body: unknown, operatorSession?: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST', headers: headers(operatorSession), body: JSON.stringify(body) });
}

function del(path: string, operatorSession?: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'DELETE', headers: headers(operatorSession) });
}

function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`);
}

describe('marketing integration reads are open, writes need an operator session', () => {
  it('lists connectors and connections without a session, and never echoes a secret', async () => {
    mocks.listMarketingConnections.mockResolvedValue([
      {
        provider: 'mailchimp',
        name: 'Mailchimp',
        status: 'configured',
        externalAccountId: null,
        audience: 'list-1',
        fields: maskCredentials('mailchimp', { apiKey: 'super-secret-key', serverPrefix: 'us1', listId: 'list-1' }),
        capabilities: ['audience_sync'],
        createdAt: 'now',
        updatedAt: 'now',
      },
    ]);
    const res = await get('/integrations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: Array<{ id: string }>; connections: Array<{ fields: Array<Record<string, unknown>> }> };
    expect(body.connectors[0]?.id).toBe('mailchimp');
    expect(body.connections[0]?.fields.every((field) => !('value' in field))).toBe(true);
    expect(JSON.stringify(body)).not.toContain('super-secret-key');
  });

  it('refuses to store credentials without an operator session', async () => {
    const res = await post('/integrations/mailchimp', { credentials: { apiKey: 'k', serverPrefix: 'us1', listId: 'l' } });
    expect(res.status).toBe(403);
    expect(mocks.saveMarketingConnection).not.toHaveBeenCalled();
  });

  it('stores credentials for a dashboard session', async () => {
    const res = await post(
      '/integrations/mailchimp',
      { credentials: { apiKey: 'k', serverPrefix: 'us1', listId: 'l' }, audience: 'list-9' },
      session,
    );
    expect(res.status).toBe(201);
    expect(mocks.saveMarketingConnection).toHaveBeenCalledWith({
      provider: 'mailchimp',
      name: undefined,
      credentials: { apiKey: 'k', serverPrefix: 'us1', listId: 'l' },
      audience: 'list-9',
      externalAccountId: null,
    });
  });

  it('rejects an unknown provider before it ever checks the session', async () => {
    const res = await post('/integrations/not-a-provider', { credentials: {} });
    expect(res.status).toBe(400);
    expect(mocks.saveMarketingConnection).not.toHaveBeenCalled();
  });

  it('refuses to delete a connection without an operator session', async () => {
    const res = await del('/integrations/mailchimp');
    expect(res.status).toBe(403);
    expect(mocks.deleteMarketingConnection).not.toHaveBeenCalled();
  });

  it('deletes a connection for a dashboard session', async () => {
    const res = await del('/integrations/mailchimp', session);
    expect(res.status).toBe(200);
    expect(mocks.deleteMarketingConnection).toHaveBeenCalledWith('mailchimp');
  });

  it('tests a connection without a session, since a probe only reads', async () => {
    const res = await post('/integrations/mailchimp/test', {});
    expect(res.status).toBe(200);
    expect(mocks.testMarketingConnection).toHaveBeenCalledWith('mailchimp');
  });
});

describe('audience sync', () => {
  it('refuses to push an audience without an operator session', async () => {
    const res = await post('/integrations/mailchimp/sync', {});
    expect(res.status).toBe(403);
    expect(mocks.syncAudience).not.toHaveBeenCalled();
  });

  it('pushes only contacts that are not opted out', async () => {
    const res = await post('/integrations/mailchimp/sync', { limit: 50 }, session);
    expect(res.status).toBe(200);
    expect(mocks.searchContacts).toHaveBeenCalledWith({ tag: null, lifecycleStage: null, doNotContact: false, limit: 50 });
    expect(mocks.syncAudience).toHaveBeenCalledWith({
      provider: 'mailchimp',
      actor: 'Matthew',
      limit: 50,
      contacts: [{ email: 'a@b.com', firstName: 'A', lastName: 'B', organizationName: null, phoneE164: null, tags: [] }],
    });
    const body = (await res.json()) as { ok: boolean; considered: number };
    expect(body.ok).toBe(true);
    expect(body.considered).toBe(1);
  });
});

describe('provider webhooks land as CRM opt-outs', () => {
  it('refuses a webhook without an operator session', async () => {
    const res = await post('/integrations/mailchimp/webhook', { type: 'unsubscribe', email: 'x@y.com' });
    expect(res.status).toBe(403);
    expect(mocks.setDoNotContact).not.toHaveBeenCalled();
  });

  it('turns an unsubscribe into a do-not-contact for every matching contact', async () => {
    const res = await post('/integrations/mailchimp/webhook', { type: 'unsubscribe', email: 'x@y.com' }, session);
    expect(res.status).toBe(200);
    expect(mocks.findContactIdsByDestination).toHaveBeenCalledWith(expect.anything(), 'x@y.com');
    expect(mocks.setDoNotContact).toHaveBeenCalledTimes(2);
    expect(mocks.setDoNotContact).toHaveBeenCalledWith({ contactId: 'c1', value: true, actor: 'Matthew', reason: 'mailchimp unsubscribe' });
  });

  it('records an unrecognised event without opting anyone out', async () => {
    const res = await post('/integrations/mailchimp/webhook', { type: 'contact.updated', email: 'x@y.com' }, session);
    expect(res.status).toBe(200);
    expect(mocks.setDoNotContact).not.toHaveBeenCalled();
    const body = (await res.json()) as { event: { kind: string }; appliedContactIds: string[] };
    expect(body.event.kind).toBe('other');
    expect(body.appliedContactIds).toEqual([]);
  });
});

describe('reporting reads', () => {
  it('serves the overview with the display timezone and no session', async () => {
    const res = await get('/reporting/overview?from=2026-01-01&to=2026-02-01');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timezone: string };
    expect(body.timezone).toBe('America/Chicago');
    expect(mocks.reportingOverview).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-02-01' });
  });
});

describe('credential masking and validation (pure)', () => {
  it('never returns a secret value, only whether it is set', () => {
    const masked = maskCredentials('mailchimp', { apiKey: 'super-secret-key', serverPrefix: 'us1', listId: 'l' });
    expect(masked.every((field) => !('value' in field))).toBe(true);
    expect(masked.find((field) => field.key === 'apiKey')?.set).toBe(true);
    expect(JSON.stringify(masked)).not.toContain('super-secret-key');
  });

  it('flags every missing required credential', () => {
    expect(validateCredentials('mailchimp', {})).toEqual({ ok: false, missing: ['apiKey', 'serverPrefix', 'listId'] });
  });

  it('accepts and trims a complete credential set', () => {
    const result = validateCredentials('mailchimp', { apiKey: '  k  ', serverPrefix: 'us1', listId: 'l' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.apiKey).toBe('k');
  });
});
