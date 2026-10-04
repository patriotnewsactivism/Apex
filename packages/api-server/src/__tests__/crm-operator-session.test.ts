import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setDoNotContact: vi.fn(async () => undefined),
  mergeContacts: vi.fn(async () => undefined),
}));

vi.mock('@workspace/core', () => ({
  OPERATOR_ACTOR: 'Matthew',
  attachUnmatched: vi.fn(),
  contactsToCsv: vi.fn(),
  duplicateSuggestions: vi.fn(),
  getContact: vi.fn(),
  getTimeline: vi.fn(),
  gmailAuthUrl: vi.fn(),
  gmailSyncEnabled: vi.fn(() => false),
  listUnmatched: vi.fn(),
  mergeContacts: mocks.mergeContacts,
  searchContacts: vi.fn(),
  setDoNotContact: mocks.setDoNotContact,
  syncGmailReadonly: vi.fn(),
  CRM_DISPLAY_TIMEZONE: 'America/Chicago',
  formatChicago: vi.fn(),
}));

// No database here, so a session is valid only if this process minted it.
vi.mock('@workspace/db', () => ({
  db: {
    insert: () => { throw new Error('no database in this test'); },
    select: () => { throw new Error('no database in this test'); },
  },
  operatorDashboardSessions: {},
}));

import { createCrmRouter } from '../routes/crm.js';
import { issueOperatorDashboardSession } from '../operator-session.js';

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
  session = await issueOperatorDashboardSession('crm-operator-session-test');
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function post(path: string, body: unknown, operatorSession?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (operatorSession) headers['X-Apex-Operator-Session'] = operatorSession;
  return fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('CRM actions that act as Matthew need an operator dashboard session', () => {
  it('refuses to clear do-not-contact with only the admin bearer', async () => {
    const res = await post('/contacts/c1/do-not-contact', { value: false });
    expect(res.status).toBe(403);
    expect(mocks.setDoNotContact).not.toHaveBeenCalled();
  });

  it('refuses a session header that was never minted', async () => {
    const res = await post('/contacts/c1/do-not-contact', { value: false }, 'f'.repeat(64));
    expect(res.status).toBe(403);
    expect(mocks.setDoNotContact).not.toHaveBeenCalled();
  });

  it('clears do-not-contact for a dashboard session', async () => {
    const res = await post('/contacts/c1/do-not-contact', { value: false }, session);
    expect(res.status).toBe(200);
    expect(mocks.setDoNotContact).toHaveBeenCalledWith({ contactId: 'c1', value: false, actor: 'Matthew', reason: null });
  });

  it('still lets any admin caller set do-not-contact, which only ever blocks sends', async () => {
    const res = await post('/contacts/c1/do-not-contact', { value: true, reason: 'asked to stop' });
    expect(res.status).toBe(200);
    expect(mocks.setDoNotContact).toHaveBeenCalledWith({ contactId: 'c1', value: true, actor: 'Matthew', reason: 'asked to stop' });
  });

  it('refuses to merge contacts with only the admin bearer', async () => {
    const res = await post('/merge', { winnerId: 'w1', loserId: 'l1', explicit: true });
    expect(res.status).toBe(403);
    expect(mocks.mergeContacts).not.toHaveBeenCalled();
  });

  it('merges contacts for a dashboard session', async () => {
    const res = await post('/merge', { winnerId: 'w1', loserId: 'l1', explicit: true }, session);
    expect(res.status).toBe(200);
    expect(mocks.mergeContacts).toHaveBeenCalledWith({ winnerId: 'w1', loserId: 'l1', explicit: true, actor: 'Matthew' });
  });
});
