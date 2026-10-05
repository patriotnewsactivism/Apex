// ─── schedule_task payload contract — Vitest regression suite ───────────────
//
// Regression for the P2 defect where a 15-minute `delegation_followup` create
// was rejected with:
//   Invalid args for schedule_task: [{code: invalid_type, expected: object,
//   received: string, path: [payload], message: Expected object, received string}]
//
// The tool schema (packages/core/src/tool-registry.ts line 2909) already
// enforces `payload: z.record(z.any()).optional()` — an object/record is the
// canonical contract. The server routes (POST /api/jobs, PATCH /api/jobs/:id)
// previously accepted `payload` with no validation, so a string could bypass
// the tool layer and land in the jsonb column typed `Record<string, unknown>`,
// breaking every handler that reads `job.payload` as a record.
//
// These tests pin the server-side reconciliation: a valid object payload is
// accepted, and a string payload is rejected with a 400 — matching the tool
// schema so both layers agree on one contract.
//
// Run with: pnpm --filter @workspace/api-server test

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateJobPayload } from '../routes/jobs';

// ─── Mock @workspace/db ──────────────────────────────────────────────────────
// The jobs router imports `db`, `scheduledJobs`, `jobExecutionLog` from
// @workspace/db and `CronParser` from @workspace/background-jobs. We mock the
// db module so no real database connection is opened during the unit test.
vi.mock('@workspace/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  scheduledJobs: {},
  jobExecutionLog: {},
}));

vi.mock('@workspace/background-jobs', () => ({
  CronParser: {
    validate: () => null,
    nextRun: () => new Date(),
  },
}));

import { createJobsRouter } from '../routes/jobs';
import { db } from '@workspace/db';

function makeReq(body: Record<string, unknown>) {
  return { body, params: {}, query: {} } as any;
}
function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: unknown) => {
    res.body = data;
    return res;
  };
  return res;
}

describe('validateJobPayload — canonical object/record contract', () => {
  it('accepts a valid object payload', () => {
    expect(validateJobPayload({ maxPerRun: 8, focus: 'unblock' })).toBeNull();
    expect(validateJobPayload({})).toBeNull();
  });

  it('accepts undefined/null payload (absent)', () => {
    expect(validateJobPayload(undefined)).toBeNull();
    expect(validateJobPayload(null)).toBeNull();
  });

  it('rejects a string payload (the P2 defect)', () => {
    const err = validateJobPayload('some-string-payload');
    expect(err).toContain('payload must be an object/record');
  });

  it('rejects an array payload', () => {
    const err = validateJobPayload(['a', 'b']);
    expect(err).toContain('payload must be an object/record');
  });
});

describe('POST /api/jobs — payload validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a job with a valid object payload', async () => {
    const router = createJobsRouter();
    const req = makeReq({
      name: 'disposable-test-job',
      jobType: 'delegation_followup',
      payload: { maxPerRun: 1 },
    });
    const res = makeRes();

    // Simulate a successful insert + select returning the created row.
    (db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'job-1', name: 'disposable-test-job' }]) }),
      }),
    });

    // Find the POST '/' handler and invoke it.
    const postHandler = (router as any).stack.find((l: any) => l.route?.methods?.post && l.route.path === '/')?.route?.stack[0]?.handle;
    await postHandler(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBe('job-1');
  });

  it('rejects a string payload with 400', async () => {
    const router = createJobsRouter();
    const req = makeReq({
      name: 'bad-job',
      jobType: 'delegation_followup',
      payload: 'not-an-object',
    });
    const res = makeRes();

    const postHandler = (router as any).stack.find((l: any) => l.route?.methods?.post && l.route.path === '/')?.route?.stack[0]?.handle;
    await postHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('payload must be an object/record');
    // No insert should have been attempted.
    expect(db.insert).not.toHaveBeenCalled();
  });
});
