/**
 * AC coverage for the sanctioned lead-status transition path used by the Lead
 * Researcher (apex-lead-research-001).
 *
 * Two suites:
 *   1. `updateLeadStatus tool contract` — always runs, no database needed.
 *      Proves the tool surface exposes the transition and that the contract
 *      requires lead id + target status + source URL + rationale, and that
 *      `updateLeadContactInfo` has no silently-ignored `status` parameter.
 *   2. `lead status transition (PATCH /api/leads/:id)` — writes rows, so it is
 *      gated on a *safe* database and skips otherwise.
 *
 * The HTTP surface is a local express app wired exactly like src/index.ts
 * (`app.use('/api', requireAdminAuth)`), so the transition is proven under the
 * real auth posture rather than a permissive stand-in.
 *
 * Fail-closed by construction: nothing here sends email, places a call, creates
 * a campaign, or writes a consent record — and the suite asserts that a
 * qualification leaves the lead's outbound footprint at zero.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { createBuiltinTools } from '@workspace/core';

// Fail-closed DB gate. This suite writes rows, so it must never point at a
// production database: it only runs against a local/test Postgres, identified by
// a localhost host or a *_test database name. Anything else skips rather than
// touching live lead data.
function isSafeTestDatabase(url: string | undefined): boolean {
  const raw = url?.trim();
  if (!raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const testDb = /_test$|^test_|^apex_test/.test(dbName);
  return local || testDb;
}
const hasDatabase = isSafeTestDatabase(process.env.DATABASE_URL);
const suite = hasDatabase ? describe : describe.skip;

// requireAdminAuth captures APEX_ADMIN_TOKEN at module load, so the DB-backed
// modules are imported dynamically once the token is in place.
const ADMIN_TOKEN = 'lead-status-transition-test-token';
process.env.APEX_ADMIN_TOKEN = ADMIN_TOKEN;

const tools = createBuiltinTools(process.cwd());
const callTool = async (name: string, args: Record<string, unknown>) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return (tool as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(args, {
    agentId: 'apex-lead-research-001',
    projectId: 'test-project',
  });
};

/** listResearchedLeads returns the rows directly. */
const rowsOf = (result: unknown): Array<Record<string, unknown>> =>
  Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];

suite('lead status transition (PATCH /api/leads/:id)', () => {
  let db: typeof import('@workspace/db').db;
  let researchedLeads: typeof import('@workspace/db').researchedLeads;
  let emailSends: typeof import('@workspace/db').emailSends;
  let server: Server;
  let base: string;
  const createdLeadIds: string[] = [];

  beforeAll(async () => {
    ({ db, researchedLeads, emailSends } = await import('@workspace/db'));
    const { createLeadsRouter } = await import('../routes/leads.js');
    const { requireAdminAuth } = await import('../middleware/auth.js');

    const app = express();
    app.use(express.json());
    // Mirror production: every /api route sits behind the admin bearer token.
    app.use('/api', requireAdminAuth);
    app.use('/api/leads', createLeadsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    base = `http://127.0.0.1:${address.port}/api/leads`;
    // updateLeadStatus talks to the API over HTTP; point it at this listener.
    process.env.APEX_API_BASE_URL = base;
    process.env.APEX_ADMIN_TOKEN = ADMIN_TOKEN;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (createdLeadIds.length) {
      await db.delete(emailSends).where(inArray(emailSends.leadId, createdLeadIds));
      await db.delete(researchedLeads).where(inArray(researchedLeads.id, createdLeadIds));
    }
  });

  /** Insert an isolated source-verified candidate sitting at status='new'. */
  async function seedLead(): Promise<string> {
    const id = randomUUID();
    createdLeadIds.push(id);
    const slug = id.slice(0, 8);
    await db.insert(researchedLeads).values({
      id,
      companyName: `ACME Status Transition ${slug}`,
      website: `https://${slug}.example.com`,
      industry: 'hvac',
      city: 'Austin',
      decisionMakerName: 'Real Owner',
      contactEmail: `probe-${slug}@example.com`,
      contactPhone: '+15125550100',
      contactSourceUrl: `https://${slug}.example.com/contact`,
      contactResearchStatus: 'complete',
      fitReason: 'after-hours voicemail gap',
      outreachAngle: 'answering-service fit',
      status: 'new',
      researchedByAgentId: 'apex-lead-research-001',
      createdAt: new Date(),
    } as never);
    return id;
  }

  const patch = async (
    leadId: string,
    body: Record<string, unknown>,
    authorization = `Bearer ${ADMIN_TOKEN}`,
    extraHeaders: Record<string, string> = {},
  ) => {
    const res = await fetch(`${base}/${leadId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization, ...extraHeaders },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const readBack = async (
    leadId: string,
    authorization = `Bearer ${ADMIN_TOKEN}`,
    extraHeaders: Record<string, string> = {},
  ) => {
    const res = await fetch(`${base}/${leadId}`, {
      method: 'GET',
      headers: { authorization, ...extraHeaders },
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  it('AC2a persists status=qualified and listResearchedLeads(status=qualified) returns it', async () => {
    const leadId = await seedLead();
    const sourceUrl = 'https://lead-evidence.example.com/about';
    const note = 'Owner named on /contact; matches ICP, after-hours gap';

    const response = await patch(leadId, { status: 'qualified', sourceUrl, note }, `Bearer ${ADMIN_TOKEN}`, {
      'x-apex-actor': 'apex-lead-research-001',
    });

    expect(response.status).toBe(200);
    // The response reports what is actually stored, not an echo of the request.
    expect(response.json).toMatchObject({
      success: true,
      id: leadId,
      status: 'qualified',
      previousStatus: 'new',
      persistedStatus: 'qualified',
    });

    // Independent request-boundary verification: a second authenticated GET
    // must observe the persisted state rather than trusting the PATCH response.
    const independent = await readBack(leadId, `Bearer ${ADMIN_TOKEN}`, {
      'x-apex-actor': 'buildmybot:test-admin',
    });
    expect(independent.status).toBe(200);
    expect(independent.json).toMatchObject({
      success: true,
      id: leadId,
      status: 'qualified',
    });

    // Proof of persistence: read the row straight out of the database.
    const [row] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, leadId)).limit(1);
    expect(row?.status).toBe('qualified');
    expect(row?.qualifiedAt).toBeInstanceOf(Date);

    // Audit metadata landed in the existing jsonb column — and only what the
    // caller supplied. Nothing about consent is inferred.
    const audit = (row?.pipelineMetadata as { statusAudit?: Array<Record<string, unknown>> } | null)?.statusAudit;
    expect(Array.isArray(audit)).toBe(true);
    expect(audit?.[audit.length - 1]).toMatchObject({
      from: 'new',
      to: 'qualified',
      sourceUrl,
      note,
      actor: 'apex-lead-research-001',
    });

    // And the cohort is queryable through the exposed read tool.
    const listed = rowsOf(await callTool('listResearchedLeads', { status: 'qualified', ids: [leadId], limit: 50 }));
    expect(listed.map((l) => l.id)).toContain(leadId);
    expect(listed.find((l) => l.id === leadId)?.status).toBe('qualified');
  });

  it('AC2b rejects an invalid status with 400 and leaves the row untouched', async () => {
    const leadId = await seedLead();

    const response = await patch(leadId, { status: 'sold', sourceUrl: 'https://x.example.com/a', note: 'bogus status probe' });

    expect(response.status).toBe(400);
    expect(response.json.error).toContain('status must be one of');

    const [row] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, leadId)).limit(1);
    expect(row?.status).toBe('new');
    expect(row?.qualifiedAt).toBeNull();
  });

  it('AC2c fails closed on an unknown lead id instead of reporting silent success', async () => {
    const missing = randomUUID();
    const response = await patch(missing, { status: 'qualified', sourceUrl: 'https://x.example.com/a', note: 'no such lead' });
    expect(response.status).toBe(404);
    expect(response.json.error).toContain(missing);

    const readResponse = await readBack(missing);
    expect(readResponse.status).toBe(404);
    expect(readResponse.json).toMatchObject({ success: false, error: 'lead_not_found' });
  });

  it('AC2d requires at least one of status / pipelineState', async () => {
    const leadId = await seedLead();
    const response = await patch(leadId, { note: 'no transition requested' });
    expect(response.status).toBe(400);
    expect(response.json.error).toBe('status or pipelineState is required');
  });

  it('AC2e validates the audit fields when supplied', async () => {
    const leadId = await seedLead();

    const badUrl = await patch(leadId, { status: 'qualified', sourceUrl: 'not-a-url', note: 'malformed source url' });
    expect(badUrl.status).toBe(400);
    expect(badUrl.json.error).toContain('sourceUrl');

    const badNote = await patch(leadId, { status: 'qualified', sourceUrl: 'https://x.example.com/a', note: 'ab' });
    expect(badNote.status).toBe(400);
    expect(badNote.json.error).toContain('note');

    const [row] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, leadId)).limit(1);
    expect(row?.status).toBe('new');
  });

  it('AC4 the route is unreachable without the admin bearer token', async () => {
    const leadId = randomUUID();
    const noToken = await fetch(`${base}/${leadId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'qualified' }),
    });
    expect(noToken.status).toBe(401);

    const wrongToken = await patch(leadId, { status: 'qualified' }, 'Bearer definitely-not-the-token');
    expect(wrongToken.status).toBe(401);
  });

  it('AC1+AC3 updateLeadStatus drives the same validated path end to end', async () => {
    const leadId = await seedLead();

    const result = (await callTool('updateLeadStatus', {
      leadId,
      status: 'qualified',
      sourceUrl: 'https://lead-evidence.example.com/about',
      note: 'qualified through ICP review, no outreach performed',
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ updated: true, leadId, status: 'qualified', previousStatus: 'new' });

    const [row] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, leadId)).limit(1);
    expect(row?.status).toBe('qualified');

    // A status change is metadata only: zero outbound footprint, no consent.
    const [sends] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailSends)
      .where(eq(emailSends.leadId, leadId));
    expect(Number(sends?.count ?? 0)).toBe(0);

    const readback = rowsOf(await callTool('listResearchedLeads', {
      status: 'qualified',
      ids: [leadId],
      limit: 1,
    }));
    expect(readback[0]?.status).toBe('qualified');
    expect(readback.outreach).toMatchObject({ sendCount: 0 });
  });

  it('AC3 updateLeadStatus fails closed when the sanctioned API is unreachable', async () => {
    const previousBase = process.env.APEX_API_BASE_URL;
    process.env.APEX_API_BASE_URL = 'http://127.0.0.1:1'; // nothing listening
    try {
      const result = (await callTool('updateLeadStatus', {
        leadId: randomUUID(),
        status: 'qualified',
        sourceUrl: 'https://lead-evidence.example.com/about',
        note: 'unreachable API must not be worked around',
      })) as Record<string, unknown>;
      // Not an exception, and not a success: an explicit error the agent reads.
      expect(result.updated).toBe(false);
      expect(String(result.error)).toContain('could not reach');
    } finally {
      process.env.APEX_API_BASE_URL = previousBase;
    }
  });
});

describe('updateLeadStatus tool contract (no database required)', () => {
  it('AC1 updateLeadStatus requires leadId, status, sourceUrl and note', () => {
    const tool = tools.find((t) => t.name === 'updateLeadStatus') as unknown as {
      requiresApproval: boolean;
      schema: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(tool, 'updateLeadStatus must be registered for the Lead Researcher seat').toBeDefined();

    expect(
      tool.schema.safeParse({
        leadId: 'some-lead-id',
        status: 'qualified',
        sourceUrl: 'https://lead-evidence.example.com/about',
        note: 'matches the ICP on service line and location',
      }).success,
    ).toBe(true);

    for (const incomplete of [
      { leadId: 'x', status: 'qualified' },
      { leadId: 'x', status: 'qualified', sourceUrl: 'https://a.example.com' },
      { status: 'qualified', sourceUrl: 'https://a.example.com', note: 'missing the lead id' },
      { leadId: 'x', status: 'invented-status', sourceUrl: 'https://a.example.com', note: 'bad status value' },
      { leadId: 'x', status: 'qualified', sourceUrl: 'not a url', note: 'bad source url' },
    ]) {
      expect(tool.schema.safeParse(incomplete).success, JSON.stringify(incomplete)).toBe(false);
    }

    // Qualification is a metadata write, not an outreach action, so it is not
    // approval-gated — but it must never be able to send anything itself.
    expect(tool.requiresApproval).toBe(false);
  });

  it('AC1 updateLeadContactInfo does not accept a status — no silently ignored field', () => {
    const tool = tools.find((t) => t.name === 'updateLeadContactInfo') as unknown as {
      schema: { _def?: { shape?: Record<string, unknown> | (() => Record<string, unknown>) } };
    };
    expect(tool).toBeDefined();
    const shape = tool.schema?._def?.shape;
    const fields = Object.keys(typeof shape === 'function' ? shape() : shape ?? {});
    expect(fields).not.toContain('status');
  });

  it('AC1 the Lead Researcher seat is granted updateLeadStatus', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../../agents/src/business.ts', import.meta.url), 'utf8');
    expect(source).toContain("'updateLeadStatus'");
    // And the prompt tells the agent qualification is a write, not a claim.
    expect(source).toContain('Qualification is a WRITE, not a statement');
  });
});
