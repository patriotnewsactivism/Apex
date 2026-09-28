// Executable acceptance checks for the sanctioned lead-status transition path.
//
// Run: node packages/core/node_modules/tsx/dist/cli.mjs \
//        packages/api-server/scripts/verify-lead-status-transition.ts
//
// Proves AC2/AC4 for this change: PATCH /api/leads/:id with status=qualified
// persists, listResearchedLeads(status=qualified) returns the updated row, an
// invalid status is refused without touching the row, and the transition leaves
// zero outbound footprint.
//
// The HTTP surface is a local express app wired exactly like src/index.ts
// (requireAdminAuth in front of every /api route) on an ephemeral port, so the
// transition is proven under the real auth posture. No provider call, no
// campaign, no email, no consent record is created anywhere: a status change is
// metadata only, and the script asserts that.
//
// Requires DATABASE_URL. Rows it creates are synthetic, tagged with
// example.com domains, and deleted in a finally block.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { eq, inArray, sql } from 'drizzle-orm';

// Fail-closed DB gate. This suite writes rows, so it must never point at a
// production database: it only runs against a local/test Postgres, identified by
// a localhost host or a *_test database name. Anything else skips (vitest) or
// aborts (verify script) rather than touching live lead data.
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
const TEST_DB_OK = isSafeTestDatabase(process.env.DATABASE_URL);

if (!TEST_DB_OK) {
  console.error(
    'REFUSED: DATABASE_URL does not look like a local/test database.\n' +
      'This script inserts and deletes researched_leads rows; point DATABASE_URL at a\n' +
      'test database (e.g. postgres://postgres:***@127.0.0.1:5433/apex_test) and re-run.',
  );
  process.exit(1);
}

// requireAdminAuth captures APEX_ADMIN_TOKEN at module load, so the test token
// has to be in place before those modules are imported.
const ADMIN_TOKEN = process.env.VERIFY_LEAD_ADMIN_TOKEN ?? 'verify-lead-status-transition-token';
process.env.APEX_ADMIN_TOKEN = ADMIN_TOKEN;

const { db, emailSends, researchedLeads } = await import('@workspace/db');
const { createBuiltinTools } = await import('@workspace/core');
const { createLeadsRouter } = await import('../src/routes/leads.js');
const { requireAdminAuth } = await import('../src/middleware/auth.js');

const tools = createBuiltinTools(process.cwd());
const callTool = async (name: string, args: Record<string, unknown>) => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} is registered`);
  return (tool as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(args, {
    agentId: 'apex-lead-research-001',
    projectId: 'verify',
  });
};

const createdIds: string[] = [];

async function seed(): Promise<string> {
  const id = randomUUID();
  createdIds.push(id);
  const slug = id.slice(0, 8);
  await db.insert(researchedLeads).values({
    id,
    companyName: `Verify Status Transition ${slug}`,
    website: `https://${slug}.example.com`,
    industry: 'hvac',
    city: 'Austin',
    decisionMakerName: 'Real Owner',
    contactEmail: `verify-${slug}@example.com`,
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

const cleanup = async () => {
  if (!createdIds.length) return;
  await db.delete(emailSends).where(inArray(emailSends.leadId, createdIds));
  await db.delete(researchedLeads).where(inArray(researchedLeads.id, createdIds));
};

let server: ReturnType<typeof createServer> | undefined;
let base = '';

try {
  const app = express();
  app.use(express.json());
  app.use('/api', requireAdminAuth);
  app.use('/api/leads', createLeadsRouter());
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const apiOrigin = `http://127.0.0.1:${addr.port}`;
  base = `${apiOrigin}/api/leads`;
  // updateLeadStatus appends /api/leads/:id itself. Supplying the route prefix
  // here produced /api/leads/api/leads/:id and a false 404 in CI.
  process.env.APEX_API_BASE_URL = apiOrigin;

  const patch = async (id: string, body: Record<string, unknown>, auth = `Bearer ${ADMIN_TOKEN}`) => {
    const res = await fetch(`${base}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  // ── AC2a: qualified persists and is returned by the read tool ──────────────
  const leadId = await seed();
  const sourceUrl = 'https://lead-evidence.example.com/about';
  const note = 'Owner named on /contact; matches ICP, after-hours gap';

  const res = await patch(leadId, { status: 'qualified', sourceUrl, note });
  assert.equal(res.status, 200, `PATCH accepted (got ${res.status}: ${JSON.stringify(res.json)})`);
  assert.equal(res.json.persistedStatus, 'qualified', 'response reports the stored status');
  assert.equal(res.json.previousStatus, 'new', 'response reports the prior status');

  const [row] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, leadId)).limit(1);
  assert.equal(row?.status, 'qualified', 'status persisted to researched_leads');
  assert.ok(row?.qualifiedAt instanceof Date, 'qualified_at stamped once on the transition');

  const listed = (await callTool('listResearchedLeads', { status: 'qualified', ids: [leadId], limit: 50 })) as Array<
    Record<string, unknown>
  >;
  assert.ok(Array.isArray(listed), 'listResearchedLeads returns rows');
  assert.ok(listed.map((l) => l.id).includes(leadId), 'qualified cohort contains the updated row');
  console.log('  ✓ AC2a  PATCH status=qualified persists; listResearchedLeads(status=qualified) returns it');

  // ── AC2b: invalid status is refused, row untouched ─────────────────────────
  const badId = await seed();
  const bad = await patch(badId, { status: 'sold', sourceUrl: 'https://x.example.com/a', note: 'invalid status probe' });
  assert.equal(bad.status, 400, 'invalid status rejected');
  assert.match(String(bad.json.error), /status must be one of/);
  const [badRow] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, badId)).limit(1);
  assert.equal(badRow?.status, 'new', 'rejected transition left the row unchanged');
  assert.equal(badRow?.qualifiedAt, null, 'no qualified_at stamped by a rejected write');
  console.log('  ✓ AC2b  invalid status -> 400, row untouched');

  // ── fail-closed: unknown id is an error, not a silent success ──────────────
  const missing = randomUUID();
  const gone = await patch(missing, { status: 'qualified', sourceUrl: 'https://x.example.com/a', note: 'no such lead' });
  assert.equal(gone.status, 404, 'unknown lead id fails closed');
  console.log('  ✓ fail-closed  unknown lead id -> 404');

  // ── unauthenticated write is refused ───────────────────────────────────────
  const noAuth = await patch(leadId, { status: 'rejected' }, 'Bearer wrong-token');
  assert.equal(noAuth.status, 401, 'route sits behind requireAdminAuth');
  const [stillQualified] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, leadId)).limit(1);
  assert.equal(stillQualified?.status, 'qualified', 'refused write changed nothing');
  console.log('  ✓ AC4  PATCH refused without the admin bearer token, row unchanged');

  // ── AC1/AC3: the tool drives the same validated path, metadata only ────────
  const toolId = await seed();
  const toolNote = 'qualified through ICP review, no outreach performed';
  const toolRes = (await callTool('updateLeadStatus', {
    leadId: toolId,
    status: 'qualified',
    sourceUrl,
    note: toolNote,
  })) as Record<string, unknown>;
  assert.equal(toolRes.updated, true, `tool reports the validated response (got ${JSON.stringify(toolRes)})`);
  assert.equal(toolRes.status, 'qualified');
  const [toolRow] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, toolId)).limit(1);
  assert.equal(toolRow?.status, 'qualified', 'tool transition persisted through the API');
  const audit = (toolRow?.pipelineMetadata as { statusAudit?: Array<Record<string, unknown>> } | null)?.statusAudit;
  assert.ok(Array.isArray(audit) && audit.length > 0, 'audit trail recorded in existing jsonb column');
  assert.equal(audit?.[audit.length - 1]?.to, 'qualified');
  assert.equal(audit?.[audit.length - 1]?.sourceUrl, sourceUrl, 'evidence URL recorded');
  assert.equal(audit?.[audit.length - 1]?.note, toolNote, 'rationale recorded');

  const [sends] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailSends)
    .where(eq(emailSends.leadId, toolId));
  assert.equal(Number(sends?.count ?? 0), 0, 'qualification sent nothing');

  const readback = (await callTool('getResearchedLeadById', { leadId: toolId })) as Record<string, unknown>;
  assert.equal((readback.lead as Record<string, unknown>).status, 'qualified');
  assert.equal((readback.outreach as Record<string, unknown>).sendCount, 0, 'outreach state is untouched');
  console.log('  ✓ AC1+AC3+AC4  updateLeadStatus -> validated API -> persisted, audited, zero outreach');

  // ── AC3: contract requires id, status, evidence URL and rationale ──────────
  const upd = tools.find((t) => t.name === 'updateLeadStatus') as unknown as {
    requiresApproval: boolean;
    schema: { safeParse: (v: unknown) => { success: boolean } };
  };
  assert.ok(upd, 'updateLeadStatus registered');
  assert.equal(
    upd.schema.safeParse({ leadId: 'x', status: 'qualified', sourceUrl, note: 'matches ICP on service line' }).success,
    true,
  );
  for (const incomplete of [
    { leadId: 'x', status: 'qualified' },
    { leadId: 'x', status: 'qualified', sourceUrl: 'https://a.example.com' },
    { status: 'qualified', sourceUrl: 'https://a.example.com', note: 'no id' },
    { leadId: 'x', status: 'invented', sourceUrl: 'https://a.example.com', note: 'bad status' },
  ]) {
    assert.equal(upd.schema.safeParse(incomplete).success, false, `rejects ${JSON.stringify(incomplete)}`);
  }
  assert.equal(upd.requiresApproval, false, 'metadata write is not approval-gated');

  const contact = tools.find((t) => t.name === 'updateLeadContactInfo') as unknown as {
    schema: { _def?: { shape?: Record<string, unknown> | (() => Record<string, unknown>) } };
  };
  const cShape = contact.schema?._def?.shape;
  const cFields = Object.keys(typeof cShape === 'function' ? cShape() : cShape ?? {});
  assert.ok(!cFields.includes('status'), 'updateLeadContactInfo must not accept a silently-ignored status');
  console.log('  ✓ AC3  tool schema requires leadId + status + sourceUrl + note; contact tool has no status');

  console.log('\nALL LEAD-STATUS TRANSITION CHECKS PASSED');
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  try {
    await cleanup();
  } catch (err) {
    console.error('CLEANUP FAILED — remove rows tagged "Verify Status Transition" manually:', err);
  }
}
