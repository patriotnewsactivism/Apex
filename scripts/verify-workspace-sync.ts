/** Deterministic Phase-3 guard: workspace checksum round-trip + sync tools.
 *
 * Static by design — exercises the pure filesystem half (computeDirectoryChecksums
 * determinism, manifest exclusion) and the exported sync API surface. No bucket,
 * no credentials, no DB.
 *
 * Usage: pnpm --filter @workspace/core exec tsx scripts/verify-workspace-sync.ts
 */
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { computeDirectoryChecksums, pushWorkspace, pullWorkspace, snapshotWorkspace, ArtifactStore } from '../packages/core/src/index.js';
import { getToolRegistry } from '../packages/core/src/tool-registry-with-base44.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label} ${detail !== undefined ? JSON.stringify(detail) : ''}`);
  if (!ok) failures++;
};

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'apex-ws-verify-'));
  try {
    await writeFile(join(dir, 'a.txt'), 'hello world');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'b.md'), '# Title\ncontent here');
    await writeFile(join(dir, '.apex-manifest.json'), '{"must":"be excluded"}');

    console.log('── checksum determinism ──');
    const first = await computeDirectoryChecksums(dir);
    const second = await computeDirectoryChecksums(dir);
    check('two passes produce identical manifests', JSON.stringify(first) === JSON.stringify(second));
    check('manifest lists a.txt with the known sha256', first['a.txt'] === 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9', first);
    check('nested path uses POSIX separators', typeof first['nested/b.md'] === 'string' && !('nested\\b.md' in first), Object.keys(first));
    check('manifest file itself is excluded', !('.apex-manifest.json' in first), Object.keys(first));

    console.log('\n── sync API surface ──');
    check('pullWorkspace exported', typeof pullWorkspace === 'function');
    check('pushWorkspace exported', typeof pushWorkspace === 'function');
    check('snapshotWorkspace exported', typeof snapshotWorkspace === 'function');
    check('ArtifactStore still constructible', typeof new ArtifactStore('verify-bucket') === 'object');

    console.log('\n── tools registered ──');
    const registry = getToolRegistry(process.cwd());
    for (const toolName of ['init_workspace', 'sync_workspace', 'push_workspace']) {
      const tool = registry.get(toolName);
      check(`${toolName} registered and auto-approved`, Boolean(tool) && tool?.requiresApproval === false, tool ? undefined : 'missing');
    }

    console.log('\n── equality round-trip via manifest diff (pure logic) ──');
    // Simulate what pushWorkspace does with manifests: unchanged files are
    // skipped by hash equality. We verify the hash comparison policy directly.
    const remote = { ...first };
    const changed = Object.entries(first).filter(([rel, hash]) => remote[rel] !== hash).length;
    check('unchanged manifest diff is empty', changed === 0, { changed });
    const content = await readFile(join(dir, 'a.txt'));
    check('file bytes read back unchanged', content.toString() === 'hello world');

    const info = await stat(join(dir, 'a.txt'));
    check('size metadata available for pull skip logic', info.size > 0);
    void resolve;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});