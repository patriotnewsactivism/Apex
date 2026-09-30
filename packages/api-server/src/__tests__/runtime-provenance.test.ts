import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBuildInfo } from '../../../core/src/runtime-health.js';
import { ensureRuntimeProvenance, runtimeProvenanceRequiresGate } from '../../../core/src/runtime-provenance.js';

const audit = vi.hoisted(() => ({
  values: vi.fn(),
  persist: vi.fn(),
}));
vi.mock('@workspace/db', () => ({
  auditEvents: {},
  db: {
    insert: () => ({
      values: (value: unknown) => {
        audit.values(value);
        return { onConflictDoNothing: audit.persist };
      },
    }),
  },
}));

describe('Railway runtime provenance', () => {
  let root: string;
  let task = 0;

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APEX_BUILD_SHA', 'unknown');
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', 'abc123def456');
    vi.stubEnv('APEX_CANONICAL_REPO_ROOT', '');
    vi.stubEnv('APEX_ARTIFACT_BUCKET', '');
    vi.stubEnv('DATABASE_URL', 'postgres://test-user:test-password@db.test:5432/apex');
    root = await mkdtemp(join(tmpdir(), 'apex-provenance-'));
    await writeFile(join(root, 'package.json'), '{"name":"workspace"}');
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: [packages/*]');
    await mkdir(join(root, 'packages/api-server/src'), { recursive: true });
    await writeFile(join(root, 'packages/api-server/package.json'), '{"name":"@workspace/api-server"}');
    vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'packages/api-server'));
    vi.stubEnv('APEX_ARTIFACT_DIR', join(root, 'artifacts'));
    audit.values.mockClear();
    audit.persist.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function check(tool = 'writeFile', args: Record<string, unknown> = { path: 'src/routes/leads.ts' }) {
    return ensureRuntimeProvenance(tool, args, {
      agentId: 'test-agent',
      taskId: `provenance-test-${++task}`,
      workspaceRoot: join(root, 'packages/api-server'),
      requestApproval: async () => false,
    });
  }

  it('uses the Railway commit when the image build argument is unknown', async () => {
    const result = await check();
    expect(getBuildInfo().sha).toBe('abc123def456');
    expect(result.snapshot.git_commit).toBe(getBuildInfo().sha);
    expect(result.ok, result.reasons.join('; ')).toBe(true);
    expect(result.recorded).toBe(true);
  });

  it('finds the canonical workspace when pnpm starts from the API package', async () => {
    vi.stubEnv('APEX_BUILD_SHA', 'explicit-build-sha');
    const result = await check();
    expect(result.snapshot.repo_root).toBe(root);
    expect(result.snapshot.target_workspace_root).toBe(root);
    expect(result.snapshot.resolved_workspace_package).toBe('@workspace/api-server');
    expect(result.ok, result.reasons.join('; ')).toBe(true);
  });

  it.each(['', ' ', 'unknown', ' UNKNOWN '])('ignores placeholder build identity %j', (placeholder) => {
    vi.stubEnv('APEX_BUILD_SHA', placeholder);
    expect(getBuildInfo().sha).toBe('abc123def456');
  });

  it('preserves a real explicit build SHA over Railway metadata', async () => {
    vi.stubEnv('APEX_BUILD_SHA', ' reviewed-build-sha ');
    expect(getBuildInfo().sha).toBe('reviewed-build-sha');
    expect((await check()).snapshot.git_commit).toBe('reviewed-build-sha');
  });

  it('still blocks production writes without either commit source', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '');
    const result = await check();
    expect(getBuildInfo().sha).toBe('unknown');
    expect(result.ok).toBe(false);
    expect(result.reasons.join('; ')).toMatch(/missing\/unknown in production/);
  });

  it('still requires durable artifacts', async () => {
    vi.stubEnv('APEX_ARTIFACT_DIR', '');
    expect((await check()).reasons).toContain('durable artifact root is not configured');
  });

  it('still requires a database target', async () => {
    vi.stubEnv('DATABASE_URL', '');
    expect((await check()).reasons).toContain('DATABASE_URL is not configured');
  });

  it('blocks writes when the durable audit write fails', async () => {
    audit.persist.mockRejectedValue(new Error('audit unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await check();
    expect(result.recorded).toBe(false);
    expect(result.reasons).toContain('runtime provenance could not be written to the durable audit chain');
  });

  it('keeps campaign and BuildMyBot lead reads available while unknown mutations stay gated', async () => {
    audit.persist.mockRejectedValue(new Error('audit unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runtimeProvenanceRequiresGate('campaign_snapshot')).toBe(false);
    expect(runtimeProvenanceRequiresGate('buildmybot_recent_leads')).toBe(false);
    expect(runtimeProvenanceRequiresGate('buildmybot_push_leads')).toBe(true);
    expect(runtimeProvenanceRequiresGate('new_unclassified_tool')).toBe(true);
    expect(runtimeProvenanceRequiresGate('writeFile')).toBe(true);
    const result = await check('campaign_snapshot', {});
    expect(result.recorded).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('records only the sanitized database target', async () => {
    const result = await check();
    expect(result.snapshot.database_target).toBe('postgres://db.test:5432/apex');
    expect(JSON.stringify(audit.values.mock.calls)).not.toMatch(/test-user|test-password/);
  });

  it('still rejects node_modules and paths outside the canonical tree', async () => {
    expect((await check('writeFile', { path: '../../node_modules/@workspace/core/src/index.ts' })).reasons)
      .toContain('writes into node_modules are forbidden; edit the canonical workspace package instead');
    expect((await check('writeFile', { path: join(root, '../outside.ts') })).ok).toBe(false);
  });

  it('still rejects nested workspaces and respects an explicit canonical root', async () => {
    const shadow = join(root, 'packages/api-server/shadow');
    await mkdir(shadow);
    await writeFile(join(shadow, 'package.json'), '{}');
    await writeFile(join(shadow, 'pnpm-workspace.yaml'), 'packages: []');
    vi.stubEnv('APEX_CANONICAL_REPO_ROOT', root);
    expect((await check('writeFile', { path: 'shadow/new.ts' })).reasons.join('; '))
      .toMatch(/shadow\/nested workspace/);
    vi.stubEnv('APEX_CANONICAL_REPO_ROOT', shadow);
    expect((await check()).reasons.join('; ')).toMatch(/outside canonical repo root/);
  });
});
