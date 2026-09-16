/**
 * APEX Deploy CLI — build and update the existing Google Cloud Run service.
 *
 * Usage: tsx scripts/deploy.mts <staging|production> [--expect-sha <sha>]
 *
 * The underlying deployer refuses to create a new service. It requires the
 * exact existing project/region/service identifiers and an authenticated
 * gcloud environment, builds a clean Git commit through Cloud Build with an
 * immutable SHA tag, updates only the existing service image, waits for Ready,
 * and then verifies /health.
 */
import { pathToFileURL } from 'node:url';

import { deployToCloudRun, DeployNotConfiguredError } from '../src/cloud-run-deployer.ts';

export function parseArgs(argv: string[]): { environment: 'staging' | 'production'; expectSha: string | undefined } {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const environment = positional[0];
  if (environment !== 'staging' && environment !== 'production') {
    throw new Error(`Usage: deploy.mts <staging|production> [--expect-sha <sha>]  (got ${environment ?? 'nothing'})`);
  }
  const i = argv.indexOf('--expect-sha');
  const expectSha = (i !== -1 ? argv[i + 1] : process.env.APEX_EXPECT_SHA) || undefined;
  return { environment, expectSha };
}

/** A Ready Cloud Run revision is not sufficient evidence: verify that the
 * exact reviewed commit is what answers the production health endpoint. */
export function assertRunningCommit(healthBody: string, expectSha: string | undefined, log: (message: string) => void): void {
  if (!expectSha) {
    log('No expected SHA supplied — skipping provenance check.');
    return;
  }
  let running: unknown;
  try {
    running = (JSON.parse(healthBody) as { build?: { sha?: unknown } }).build?.sha;
  } catch {
    throw new Error(`/health did not return JSON, cannot verify which commit is live. Body: ${healthBody.slice(0, 400)}`);
  }
  if (typeof running !== 'string' || running === '') {
    throw new Error('/health returned no build.sha. The production image must be built with APEX_BUILD_SHA.');
  }
  if (running === 'unknown') {
    throw new Error(
      '/health reports build.sha=unknown. Cloud Build must use cloudbuild.apex.yaml so the exact Git SHA is baked into the image.',
    );
  }
  const short = (sha: string) => sha.slice(0, 12);
  if (short(running) !== short(expectSha)) {
    throw new Error(
      `STALE IMAGE: expected commit ${short(expectSha)} to be live, but /health reports ${short(running)}. ` +
        `The Cloud Run release is not the requested image; do not report success.`,
    );
  }
  log(`Provenance verified: live commit ${short(running)} matches the deployed commit.`);
}

async function main(): Promise<void> {
  const { environment, expectSha } = parseArgs(process.argv.slice(2));
  const log = (message: string) => console.log(`[deploy] ${message}`);
  try {
    const result = await deployToCloudRun(environment, log, expectSha);
    assertRunningCommit(result.healthBody, expectSha, log);
    log(
      `Done. build=${result.buildId} revision=${result.revisionName} ` +
        `(${result.deploymentState}) health=${result.healthStatus}`,
    );
    log(`Image: ${result.image}`);
    log(`Service: ${result.serviceUrl}`);
  } catch (err) {
    if (err instanceof DeployNotConfiguredError) {
      console.error(`[deploy] Refusing to deploy: ${err.message}`);
      process.exit(2);
    }
    console.error(`[deploy] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
