/**
 * Deploy CLI — the entry point CI uses.
 *
 * Deliberately thin: it does argument handling and one extra safety check, then
 * delegates to `deployToLightsail()`. The deploy logic is NOT duplicated in
 * YAML, so a human running this locally and a CI run exercise the same code
 * path, including the post-deploy /health verification.
 *
 * Usage: tsx scripts/deploy.mts <staging|production> [--expect-sha <sha>]
 */
import { pathToFileURL } from 'node:url';

import { deployToLightsail, DeployNotConfiguredError } from '../src/lightsail-deployer.ts';

export function parseArgs(argv: string[]): { environment: 'staging' | 'production'; expectSha: string | undefined } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const environment = positional[0];
  if (environment !== 'staging' && environment !== 'production') {
    throw new Error(`Usage: deploy.mts <staging|production> [--expect-sha <sha>]  (got ${environment ?? 'nothing'})`);
  }
  const i = argv.indexOf('--expect-sha');
  const expectSha = (i !== -1 ? argv[i + 1] : process.env.APEX_EXPECT_SHA) || undefined;
  return { environment, expectSha };
}

/**
 * The check that closes the stale-image hole. A deployment can report ACTIVE
 * and /health can return 200 while the container still runs an older image —
 * that exact situation burned hours on 2026-08-19. If the commit we asked to
 * build is not the commit answering /health, the deploy has NOT delivered the
 * change and must fail loudly rather than look green.
 */
export function assertRunningCommit(healthBody: string, expectSha: string | undefined, log: (m: string) => void): void {
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
    throw new Error('/health returned no build.sha. Deploy an image built from a Dockerfile that sets APEX_BUILD_SHA.');
  }
  if (running === 'unknown') {
    // Not a hard failure: the Dockerfile defaults to 'unknown' so an
    // un-updated buildspec still builds. But it means provenance is unproven.
    log('WARNING: /health reports build.sha=unknown — the CodeBuild buildspec is not passing');
    log('         --build-arg APEX_BUILD_SHA. Until it does, nothing can confirm which commit is live.');
    log('         See docs/deploy-provenance.md.');
    return;
  }
  const short = (s: string) => s.slice(0, 12);
  if (short(running) !== short(expectSha)) {
    throw new Error(
      `STALE IMAGE: expected commit ${short(expectSha)} to be live, but /health reports ${short(running)}. ` +
        `The build published an image that the service did not pull — commonly a cached ':latest' digest. ` +
        `Force a genuinely new container spec, or deploy an immutable ':<sha>' tag (docs/deploy-provenance.md).`,
    );
  }
  log(`Provenance verified: live commit ${short(running)} matches the deployed commit.`);
}

async function main(): Promise<void> {
  const { environment, expectSha } = parseArgs(process.argv.slice(2));
  const log = (m: string) => console.log(`[deploy] ${m}`);
  try {
    const result = await deployToLightsail(environment, log, expectSha);
    assertRunningCommit(result.healthBody, expectSha, log);
    log(`Done. build=${result.buildId} deployment=v${result.deploymentVersion} (${result.deploymentState}) health=${result.healthStatus}`);
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

// Only deploy when run as a script — importing this file (e.g. from tests)
// must never trigger a deployment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
