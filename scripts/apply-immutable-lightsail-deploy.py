from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}\n--- needle ---\n{old}")
    p.write_text(text.replace(old, new, 1))


lightsail = "packages/cicd-automation/src/lightsail-deployer.ts"

replace_once(
    lightsail,
    """/** Step 1-2: build the image and wait for the real terminal status. */
async function runCodeBuild(log: DeployLogger): Promise<{ buildId: string; buildStatus: string }> {
  const client = await codebuildClient();
  const { StartBuildCommand, BatchGetBuildsCommand } = await import('@aws-sdk/client-codebuild');

  const started = await client.send(new StartBuildCommand({ projectName: CODEBUILD_PROJECT }));""",
    """export function immutableImageRef(image: string, sourceSha: string): string {
  const sha = sourceSha.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new Error(`Cannot create immutable image tag from invalid source SHA: ${sourceSha}`);
  }
  const tag = sha.slice(0, 12);
  const withoutDigest = image.replace(/@sha256:[0-9a-f]+$/i, '');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  if (lastColon > lastSlash) return `${withoutDigest.slice(0, lastColon)}:${tag}`;
  return `${withoutDigest}:${tag}`;
}

/** Step 1-2: build the exact requested source and wait for the real terminal status. */
async function runCodeBuild(
  log: DeployLogger,
  expectedSha?: string,
): Promise<{ buildId: string; buildStatus: string; resolvedSourceVersion: string }> {
  const client = await codebuildClient();
  const { StartBuildCommand, BatchGetBuildsCommand } = await import('@aws-sdk/client-codebuild');

  const started = await client.send(
    new StartBuildCommand({
      projectName: CODEBUILD_PROJECT,
      sourceVersion: expectedSha,
    }),
  );""",
)

replace_once(
    lightsail,
    """    const { builds } = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const status = builds?.[0]?.buildStatus ?? 'UNKNOWN';
    if (status !== 'IN_PROGRESS') {
      log(`CodeBuild ${buildId} finished: ${status}`);
      if (status !== 'SUCCEEDED') {
        const phase = builds?.[0]?.currentPhase ?? 'unknown phase';
        throw new Error(
          `CodeBuild ${buildId} ended ${status} during ${phase} — image not published, ` +
            `so nothing was deployed. Check the build log in the AWS console.`,
        );
      }
      return { buildId, buildStatus: status };
    }""",
    """    const { builds } = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = builds?.[0];
    const status = build?.buildStatus ?? 'UNKNOWN';
    if (status !== 'IN_PROGRESS') {
      log(`CodeBuild ${buildId} finished: ${status}`);
      if (status !== 'SUCCEEDED') {
        const phase = build?.currentPhase ?? 'unknown phase';
        throw new Error(
          `CodeBuild ${buildId} ended ${status} during ${phase} — image not published, ` +
            `so nothing was deployed. Check the build log in the AWS console.`,
        );
      }
      const resolvedSourceVersion = build?.resolvedSourceVersion;
      if (!resolvedSourceVersion) {
        throw new Error(
          `CodeBuild ${buildId} succeeded but returned no resolvedSourceVersion; ` +
            `cannot select the immutable image tag safely.`,
        );
      }
      if (
        expectedSha &&
        resolvedSourceVersion.slice(0, 12) !== expectedSha.slice(0, 12)
      ) {
        throw new Error(
          `CodeBuild built ${resolvedSourceVersion.slice(0, 12)}, not requested ` +
            `${expectedSha.slice(0, 12)}; refusing to deploy the wrong image.`,
        );
      }
      return { buildId, buildStatus: status, resolvedSourceVersion };
    }""",
)

replace_once(
    lightsail,
    """/** Step 3-4: redeploy the service with its existing spec, then wait for it. */
async function redeployService(log: DeployLogger): Promise<{ version: number; state: string }> {""",
    """/** Step 3-4: redeploy the service with the freshly built immutable image tag. */
async function redeployService(
  log: DeployLogger,
  sourceSha: string,
): Promise<{ version: number; state: string }> {""",
)

replace_once(
    lightsail,
    """  const previousVersion = latest.version;
  log(`Reusing deployment spec from version ${previousVersion} (containers: ${Object.keys(latest.containers).join(', ')})`);

  await client.send(
    new CreateContainerServiceDeploymentCommand({
      serviceName: LIGHTSAIL_SERVICE,
      containers: latest.containers,""",
    """  const previousVersion = latest.version;
  const containerNames = Object.keys(latest.containers);
  const targetContainerName =
    latest.publicEndpoint?.containerName ??
    (containerNames.length === 1 ? containerNames[0] : undefined);
  if (!targetContainerName || !latest.containers[targetContainerName]?.image) {
    throw new Error(
      `Could not identify the application container image in deployment v${previousVersion}; ` +
        `refusing to guess which container should receive the immutable build tag.`,
    );
  }

  const containers = {
    ...latest.containers,
    [targetContainerName]: {
      ...latest.containers[targetContainerName],
      image: immutableImageRef(latest.containers[targetContainerName]!.image!, sourceSha),
    },
  };
  log(
    `Reusing deployment spec from version ${previousVersion} while pinning ` +
      `${targetContainerName} to ${containers[targetContainerName]!.image}`,
  );

  await client.send(
    new CreateContainerServiceDeploymentCommand({
      serviceName: LIGHTSAIL_SERVICE,
      containers,""",
)

replace_once(
    lightsail,
    """export async function deployToLightsail(
  environment: 'staging' | 'production',
  log: DeployLogger = (m) => console.log(`[deploy] ${m}`),
): Promise<LightsailDeployResult> {
  assertConfigured(environment);
  log(`Deploying ${environment} — CodeBuild ${CODEBUILD_PROJECT} → Lightsail ${LIGHTSAIL_SERVICE} (${DEFAULT_REGION})`);

  const { buildId, buildStatus } = await runCodeBuild(log);
  const { version, state } = await redeployService(log);""",
    """export async function deployToLightsail(
  environment: 'staging' | 'production',
  log: DeployLogger = (m) => console.log(`[deploy] ${m}`),
  expectedSha?: string,
): Promise<LightsailDeployResult> {
  assertConfigured(environment);
  log(`Deploying ${environment} — CodeBuild ${CODEBUILD_PROJECT} → Lightsail ${LIGHTSAIL_SERVICE} (${DEFAULT_REGION})`);

  const { buildId, buildStatus, resolvedSourceVersion } = await runCodeBuild(log, expectedSha);
  const { version, state } = await redeployService(log, resolvedSourceVersion);""",
)

# Keep the module-level architecture note accurate.
replace_once(
    lightsail,
    """//      `lightsail:CreateContainerServiceDeployment`. The spec is reused
//      as-is — same containers, same env, same ports — because the image tag
//      is `:latest` and the point is to pull the freshly built image, not to
//      change configuration. Anything this code doesn't understand about the
//      running spec is preserved rather than dropped.""",
    """//      `lightsail:CreateContainerServiceDeployment`. The current spec is
//      preserved, but the application container is pinned to the immutable
//      `:<sha>` tag produced by CodeBuild so Lightsail cannot reuse a cached
//      mutable `:latest` digest. Other env, ports, and sidecars are preserved.""",
)

deploy_cli = "packages/cicd-automation/scripts/deploy.mts"
replace_once(
    deploy_cli,
    "const result = await deployToLightsail(environment, log);",
    "const result = await deployToLightsail(environment, log, expectSha);",
)

verify = "scripts/verify-deploy-provenance.ts"
replace_once(
    verify,
    """  MAX_HEALTH_BODY_CHARS,
  retainHealthResponseBody,
} from '../packages/cicd-automation/src/lightsail-deployer.js';""",
    """  MAX_HEALTH_BODY_CHARS,
  immutableImageRef,
  retainHealthResponseBody,
} from '../packages/cicd-automation/src/lightsail-deployer.js';""",
)
replace_once(
    verify,
    """check('expanded health response preserves the expected live commit', runningSha === expectedSha);

let oversizedRejected = false;""",
    """check('expanded health response preserves the expected live commit', runningSha === expectedSha);
check(
  'mutable latest image is rewritten to the immutable short SHA tag',
  immutableImageRef('535203103662.dkr.ecr.us-east-1.amazonaws.com/apex:latest', expectedSha) ===
    '535203103662.dkr.ecr.us-east-1.amazonaws.com/apex:289c8ce52d2d',
);
check(
  'digest image is rewritten to the immutable short SHA tag',
  immutableImageRef(
    '535203103662.dkr.ecr.us-east-1.amazonaws.com/apex@sha256:' + 'a'.repeat(64),
    expectedSha,
  ) === '535203103662.dkr.ecr.us-east-1.amazonaws.com/apex:289c8ce52d2d',
);
check(
  'untagged image receives the immutable short SHA tag',
  immutableImageRef('example/apex', expectedSha) === 'example/apex:289c8ce52d2d',
);

let invalidShaRejected = false;
try {
  immutableImageRef('example/apex:latest', 'not-a-sha');
} catch {
  invalidShaRejected = true;
}
check('invalid immutable image SHA is rejected', invalidShaRejected);

let oversizedRejected = false;""",
)

# The script is one-use; the workflow remains for connector cleanup after it runs.
Path("scripts/apply-immutable-lightsail-deploy.py").unlink()
