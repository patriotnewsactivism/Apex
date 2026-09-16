/** Deterministic Phase-1 guard: artifact store + artifacts table + tools.
 *
 * Static by design (no bucket, no credentials, no DB): asserts the storage
 * client wiring and the tool/table surface exist and stay wired, so CI can
 * catch a refactor that silently unplugs the durable artifact path.
 *
 * Usage: pnpm --filter @workspace/core exec tsx scripts/verify-artifact-store.ts
 */
import {
  ArtifactStore,
  artifactBucketName,
  isArtifactStoreConfigured,
  objectNameFor,
  sha256Hex,
  computeDirectoryChecksums,
} from '../packages/core/src/index.js';
import { artifacts } from '../lib/db/src/schema.js';
import { getToolRegistry } from '../packages/core/src/tool-registry-with-base44.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label} ${detail !== undefined ? JSON.stringify(detail) : ''}`);
  if (!ok) failures++;
};

async function main() {
  console.log('── ArtifactStore surface ──');
  check('ArtifactStore is a class', typeof ArtifactStore === 'function');
  const store = new ArtifactStore('verify-bucket-name');
  check('upload is a function', typeof store.upload === 'function');
  check('download is a function', typeof store.download === 'function');
  check('list is a function', typeof store.list === 'function');
  check('makePublic is a function', typeof store.makePublic === 'function');
  check('signedUrl is a function', typeof store.signedUrl === 'function');
  check('ping is a function', typeof store.ping === 'function');
  check('bucket env helper exists', typeof artifactBucketName === 'function');
  check('configured helper exists', typeof isArtifactStoreConfigured === 'function');

  console.log('\n── Object naming / checksum helpers ──');
  const objectName = objectNameFor('p1', 't1', 'report.md');
  check('object names are projects/<project>/<task>/<file>', objectName === 'projects/p1/t1/report.md', objectName);
  check('sha256Hex(empty) is the known empty hash', sha256Hex(Buffer.alloc(0)) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  check('computeDirectoryChecksums is exported (workspace-sync round-trip)', typeof computeDirectoryChecksums === 'function');

  console.log('\n── artifacts table schema ──');
  check('artifacts table has objectName', 'objectName' in artifacts);
  check('artifacts table has sha256', 'sha256' in artifacts);
  check('artifacts table has publicUrl', 'publicUrl' in artifacts);
  check('artifacts table has kind', 'kind' in artifacts);

  console.log('\n── tools registered in the singleton registry ──');
  const registry = getToolRegistry(process.cwd());
  for (const toolName of ['store_artifact', 'read_artifact', 'list_artifacts', 'publish_artifact']) {
    const tool = registry.get(toolName);
    check(`${toolName} registered`, Boolean(tool), tool ? undefined : 'missing');
    if (tool) {
      check(`${toolName} requiresApproval flag present`, typeof tool.requiresApproval === 'boolean');
    }
  }
  check('publish_artifact is gated (autonomy-eligible, not auto)', registry.get('publish_artifact')?.requiresApproval === true);
  check('store_artifact is auto-approved', registry.get('store_artifact')?.requiresApproval === false);

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});