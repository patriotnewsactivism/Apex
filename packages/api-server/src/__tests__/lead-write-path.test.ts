/**
 * Ticket QA-1 — acceptance coverage for the researched-lead write-path fixes
 * (AC1-AC5) delivered under BE-1.
 *
 * Target of this file is the WRITE path the Lead Researcher (apex-lead-research-001)
 * and the campaign runner share: `saveResearchedLead` / `saveResearchedLeadsBatch`
 * into `researched_leads`. It is the sibling of `lead-status-transition.test.ts`,
 * which covers the transition path; this file deliberately reuses that file's
 * shape rather than inventing a new one:
 *
 *   1. `lead write path — tool contract` — ALWAYS RUNS, needs no database.
 *      Proves the contract the COO's defect report says is missing: a
 *      lookup-only mode that cannot write, duplicate reporting that names the
 *      row and the producer it came from, a geography gate with a deterministic
 *      refusal code, producer provenance that survives to the row, and the
 *      documentation correction for the (non-)existence of a delete-lead API.
 *   2. `lead write path (researched_leads writes)` — writes rows, so it is
 *      gated on a *safe* database and skips otherwise.
 *
 * SPEC-FIRST: BE-1 implements these fixes in parallel, so the contract suite is
 * expected to be RED on current main and GREEN once BE-1 lands. Every failure
 * message names the AC it is guarding, so a red run reads as a defect list
 * rather than as noise. Nothing here is a tautology: each assertion restates the
 * behaviour the ticket demands, not whatever main happens to do today.
 *
 * Fail-closed by construction: nothing in this file sends email, places a call,
 * creates a campaign, or writes a consent record. The DB suite additionally
 * asserts the lead's outbound footprint stays at zero, and the CEO hold on
 * sales outbound is pinned separately against the real policy decision function
 * (`decideSalesOutbound`) so "no outreach while the hold stands" is proven by the
 * same code the runtime uses, not by a comment.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createBuiltinTools,
  researchedLeadInputSchema,
  emptyOutboundPolicy,
  decideSalesOutbound,
  SALES_OUTBOUND_TOOLS,
} from '@workspace/core';

const HERE = fileURLToPath(import.meta.url);

/** Source of the registry, read as text for the few contracts that are about
 *  which branch increments which counter. Scoped to the tool bodies by slicing
 *  from the tool name to the next `name:` so a match elsewhere in the file
 *  cannot make the assertion pass. */
const registrySource = readFileSync(resolve(HERE, '../../../../core/src/tool-registry.ts'), 'utf8');
const leadSeatSource = readFileSync(resolve(HERE, '../../../../agents/src/business.ts'), 'utf8');
const capabilityMatrix = readFileSync(resolve(HERE, '../../../../../docs/APEX_CAPABILITY_MATRIX.md'), 'utf8');

/**
 * Assert `needle` appears in a large source region WITHOUT dumping the region
 * on failure: vitest prints the whole haystack for toContain(), which would
 * bury the AC list this suite is meant to produce.
 */
function expectContains(haystack: string, needle: string, what: string): void {
  expect(haystack.includes(needle), `${what}: expected \`${needle}\` to appear`).toBe(true);
}

/** The text of one tool's registration, from its `name:` to the next one. */
function registryRegion(name: string): string {
  const start = registrySource.indexOf(`name: '${name}'`);
  if (start < 0) return '';
  const next = registrySource.indexOf("\n      name: '", start + name.length + 8);
  return registrySource.slice(start, next < 0 ? start + 6000 : next);
}

// ---------------------------------------------------------------------------
// Fail-closed DB gate (copied from lead-status-transition.test.ts).
// This suite writes rows, so it must never point at a production database: it
// only runs against a local/test Postgres, identified by a localhost host or a
// *_test database name. Anything else skips rather than touching live lead data
// — including the Railway production URL that is present in this environment.
// ---------------------------------------------------------------------------
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
// HTTP surface is given a test-only token before the middleware is imported.
const ADMIN_TOKEN = 'qa1-lead-write-path-test-token';
process.env.APEX_ADMIN_TOKEN = ADMIN_TOKEN;

const tools = createBuiltinTools(process.cwd());
const toolNames = tools.map((t) => t.name);
const toolFor = (name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool as unknown as {
    description: string;
    schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } } };
    execute: (args: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
  };
};

/** Context a producer hands the registry. `taskId` is the provenance the
 *  ticket requires be written into the row: the real BaseAgent supplies it, so
 *  tests must too, and a tool that ignores it is the defect AC4 covers. */
const ctxFor = (agentId: string, taskId: string | null = null) => ({
  agentId,
  projectId: 'qa1-lead-write-path',
  taskId,
});

const runTool = async (name: string, args: Record<string, unknown>, agentId = 'apex-lead-research-001', taskId: string | null = null) =>
  toolFor(name).execute(args, ctxFor(agentId, taskId));

/** A payload that satisfies the producer contract as it exists on main. */
const leadPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  companyName: 'ACME Write Path Probe',
  website: 'https://acme-write-path.example.com',
  industry: 'hvac',
  city: 'Austin',
  decisionMakerName: 'Real Owner',
  contactEmail: 'owner@acme-write-path.example.com',
  contactPhone: '+15125550100',
  contactSourceUrl: 'https://acme-write-path.example.com/contact',
  contactResearchStatus: 'complete',
  fitReason: 'after-hours voicemail gap',
  outreachAngle: 'answering-service fit',
  ...over,
});

// ===========================================================================
// Suite 1 — tool contract. Always runs, no database.
// ===========================================================================
describe('lead write path — tool contract (no database)', () => {
  it('AC0 the write-path tools the ticket names are actually registered', () => {
    for (const name of ['saveResearchedLead', 'saveResearchedLeadsBatch', 'listResearchedLeads', 'updateLeadContactInfo', 'updateLeadStatus']) {
      expect(toolNames, `${name} must be registered`).toContain(name);
    }
    // And the defect report's claim about a delete API is confirmed: there is
    // none. If someone adds one, this fails and the capability matrix (AC5)
    // has to be updated in the same change rather than drifting again.
    const deleteish = toolNames.filter((n) => /^delete|^remove|^archive/i.test(n) && /lead/i.test(n));
    expect(deleteish, 'no delete-lead tool may exist while AC5 says there is none').toEqual([]);
  });

  it('AC1 duplicate reporting is actionable: the single-save contract names the row and its producer', () => {
    const region = registryRegion('saveResearchedLead');
    expect(region, 'saveResearchedLead registration found').not.toBe('');
    // Main returns `{ duplicate: true, existingLeadId }` only — the agent cannot
    // tell which pipeline the existing row belongs to, which is how the wave-3
    // contamination stayed invisible. The ticket's fix is `duplicateDetails`.
    expect(region).toContain('duplicateDetails');
    expect(region).toContain('researchedByAgentId');
  });

  it('AC1 batch duplicate reporting replaces the bare counter with details', () => {
    const region = registryRegion('saveResearchedLeadsBatch');
    expect(region, 'saveResearchedLeadsBatch registration found').not.toBe('');
    expect(region).toContain('duplicateDetails');
    // The bare `duplicates` count must not be the only signal any more, and the
    // runner that consumes this result must not be able to read a refusal or a
    // dedup as a silent success.
    const returnsBareCountOnly = /\n\s*return \{ saved, duplicates, failed, total/.test(region);
    expect(returnsBareCountOnly, 'batch return must carry per-lead detail, not only counters').toBe(false);
  });

  it('AC2 geography is enforced with a deterministic refusal code, not a silent drop', () => {
    const single = registryRegion('saveResearchedLead');
    const batch = registryRegion('saveResearchedLeadsBatch');
    expect(single).toContain('OUT_OF_SCOPE_GEOGRAPHY');
    expect(batch).toContain('OUT_OF_SCOPE_GEOGRAPHY');
    expect(batch).toContain('refusedGeography');
    // A refusal must be a distinct outcome from a dedup and from a failure:
    // three counters, none of them conflated.
    expect(batch).toContain('saved');
    expect(batch).toContain('duplicates');
    expect(batch).toContain('failed');
  });

  it('AC2 no input field lets a producer talk its way past the gate', () => {
    const schema = toolFor('saveResearchedLead').schema;
    const bypassish = ['skipGeography', 'ignoreGeography', 'force', 'bypass', 'allowAnyGeography'];
    // Zod strips unknown keys, so the guarantee is not "the parse rejects it"
    // but "no key in the writer can turn the gate off". Assert that directly.
    for (const key of bypassish) expect(schema.safeParse(leadPayload({ [key]: true })).success).toBe(true);
    const single = registryRegion('saveResearchedLead');
    for (const key of bypassish) expect(single, `gate must not honour ${key}`).not.toContain(key);
  });

  it('AC3 lookupOnly is a typed, optional boolean on both save tools — not a stripped unknown', () => {
    // Zod strips unknown keys, so "the schema accepted lookupOnly" would pass
    // on main without any fix. The discriminating assertion is that a
    // NON-boolean lookupOnly is rejected: that only happens once the field is
    // declared in the schema, which is what BE-1 adds.
    for (const name of ['saveResearchedLead', 'saveResearchedLeadsBatch']) {
      const schema = toolFor(name).schema;
      const wrap = (over: Record<string, unknown>) =>
        name === 'saveResearchedLeadsBatch' ? { leads: [leadPayload()], ...over } : leadPayload(over);

      expect(schema.safeParse(wrap({})).success, `${name}: lookupOnly must stay optional`).toBe(true);
      expect(
        schema.safeParse(wrap({ lookupOnly: 'yes' })).success,
        `${name}: lookupOnly must be a declared boolean field, not an ignored unknown key`,
      ).toBe(false);
      expect(
        schema.safeParse(wrap({ lookupOnly: true })).success,
        `${name}: lookupOnly: true must parse`,
      ).toBe(true);
    }
  });

  it('AC3 the lookupOnly contract is stated where the agent reads it', () => {
    for (const name of ['saveResearchedLead', 'saveResearchedLeadsBatch']) {
      const region = registryRegion(name);
      expect(region).toContain('lookupOnly');
      // The description is the only thing an LLM sees before it calls the tool.
      // If lookupOnly is not described, agents cannot use it to check dedup
      // without polluting the queue — the exact failure mode in the ticket.
      const description = region.slice(0, region.indexOf('schema:'));
      expect(description.toLowerCase(), `${name} description must tell the agent lookupOnly writes nothing`).toContain('lookuponly');
    }
  });

  it('AC4 provenance: the write contract records the producing task', () => {
    const single = registryRegion('saveResearchedLead');
    const batch = registryRegion('saveResearchedLeadsBatch');
    expect(single).toContain('taskRef');
    expect(batch).toContain('taskRef');
    // Batch research is attributed to a batch identity so a contaminated cohort
    // can be traced to one run instead of to "the lead researcher".
    expect(batch).toContain('agent_research_batch');
    // Provenance must come from the calling context, never a hardcoded seat id:
    // the wave-3 rows were attributed to apex-lead-research-001 because the
    // writer stamped ctx.agentId blindly.
    expect(single).toContain('ctx.agentId');
  });

  it('AC4 the input schema still refuses a payload missing required fields (no silent partial writes)', () => {
    // Regression guard for #124/#175: a required field added to this schema
    // breaks the campaign runner unless the runner is typed against it. The
    // runner's producer is typed, so assert the contract both sides share.
    const missingRequired = { companyName: 'No Fit Reason', website: 'https://nofit.example.com' };
    expect(researchedLeadInputSchema.safeParse(missingRequired).success).toBe(false);
    expect(researchedLeadInputSchema.safeParse(leadPayload()).success).toBe(true);
    const batchRegion = registryRegion('saveResearchedLeadsBatch');
    expect(batchRegion).toContain('researchedLeadInputSchema');
  });

  it('AC5 the capability matrix states update exists and delete does not', () => {
    expect(capabilityMatrix, 'docs/APEX_CAPABILITY_MATRIX.md must be readable from this test').not.toBe('');
    const lower = capabilityMatrix.toLowerCase();
    // AC5 is a documentation correction, not a capability gap: the earlier
    // report ("no delete-or-update-lead API") was wrong about update and right
    // about delete. The matrix must now say both halves explicitly.
    expect(lower).toContain('updatable');
    expect(lower).toContain('no delete');
    expect(lower).toContain('updateleadstatus');
    expect(lower).toContain('updateleadcontactinfo');
  });

  it('AC5 the lead-research seat is told update exists and delete does not', () => {
    expect(leadSeatSource, 'packages/agents/src/business.ts must be readable from this test').not.toBe('');
    const seat = leadSeatSource.slice(
      leadSeatSource.indexOf("id: 'apex-lead-research-001'"),
      leadSeatSource.indexOf("id: 'apex-lead-research-001'") + 9000,
    );
    const lower = seat.toLowerCase();
    expect(lower, 'seat prompt must name the sanctioned update path').toContain('updateleadstatus');
    expect(lower, 'seat prompt must state that no delete API exists').toContain('no delete');
    // Both update tools are in the seat allowlist already; assert it so the
    // documentation claim is backed by the actual tool surface.
    const allowlist = seat.slice(seat.indexOf('tools: ['), seat.indexOf(']', seat.indexOf('tools: [')));
    expect(allowlist).toContain('updateLeadContactInfo');
    expect(allowlist).toContain('updateLeadStatus');
    expect(allowlist).toContain('saveResearchedLeadsBatch');
  });

  it('fail-closed: the CEO hold on sales outbound is enforced by the policy function itself', () => {
    // The ticket fixes a WRITE path while an executive hold stands on outreach.
    // Pin the hold against the same decision function the runtime uses, so a
    // lead-saving change cannot quietly open the send path.
    for (const tool of [...SALES_OUTBOUND_TOOLS]) {
      const off = decideSalesOutbound({
        toolName: tool,
        destinationEmail: 'owner@acme-write-path.example.com',
        destinationPhone: '+15125550100',
        policy: { ...emptyOutboundPolicy(), mode: 'off' },
      });
      expect(off.autoApprove, `${tool} must not auto-approve with mode=off`).toBe(false);
      expect(String(off.reason)).toContain('outbound policy is off');

      const killed = decideSalesOutbound({
        toolName: tool,
        destinationEmail: 'owner@acme-write-path.example.com',
        policy: { ...emptyOutboundPolicy(), mode: 'capped_live', killSwitch: true, dailyEmailCap: 50 },
      });
      expect(killed.autoApprove, `${tool} must not auto-approve with killSwitch=true`).toBe(false);
      expect(String(killed.reason)).toContain('kill switch');
    }
  });
});

// ===========================================================================
// Suite 2 — real writes. Gated on a safe test database; skips otherwise.
// ===========================================================================
suite('lead write path (researched_leads writes)', () => {
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

    // Wired exactly like src/index.ts: the router sits behind real admin auth,
    // so the write path is proven under the production auth posture.
    const app = express();
    app.use(express.json());
    app.use('/api', requireAdminAuth);
    app.use('/api/leads', createLeadsRouter());
    server = createServer(app);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
    base = `http://127.0.0.1:${address.port}`;
    process.env.APEX_ADMIN_TOKEN = ADMIN_TOKEN;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (createdLeadIds.length) {
      await db.delete(emailSends).where(inArray(emailSends.leadId, createdLeadIds));
      await db.delete(researchedLeads).where(inArray(researchedLeads.id, createdLeadIds));
    }
  });

  const websiteFor = (tag: string) => `https://${tag}-${randomUUID().slice(0, 8)}.example.com`;

  const readRow = async (leadId: string) => {
    const [row] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, leadId)).limit(1);
    return row as Record<string, unknown> | undefined;
  };

  const post = async (path: string, body: unknown, token = ADMIN_TOKEN) => {
    const response = await fetch(`${base}/api/leads${path}`, {
      method: 'POST',
      headers: token ? { 'content-type': 'application/json', authorization: `Bearer ${token}` } : { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try { json = (await response.json()) as Record<string, unknown>; } catch { /* non-JSON body */ }
    return { status: response.status, json };
  };

  it('AC1 saveResearchedLead returns duplicateDetails that identify the row and its producing seat', async () => {
    const website = websiteFor('acme-dup');
    const first = await runTool('saveResearchedLead', leadPayload({ website }), 'apex-lead-research-001', 'task-producer-1');
    const firstId = String(first.leadId ?? '');
    expect(firstId).not.toBe('');
    createdLeadIds.push(firstId);

    const second = await runTool('saveResearchedLead', leadPayload({ website, companyName: 'ACME Duplicate Probe' }), 'apex-lead-research-001', 'task-producer-2');
    expect(second.duplicate).toBe(true);

    const details = second.duplicateDetails as
      | { existingLeadId?: string; researchedByAgentId?: string; taskRef?: unknown; status?: string; pipelineState?: string }
      | undefined;
    expect(details, 'duplicate result must carry duplicateDetails so the agent can act on it').toBeTruthy();
    expect(details?.existingLeadId).toBe(firstId);
    expect(details?.researchedByAgentId).toBe('apex-lead-research-001');
    expect(details?.status).toBe('new');

    // No second row for the same website.
    const rows = await db.select().from(researchedLeads).where(eq(researchedLeads.website, website));
    expect(rows.length).toBe(1);
  });

  it('AC1/AC3 batch reports per-item duplicate detail instead of a bare count', async () => {
    const website = websiteFor('acme-batch');
    const freshWebsite = websiteFor('acme-fresh');
    const first = await runTool('saveResearchedLead', leadPayload({ website }), 'apex-lead-research-001', 'task-producer-1');
    createdLeadIds.push(String(first.leadId));

    const batch = await runTool('saveResearchedLeadsBatch', {
      leads: [
        leadPayload({ website }),                                    // duplicate of the row above
        leadPayload({ companyName: 'ACME Fresh Batch Lead', website: freshWebsite }), // new
      ],
    }, 'apex-lead-research-001', 'task-producer-2');

    expect(Number(batch.saved)).toBe(1);
    const duplicateDetails = (batch.duplicateDetails ?? []) as Array<Record<string, unknown>>;
    expect(Array.isArray(duplicateDetails)).toBe(true);
    expect(duplicateDetails.length, 'a deduped item must appear in duplicateDetails, not only in a counter').toBeGreaterThanOrEqual(1);
    expect(String(duplicateDetails[0]?.companyName ?? duplicateDetails[0]?.website ?? '')).toContain('ACME');

    // Track the batch-inserted row for cleanup.
    const rows = await db.select().from(researchedLeads).where(eq(researchedLeads.website, freshWebsite)).limit(1);
    if (rows[0]?.id) createdLeadIds.push(String(rows[0].id));
  });

  it('AC1/AC3 a website repeated inside one batch is saved once, with or without lookupOnly', async () => {
    const website = websiteFor('acme-repeat');
    const repeated = { leads: [leadPayload({ website }), leadPayload({ website, companyName: 'ACME Repeat Copy' })] };

    const lookup = await runTool('saveResearchedLeadsBatch', { ...repeated, lookupOnly: true }, 'apex-lead-research-001', 'task-producer-3');
    expect(lookup.lookupOnly).toBe(true);
    expect(Number(lookup.saved)).toBe(0);
    expect(Number(lookup.wouldSave)).toBe(1);
    expect(Number(lookup.duplicates)).toBe(1);
    const lookupRows = await db.select().from(researchedLeads).where(eq(researchedLeads.website, website));
    expect(lookupRows.length, 'lookupOnly must never insert a row').toBe(0);

    const batch = await runTool('saveResearchedLeadsBatch', repeated, 'apex-lead-research-001', 'task-producer-3');
    expect(Number(batch.saved)).toBe(1);
    expect(Number(batch.duplicates)).toBe(1);
    expect(Number(batch.failed)).toBe(0);
    const savedLeads = batch.savedLeads as Array<{ leadId: string }>;
    for (const lead of savedLeads) createdLeadIds.push(lead.leadId);
    const details = batch.duplicateDetails as Array<{ existingLeadId?: string; companyName?: string }>;
    expect(details[0]?.existingLeadId, 'the copy names the row the first lead just created').toBe(savedLeads[0]?.leadId);
    expect(details[0]?.companyName).toBe('ACME Repeat Copy');
    const rows = await db.select().from(researchedLeads).where(eq(researchedLeads.website, website));
    expect(rows.length).toBe(1);
  });

  it('AC3 lookupOnly reports the dedup answer and writes nothing', async () => {
    const website = websiteFor('acme-lookup');
    const saved = await runTool('saveResearchedLead', leadPayload({ website }), 'apex-lead-research-001', 'task-producer-1');
    createdLeadIds.push(String(saved.leadId));

    // Existing website: lookupOnly must say "duplicate" without inserting.
    const lookup = await runTool('saveResearchedLead', leadPayload({ website, lookupOnly: true }), 'apex-lead-research-001', 'task-producer-2');
    expect(lookup.duplicate).toBe(true);
    expect(lookup.lookupOnly).toBe(true);

    // Unknown website: lookupOnly must report "would save" and still insert nothing.
    const fresh = await runTool('saveResearchedLead', leadPayload({ website: websiteFor('acme-lookup-new'), lookupOnly: true }), 'apex-lead-research-001', 'task-producer-2');
    expect(fresh.duplicate).toBe(false);
    expect(fresh.lookupOnly).toBe(true);
    expect(fresh.saved).not.toBe(true);
    expect(fresh.leadId ?? fresh.wouldSave).toBeTruthy();

    const count = await db.select({ count: sql<number>`count(*)::int` }).from(researchedLeads).where(eq(researchedLeads.website, website));
    expect(Number(count[0]?.count ?? 0)).toBe(1);
    const freshRows = await db.select().from(researchedLeads).where(eq(researchedLeads.website, (fresh as { website?: string }).website ?? ''));
    expect(freshRows.length, 'lookupOnly must never insert a row').toBe(0);
  });

  it('AC2 an out-of-scope geography is refused with a deterministic code and no row', async () => {
    const refused = await runTool('saveResearchedLead', leadPayload({ city: 'Lima', website: websiteFor('acme-lima') }), 'apex-lead-research-001', 'task-producer-1');
    expect(refused.saved).not.toBe(true);
    expect(refused.refusedGeography).toBe(true);
    expect(String(refused.error ?? refused.reason ?? '')).toContain('OUT_OF_SCOPE_GEOGRAPHY');
    expect(refused.leadId ?? '').toBe('');

    // A refusal is not a duplicate and not a crash: it is its own outcome.
    expect(refused.duplicate).not.toBe(true);

    // In-scope city still saves, so the gate is a scope rule and not a blanket block.
    const allowed = await runTool('saveResearchedLead', leadPayload({ city: 'Austin', website: websiteFor('acme-austin') }), 'apex-lead-research-001', 'task-producer-1');
    expect(allowed.saved).toBe(true);
    createdLeadIds.push(String(allowed.leadId));
  });

  it('AC2 batch separates refusals from duplicates from failures', async () => {
    const refusedWebsite = websiteFor('acme-b-lima');
    const acceptedWebsite = websiteFor('acme-b-austin');
    const batch = await runTool('saveResearchedLeadsBatch', {
      leads: [
        leadPayload({ companyName: 'Out Of Scope Lead', city: 'Lima', website: refusedWebsite }),
        leadPayload({ companyName: 'In Scope Lead', city: 'Austin', website: acceptedWebsite }),
      ],
    }, 'apex-lead-research-001', 'task-producer-2');

    expect(Number(batch.saved)).toBe(1);
    expect(Number(batch.refusedGeography ?? 0)).toBe(1);
    expect(Number(batch.duplicates)).toBe(0);
    expect(Number(batch.failed)).toBe(0);
    expect(Number(batch.total)).toBe(2);

    const refusedRows = await db.select().from(researchedLeads).where(eq(researchedLeads.city, 'Lima'));
    expect(refusedRows.length, 'a refused geography must never reach the table').toBe(0);

    const savedRow = await db.select().from(researchedLeads).where(eq(researchedLeads.website, acceptedWebsite));
    if (savedRow[0]?.id) createdLeadIds.push(String(savedRow[0].id));
    expect(savedRow.length).toBe(1);
  });

  it('AC4 provenance lands on the row: seat id and producing task are both recorded', async () => {
    const taskId = `qa1-task-${randomUUID().slice(0, 8)}`;
    const website = websiteFor('acme-prov');
    const saved = await runTool('saveResearchedLead', leadPayload({ website }), 'apex-lead-research-001', taskId);
    const leadId = String(saved.leadId);
    createdLeadIds.push(leadId);

    const row = await readRow(leadId);
    expect(row, 'the saved row must be readable').toBeTruthy();
    expect(String(row?.researchedByAgentId)).toBe('apex-lead-research-001');

    // taskRef is the field the ticket adds so a cohort can be traced to one run.
    // Accept either a dedicated column or a documented slot in the existing
    // jsonb provenance, but it must be queryable and must equal the caller's id.
    const pipelineMeta = (row?.pipelineMetadata ?? {}) as Record<string, unknown>;
    const enrichment = (row?.enrichmentData ?? {}) as Record<string, unknown>;
    const recordedTaskRef = (row as { taskRef?: unknown })?.taskRef
      ?? pipelineMeta.taskRef ?? enrichment.taskRef
      ?? pipelineMeta.producingTaskId;
    expect(String(recordedTaskRef ?? ''), 'the producing task id must be persisted with the lead').toBe(taskId);
  });

  it('AC4 batch research is attributed to a batch identity, not blindly to the seat', async () => {
    const taskId = `qa1-batch-${randomUUID().slice(0, 8)}`;
    const website = websiteFor('acme-batch-prov');
    const batch = await runTool('saveResearchedLeadsBatch', { leads: [leadPayload({ website })] }, 'apex-lead-research-001', taskId);
    expect(Number(batch.saved)).toBe(1);

    const [row] = await db.select().from(researchedLeads).where(eq(researchedLeads.website, website)).limit(1);
    if (row?.id) createdLeadIds.push(String(row.id));
    const pipelineMeta = (row?.pipelineMetadata ?? {}) as Record<string, unknown>;
    const recordedTaskRef = (row as { taskRef?: unknown })?.taskRef ?? pipelineMeta.taskRef;
    expect(String(recordedTaskRef ?? '')).toContain('agent_research_batch');
    expect(String(row?.researchedByAgentId)).toBe('apex-lead-research-001');
  });

  it('AC5 no delete-lead surface exists: DELETE /api/leads/:id is not a route', async () => {
    const leadId = createdLeadIds[0] ?? randomUUID();
    const response = await fetch(`${base}/api/leads/${leadId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    // 404 (no route) or 405 (method not allowed) — either proves the platform
    // exposes no delete API, which is what AC5 requires the docs to say.
    expect([404, 405]).toContain(response.status);
  });

  it('fail-closed: the sanctioned write path is admin-only', async () => {
    const website = websiteFor('acme-auth');
    const noToken = await post('/import-enrichment', { leads: [leadPayload({ website })] }, '');
    expect([401, 403]).toContain(noToken.status);

    const badToken = await post('/import-enrichment', { leads: [leadPayload({ website })] }, 'not-the-test-token');
    expect([401, 403]).toContain(badToken.status);

    const rows = await db.select().from(researchedLeads).where(eq(researchedLeads.website, website));
    expect(rows.length, 'an unauthenticated write must not land a row').toBe(0);
  });

  it('fail-closed: a saved lead leaves an outbound footprint of zero', async () => {
    const website = websiteFor('acme-footprint');
    const saved = await runTool('saveResearchedLead', leadPayload({ website }), 'apex-lead-research-001', 'task-producer-1');
    const leadId = String(saved.leadId);
    createdLeadIds.push(leadId);

    const [sends] = await db.select({ count: sql<number>`count(*)::int` }).from(emailSends).where(eq(emailSends.leadId, leadId));
    expect(Number(sends?.count ?? 0)).toBe(0);

    const row = await readRow(leadId);
    // Saving is discovery, not qualification and not consent: the row must not
    // arrive pre-qualified or pre-armed for sending.
    expect(String(row?.status)).toBe('new');
    expect(row?.qualifiedAt ?? null).toBeNull();

    const listed = await runTool('listResearchedLeads', { ids: [leadId], limit: 5 }, 'apex-lead-research-001');
    const rows = Array.isArray(listed) ? (listed as Array<Record<string, unknown>>) : [];
    expect(rows.map((l) => l.id)).toContain(leadId);
  });
});
