/**
 * Phone-line lamps: lifecycle + HTTP contract.
 *
 * Needs a real Postgres, so it is gated on APEX_TEST_DATABASE_URL (which must
 * point at a throwaway database) and skips otherwise -- same convention as the
 * other DB-backed suites here. It runs the REAL migrate() DDL and the REAL
 * router; nothing about the line_calls table or the queries is mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const TEST_DB = process.env.APEX_TEST_DATABASE_URL;
const suite = TEST_DB ? describe : describe.skip;

suite('phone lines (real Postgres)', () => {
  let server: Server;
  let base: string;
  let db: typeof import('@workspace/db').db;
  let lineCalls: typeof import('@workspace/db').lineCalls;
  let callOutcomes: typeof import('@workspace/db').callOutcomes;
  let core: typeof import('@workspace/core');

  const DON = '+18329757665';
  const FRONT = '+18323071234';

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const dbMod = await import('@workspace/db');
    db = dbMod.db;
    lineCalls = dbMod.lineCalls;
    callOutcomes = dbMod.callOutcomes;
    await dbMod.migrate();
    core = await import('@workspace/core');

    const express = (await import('express')).default;
    const { createPhoneLinesRouter } = await import('../routes/phone-lines.js');
    const app = express();
    app.use('/api/sales-ops', createPhoneLinesRouter());
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sales-ops`;
  });

  afterAll(async () => {
    server?.close();
  });

  beforeEach(async () => {
    await db.delete(lineCalls);
    await db.delete(callOutcomes);
  });

  const getLines = async () => (await fetch(`${base}/lines`)).json() as Promise<{
    lines: Array<{ number: string; busy: boolean; current: { seconds: number; remoteNumber: string | null } | null }>;
    anyBusy: boolean;
    busyCount: number;
    unlisted: Array<{ number: string }>;
  }>;

  it('every lamp is dark and the main lamp is off when nothing is happening', async () => {
    const res = await getLines();
    expect(res.anyBusy).toBe(false);
    expect(res.busyCount).toBe(0);
    expect(res.lines.length).toBeGreaterThanOrEqual(5);
    expect(res.lines.every((l) => !l.busy && l.current === null)).toBe(true);
  });

  it('lights only the line on a call, and the main lamp', async () => {
    await core.markLineBusy({
      lineNumber: DON,
      direction: 'outbound',
      source: 'cartesia-dial',
      remoteNumber: '+15551234567',
      remoteName: 'Pat',
      callId: 'cartesia:ac_1',
    });
    const res = await getLines();
    expect(res.anyBusy).toBe(true);
    expect(res.busyCount).toBe(1);
    expect(res.lines.find((l) => l.number === DON)?.busy).toBe(true);
    expect(res.lines.filter((l) => l.busy)).toHaveLength(1);
    expect(res.lines.find((l) => l.number === FRONT)?.busy).toBe(false);
  });

  it('two simultaneous calls light two lamps; the main lamp stays on until BOTH end', async () => {
    await core.markLineBusy({ lineNumber: DON, direction: 'outbound', source: 't', callId: 'a' });
    await core.markLineBusy({ lineNumber: FRONT, direction: 'inbound', source: 't', callId: 'b' });
    expect((await getLines()).busyCount).toBe(2);

    await core.markLineFree({ callId: 'a', reason: 'call_completed' });
    const mid = await getLines();
    expect(mid.anyBusy).toBe(true);
    expect(mid.lines.find((l) => l.number === DON)?.busy).toBe(false);
    expect(mid.lines.find((l) => l.number === FRONT)?.busy).toBe(true);

    await core.markLineFree({ callId: 'b', reason: 'hangup' });
    expect((await getLines()).anyBusy).toBe(false);
  });

  it('reporting the same call twice (dial path + start hook) does not double count', async () => {
    const start = { lineNumber: DON, direction: 'outbound' as const, source: 't', callId: 'dup' };
    await core.markLineBusy(start);
    await core.markLineBusy(start);
    expect((await getLines()).busyCount).toBe(1);
  });

  it('frees by line number when the hangup event carries a different call id', async () => {
    await core.markLineBusy({ lineNumber: FRONT, direction: 'inbound', source: 't', callId: 'control-id' });
    const closed = await core.markLineFree({ callId: 'conversation-id', lineNumber: FRONT });
    expect(closed).toBe(1);
    expect((await getLines()).anyBusy).toBe(false);
  });

  it('a missed hangup cannot pin a lamp on: stale calls are swept', async () => {
    await core.markLineBusy({ lineNumber: DON, direction: 'outbound', source: 't', callId: 'stuck' });
    const old = new Date(Date.now() - 40 * 60 * 1000);
    await db.update(lineCalls).set({ startedAt: old });
    const res = await getLines();
    expect(res.anyBusy).toBe(false);
  });

  it('a call on an unlisted number still lights the main lamp and is surfaced', async () => {
    await core.markLineBusy({ lineNumber: '+15559990000', direction: 'inbound', source: 't', callId: 'x' });
    const res = await getLines();
    expect(res.anyBusy).toBe(true);
    expect(res.unlisted.map((u) => u.number)).toContain('+15559990000');
  });

  it('normalizes number formats so (832) 975-7665 and +18329757665 are the same line', async () => {
    await core.markLineBusy({ lineNumber: '832-975-7665', direction: 'inbound', source: 't', callId: 'fmt' });
    expect((await getLines()).lines.find((l) => l.number === DON)?.busy).toBe(true);
  });

  it('transcript endpoint returns stored text, and 404s for unknown calls', async () => {
    await db.insert(callOutcomes).values({
      id: 'o1',
      callId: 'cartesia:ac_9',
      customerNumber: '+15551234567',
      customerName: 'Pat',
      disposition: 'no_decision',
      transcript: 'agent: hi\nuser: hello',
      summary: 'short call',
    });
    const ok = await fetch(`${base}/calls/${encodeURIComponent('cartesia:ac_9')}/transcript`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { transcript: string; summary: string };
    expect(body.transcript).toContain('user: hello');
    expect(body.summary).toBe('short call');

    const missing = await fetch(`${base}/calls/nope/transcript`);
    expect(missing.status).toBe(404);
  });

  it('recording endpoint reports 404 (not a crash) when no recording exists', async () => {
    const saved = process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_API_KEY;
    try {
      const res = await fetch(`${base}/calls/whatever/recording`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toMatch(/No recording/);
    } finally {
      if (saved) process.env.TELNYX_API_KEY = saved;
    }
  });
});
