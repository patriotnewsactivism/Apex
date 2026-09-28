import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createCartesiaSalesRouter, isExplicitOptOut, secretMatches } from './cartesia-sales.js';

describe('Cartesia sales webhook boundary', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    process.env.CARTESIA_TOOL_SECRET = 'test-tool-secret';
    process.env.CARTESIA_WEBHOOK_SECRET = 'test-event-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/cartesia', createCartesiaSalesRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    base = `http://127.0.0.1:${address.port}/api/cartesia`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.CARTESIA_TOOL_SECRET;
    delete process.env.CARTESIA_WEBHOOK_SECRET;
  });

  it('rejects missing or wrong secrets without reaching a database action', async () => {
    for (const [path, headers] of [
      ['/tools/lookup-lead', {}],
      ['/tools/lookup-lead', { Authorization: 'Bearer wrong' }],
      ['/events', { 'x-webhook-secret': 'wrong' }],
    ] as const) {
      const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
      expect(response.status).toBe(401);
    }
    expect(secretMatches('test-tool-secret', 'test-tool-secret')).toBe(true);
    expect(secretMatches('test-tool-secret', undefined)).toBe(false);
    expect(secretMatches('é', 'ab')).toBe(false);
  });

  it('validates phone, booking, and consent input before external effects', async () => {
    const cases = [
      ['/tools/lookup-lead', { phone_number: 'not-a-phone' }],
      ['/tools/book-consultation', { slot_time: 'tomorrow at two' }],
      ['/tools/send-demo-link', { phone_number: '+18328804970', demo_type: 'buildmybot_live_demo', consent_to_text: false }],
    ] as const;
    for (const [path, body] of cases) {
      const response = await fetch(base + path, { method: 'POST', headers: {
        Authorization: 'Bearer test-tool-secret', 'Content-Type': 'application/json',
      }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
  });

  it('rejects an inferred DNC before any database write', async () => {
    expect(isExplicitOptOut('Yep.')).toBe(false);
    expect(isExplicitOptOut('Yeah.')).toBe(false);
    expect(isExplicitOptOut('Not interested.')).toBe(false);
    expect(isExplicitOptOut('Please stop calling me.')).toBe(true);
    expect(isExplicitOptOut('Remove us from your list.')).toBe(true);
    for (const quote of [undefined, 'Yep.', 'Not interested.']) {
      const response = await fetch(base + '/tools/record-outcome', {
        method: 'POST', headers: { Authorization: 'Bearer test-tool-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_id: 'ac_test', phone_number: '+18328804970', disposition: 'dnc', opt_out_quote: quote }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('does not claim calendar availability without a connected calendar', async () => {
    delete process.env.APEX_CAL_API_KEY;
    delete process.env.APEX_CAL_EVENT_TYPE_ID;
    const response = await fetch(base + '/tools/check-calendar-availability', {
      method: 'POST', headers: { Authorization: 'Bearer test-tool-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date: '2026-10-01', end_date: '2026-10-03', timezone: 'America/Chicago' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('not connected') });
  });
});
