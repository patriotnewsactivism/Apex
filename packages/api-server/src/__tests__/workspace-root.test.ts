import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToolRegistry } from '../../../core/src/tool-registry.js';
import { getWorkspaceRoot, resolveInWorkspace } from '../../../core/src/workspace-root.js';
import type { ToolContext } from '../../../core/src/types.js';

describe('canonical agent workspace root', () => {
  let root: string;
  let packageRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'apex-workspace-root-'));
    packageRoot = join(root, 'packages', 'api-server');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"workspace"}');
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: [packages/*]');
    vi.stubEnv('WORKSPACE_ROOT', root);
    vi.stubEnv('APEX_CANONICAL_REPO_ROOT', '');
    vi.stubEnv('APEX_ARTIFACT_DIR', '');
    vi.spyOn(process, 'cwd').mockReturnValue(packageRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-evil`, { recursive: true, force: true });
  });

  function context(agentId: string): ToolContext {
    return {
      agentId,
      workspaceRoot: getWorkspaceRoot(),
      requestApproval: async () => false,
    };
  }

  async function execute(name: string, args: unknown, ctx = context('agent-a')) {
    const tool = getToolRegistry().get(name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(args, ctx);
  }

  it('uses one root across a no-argument registry and multiple agent contexts', async () => {
    const registry = getToolRegistry();
    expect(getToolRegistry(packageRoot)).toBe(registry);
    expect(getWorkspaceRoot()).toBe(root);

    const written = await execute(
      'writeFile',
      { path: 'research/a.md', content: 'shared result' },
      context('writer'),
    ) as { path: string; written: boolean; durable: boolean };
    expect(written).toEqual({
      path: join(root, 'research', 'a.md'),
      written: true,
      durable: false,
    });

    const read = await execute(
      'readFile',
      { path: 'research/a.md' },
      context('reader'),
    ) as { path: string; content: string };
    expect(read).toEqual({
      path: join(root, 'research', 'a.md'),
      content: 'shared result',
    });

    const listed = await execute(
      'listDir',
      { path: 'research' },
      context('lister'),
    ) as { path: string; entries: Array<{ name: string; type: string }> };
    expect(listed.path).toBe(join(root, 'research'));
    expect(listed.entries).toContainEqual({ name: 'a.md', type: 'file' });
  });

  it('rejects prefix and parent escapes while mapping the workspace alias', async () => {
    const evilRoot = `${root}-evil`;
    await mkdir(evilRoot);
    await writeFile(join(evilRoot, 'secret.txt'), 'secret');

    expect(() => resolveInWorkspace(root, join(evilRoot, 'secret.txt')))
      .toThrow(/Path outside workspace/);
    await expect(execute('readFile', { path: join(evilRoot, 'secret.txt') }))
      .rejects.toThrow(/Path outside workspace/);
    await expect(execute('writeFile', { path: '../escape.md', content: 'no' }))
      .rejects.toThrow(/Path outside workspace/);

    const result = await execute('writeFile', {
      path: '/workspace/research/aliased.md',
      content: 'inside',
    }) as { path: string };
    expect(result.path).toBe(join(root, 'research', 'aliased.md'));
    expect(await readFile(join(root, 'research', 'aliased.md'), 'utf8')).toBe('inside');
  });

  it('marks writes durable only beneath APEX_ARTIFACT_DIR', async () => {
    vi.stubEnv('APEX_ARTIFACT_DIR', join(root, 'artifacts'));
    const durable = await execute('writeFile', {
      path: 'artifacts/report.md',
      content: 'kept',
    }) as { durable: boolean };
    const ephemeral = await execute('writeFile', {
      path: 'research/report.md',
      content: 'temporary',
    }) as { durable: boolean };
    expect(durable.durable).toBe(true);
    expect(ephemeral.durable).toBe(false);
  });

  it('reports relative files deleted during sandbox cleanup', async () => {
    const result = await execute('runInSandbox', {
      language: 'shell',
      code: 'mkdir -p leads && printf generated > leads/probe.txt && printf %s "$WORKSPACE_ROOT"',
    }) as {
      success: boolean;
      stdout: string;
      discardedFiles: string[];
      warning?: string;
    };

    expect(result.success).toBe(true);
    expect(result.stdout).toBe(root);
    expect(result.discardedFiles).toEqual([join('leads', 'probe.txt')]);
    expect(result.warning).toMatch(/Deleted 1 file/);
  });
});
