// ─── LightsailDeployer — the real Apex self-deploy path ──────────────────────
//
// Added 2026-08-19. Until now Apex had NO working self-deploy: the old
// DeploymentManager returned a fabricated `status: 'healthy'` and a fake
// `apex.vercel.app` URL without calling any platform API, and after that was
// made honest it simply threw. This module implements the runbook from
// AGENTS.md for real, end to end:
//
//   1. `codebuild:StartBuild` on project `apex-lightsail-build` (builds the
//      image from GitHub `main` and pushes it to ECR).
//   2. Poll `codebuild:BatchGetBuilds` until the build leaves IN_PROGRESS.
//      A bare CodeBuild success does NOT redeploy the running service, so:
//   3. Read the CURRENT deployment spec via
//      `lightsail:GetContainerServiceDeployments` and resubmit it via
//      `lightsail:CreateContainerServiceDeployment`. The spec is reused
//      as-is — same containers, same env, same ports — because the image tag
//      is `:latest` and the point is to pull the freshly built image, not to
//      change configuration. Anything this code doesn't understand about the
//      running spec is preserved rather than dropped.
//   4. Poll `lightsail:GetContainerServiceDeployments` until the newest
//      deployment leaves ACTIVATING.
//   5. Prove it with the service's real health endpoint, not just deployment
//      state — an ACTIVE deployment of a container that boots and then fails
//      its own health checks is exactly the case a state check misses.
//
// DESIGN RULES, all learned from what went wrong before:
//   * Never report success that wasn't verified. Every failure path throws
//     with what actually happened; the DB row records the true status.
//   * No fabricated URLs. The service URL is read from the Lightsail API.
//   * Credentials are never read from this repo. The AWS SDK's default
//     provider chain (env vars / instance role) supplies them, and their
//     absence is reported as a clear, actionable error instead of a stack
//     trace 40 frames deep.
//   * Deploys are opt-in per environment via APEX_DEPLOY_ENABLED. An agent
//     that discovers this tool cannot ship to production just because AWS
//     credentials happen to exist in the process.
//
// IAM note: this needs `codebuild:StartBuild`, `codebuild:BatchGetBuilds`,
// `lightsail:GetContainerServices`, `lightsail:GetContainerServiceDeployments`
// and `lightsail:CreateContainerServiceDeployment` — nothing else. Give it a
// dedicated IAM user/role with exactly those five actions. Do NOT run Apex on
// AWS root-account credentials: root cannot be scoped down or cleanly
// rotated, and this process hands tools to 13 autonomous agents.

const DEFAULT_REGION = process.env.AWS_REGION ?? 'us-east-1';
const CODEBUILD_PROJECT = process.env.APEX_CODEBUILD_PROJECT ?? 'apex-lightsail-build';
const LIGHTSAIL_SERVICE = process.env.APEX_LIGHTSAIL_SERVICE ?? 'apex-service';

/** Hard ceilings so a stuck build or activation can never hang an agent loop
 *  forever (the agent is an always-on process; a wedged await is a dead
 *  worker, not a slow one). */
const BUILD_TIMEOUT_MS = Number(process.env.APEX_DEPLOY_BUILD_TIMEOUT_MS ?? 20 * 60_000);
const ACTIVATION_TIMEOUT_MS = Number(process.env.APEX_DEPLOY_ACTIVATION_TIMEOUT_MS ?? 15 * 60_000);
const POLL_INTERVAL_MS = Number(process.env.APEX_DEPLOY_POLL_INTERVAL_MS ?? 15_000);
const HEALTH_TIMEOUT_MS = 20_000;
export const MAX_HEALTH_BODY_CHARS = 64_000;

export interface LightsailDeployResult {
  buildId: string;
  buildStatus: string;
  deploymentVersion: number;
  deploymentState: string;
  serviceUrl: string;
  healthStatus: number;
  healthBody: string;
}

export interface DeployLogger {
  (message: string): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keep the complete, bounded health response for provenance parsing. The
 * response used to be sliced to 500 characters before JSON.parse; once health
 * gained legitimate fields, that converted valid JSON into a truncated string
 * and falsely marked an ACTIVE, healthy deployment failed. */
export function retainHealthResponseBody(body: string): string {
  if (body.length > MAX_HEALTH_BODY_CHARS) {
    throw new Error(
      `/health response exceeded ${MAX_HEALTH_BODY_CHARS} characters; refusing to retain an unbounded body.`,
    );
  }
  return body;
}

/** True when deploys are explicitly enabled for this environment. */
export function isDeployEnabled(environment: 'staging' | 'production'): boolean {
  const raw = (process.env.APEX_DEPLOY_ENABLED ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'true' || raw === '1' || raw === 'all') return true;
  return raw.split(',').map((s) => s.trim()).includes(environment);
}

export class DeployNotConfiguredError extends Error {}

/** Fail before touching AWS if the obvious prerequisites are missing, so the
 *  error names the fix instead of surfacing as an SDK credential exception. */
function assertConfigured(environment: 'staging' | 'production'): void {
  if (!isDeployEnabled(environment)) {
    throw new DeployNotConfiguredError(
      `Deploys to ${environment} are disabled. Set APEX_DEPLOY_ENABLED=${environment} ` +
        `(or "all") on the running service to allow it. This is deliberately ` +
        `opt-in: AWS credentials being present is not consent to ship.`,
    );
  }
  const hasStaticKeys = !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;
  const hasRole = !!process.env.AWS_WEB_IDENTITY_TOKEN_FILE || !!process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (!hasStaticKeys && !hasRole) {
    throw new DeployNotConfiguredError(
      'No AWS credentials available to this process (checked AWS_ACCESS_KEY_ID/' +
        'AWS_SECRET_ACCESS_KEY and the container/web-identity role vars). Attach a ' +
        'dedicated IAM identity with only codebuild:StartBuild, ' +
        'codebuild:BatchGetBuilds, lightsail:GetContainerServices, ' +
        'lightsail:GetContainerServiceDeployments and ' +
        'lightsail:CreateContainerServiceDeployment. Do not use root credentials.',
    );
  }
}

// AWS SDK clients are imported lazily: the deps are optional in practice
// (nothing else in Apex needs them), and a missing package must produce a
// readable message rather than crashing api-server at import time.
async function codebuildClient() {
  try {
    const { CodeBuildClient } = await import('@aws-sdk/client-codebuild');
    return new CodeBuildClient({ region: DEFAULT_REGION });
  } catch (err) {
    throw new DeployNotConfiguredError(
      `@aws-sdk/client-codebuild is not installed — run \`pnpm install\`. (${String(err)})`,
    );
  }
}

async function lightsailClient() {
  try {
    const { LightsailClient } = await import('@aws-sdk/client-lightsail');
    return new LightsailClient({ region: DEFAULT_REGION });
  } catch (err) {
    throw new DeployNotConfiguredError(
      `@aws-sdk/client-lightsail is not installed — run \`pnpm install\`. (${String(err)})`,
    );
  }
}

/** Step 1-2: build the image and wait for the real terminal status. */
async function runCodeBuild(log: DeployLogger): Promise<{ buildId: string; buildStatus: string }> {
  const client = await codebuildClient();
  const { StartBuildCommand, BatchGetBuildsCommand } = await import('@aws-sdk/client-codebuild');

  const started = await client.send(new StartBuildCommand({ projectName: CODEBUILD_PROJECT }));
  const buildId = started.build?.id;
  if (!buildId) {
    throw new Error(`CodeBuild StartBuild returned no build id for project ${CODEBUILD_PROJECT}`);
  }
  log(`CodeBuild started: ${buildId}`);

  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const { builds } = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
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
    }
  }
  throw new Error(
    `CodeBuild ${buildId} still IN_PROGRESS after ${Math.round(BUILD_TIMEOUT_MS / 60000)} min — ` +
      `giving up waiting. The build may still finish; nothing was deployed.`,
  );
}

/** Step 3-4: redeploy the service with its existing spec, then wait for it. */
async function redeployService(log: DeployLogger): Promise<{ version: number; state: string }> {
  const client = await lightsailClient();
  const { GetContainerServiceDeploymentsCommand, CreateContainerServiceDeploymentCommand } = await import(
    '@aws-sdk/client-lightsail'
  );

  const current = await client.send(
    new GetContainerServiceDeploymentsCommand({ serviceName: LIGHTSAIL_SERVICE }),
  );
  const latest = current.deployments?.[0];
  if (!latest?.containers) {
    throw new Error(
      `Could not read the current deployment spec for ${LIGHTSAIL_SERVICE} — refusing to ` +
        `deploy, because inventing a spec would silently drop env vars or ports the ` +
        `running service depends on.`,
    );
  }
  const previousVersion = latest.version;
  log(`Reusing deployment spec from version ${previousVersion} (containers: ${Object.keys(latest.containers).join(', ')})`);

  await client.send(
    new CreateContainerServiceDeploymentCommand({
      serviceName: LIGHTSAIL_SERVICE,
      containers: latest.containers,
      publicEndpoint: latest.publicEndpoint
        ? {
            containerName: latest.publicEndpoint.containerName,
            containerPort: latest.publicEndpoint.containerPort,
            healthCheck: latest.publicEndpoint.healthCheck,
          }
        : undefined,
    }),
  );
  log('Lightsail deployment submitted — waiting for ACTIVE');

  const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const { deployments } = await client.send(
      new GetContainerServiceDeploymentsCommand({ serviceName: LIGHTSAIL_SERVICE }),
    );
    const newest = deployments?.[0];
    const state = newest?.state ?? 'UNKNOWN';
    const version = newest?.version ?? -1;
    if (version === previousVersion) continue; // new deployment not registered yet
    if (state === 'ACTIVATING') continue;
    log(`Lightsail deployment v${version}: ${state}`);
    if (state !== 'ACTIVE') {
      throw new Error(
        `Lightsail deployment v${version} for ${LIGHTSAIL_SERVICE} ended in state ${state}. ` +
          `Lightsail keeps the previous ACTIVE deployment serving traffic when a new one ` +
          `fails, so production is most likely still on v${previousVersion} — verify before rolling back.`,
      );
    }
    return { version, state };
  }
  throw new Error(
    `Lightsail deployment for ${LIGHTSAIL_SERVICE} still ACTIVATING after ` +
      `${Math.round(ACTIVATION_TIMEOUT_MS / 60000)} min — deployment state unknown, do not assume it shipped.`,
  );
}

/** Step 5: the only evidence that actually counts. */
async function verifyHealth(log: DeployLogger): Promise<{ serviceUrl: string; status: number; body: string }> {
  const client = await lightsailClient();
  const { GetContainerServicesCommand } = await import('@aws-sdk/client-lightsail');

  const { containerServices } = await client.send(
    new GetContainerServicesCommand({ serviceName: LIGHTSAIL_SERVICE }),
  );
  const serviceUrl = containerServices?.[0]?.url;
  if (!serviceUrl) {
    throw new Error(`Lightsail returned no URL for ${LIGHTSAIL_SERVICE} — cannot verify the deploy.`);
  }

  const healthUrl = `${serviceUrl.replace(/\/$/, '')}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    const body = retainHealthResponseBody(await res.text());
    log(`Health check ${healthUrl} -> ${res.status}`);
    if (!res.ok) {
      throw new Error(
        `Deployment is ACTIVE but ${healthUrl} returned ${res.status}: ${body.slice(0, 500)}. The new ` +
          `release is live and unhealthy — roll back.`,
      );
    }
    return { serviceUrl, status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Deployment is ACTIVE but ${healthUrl} did not respond within ${HEALTH_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Full deploy: build → redeploy → verify. Throws on any unproven step. */
export async function deployToLightsail(
  environment: 'staging' | 'production',
  log: DeployLogger = (m) => console.log(`[deploy] ${m}`),
): Promise<LightsailDeployResult> {
  assertConfigured(environment);
  log(`Deploying ${environment} — CodeBuild ${CODEBUILD_PROJECT} → Lightsail ${LIGHTSAIL_SERVICE} (${DEFAULT_REGION})`);

  const { buildId, buildStatus } = await runCodeBuild(log);
  const { version, state } = await redeployService(log);
  const health = await verifyHealth(log);

  return {
    buildId,
    buildStatus,
    deploymentVersion: version,
    deploymentState: state,
    serviceUrl: health.serviceUrl,
    healthStatus: health.status,
    healthBody: health.body,
  };
}

/** Roll back by re-submitting the newest deployment spec that was ACTIVE and
 *  is not the current one. This is a real rollback of the RUNNING SERVICE —
 *  note it cannot undo an image tag: the spec pins `:latest`, so if the bad
 *  release was published to that same tag, re-running an old spec pulls the
 *  bad image again. In that case the honest fix is to build the good commit.
 *  Detected and reported rather than silently doing nothing useful. */
export async function rollbackLightsail(
  environment: 'staging' | 'production',
  log: DeployLogger = (m) => console.log(`[rollback] ${m}`),
): Promise<{ restoredFromVersion: number; deploymentState: string; serviceUrl: string; healthStatus: number }> {
  assertConfigured(environment);
  const client = await lightsailClient();
  const { GetContainerServiceDeploymentsCommand, CreateContainerServiceDeploymentCommand } = await import(
    '@aws-sdk/client-lightsail'
  );

  const { deployments } = await client.send(
    new GetContainerServiceDeploymentsCommand({ serviceName: LIGHTSAIL_SERVICE }),
  );
  const sorted = [...(deployments ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  const target = sorted.find((d, i) => i > 0 && d.state === 'ACTIVE' && d.containers);
  if (!target?.containers) {
    throw new Error(
      `No earlier ACTIVE deployment found for ${LIGHTSAIL_SERVICE} — nothing to roll back to. ` +
        `Deploy a known-good commit instead.`,
    );
  }

  const usesMutableTag = Object.values(target.containers).some((c) => (c.image ?? '').endsWith(':latest'));
  if (usesMutableTag) {
    log(
      `WARNING: v${target.version}'s spec pins a ':latest' image tag. Re-deploying it pulls ` +
        `whatever ':latest' points at NOW, which is the bad image if the failed release ` +
        `overwrote that tag. Proceeding, but verify health and be ready to rebuild a known-good commit.`,
    );
  }

  log(`Rolling ${LIGHTSAIL_SERVICE} back to the spec from v${target.version}`);
  await client.send(
    new CreateContainerServiceDeploymentCommand({
      serviceName: LIGHTSAIL_SERVICE,
      containers: target.containers,
      publicEndpoint: target.publicEndpoint
        ? {
            containerName: target.publicEndpoint.containerName,
            containerPort: target.publicEndpoint.containerPort,
            healthCheck: target.publicEndpoint.healthCheck,
          }
        : undefined,
    }),
  );

  const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
  let state = 'UNKNOWN';
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const { deployments: latest } = await client.send(
      new GetContainerServiceDeploymentsCommand({ serviceName: LIGHTSAIL_SERVICE }),
    );
    state = latest?.[0]?.state ?? 'UNKNOWN';
    if (state !== 'ACTIVATING') break;
  }
  if (state !== 'ACTIVE') {
    throw new Error(`Rollback deployment for ${LIGHTSAIL_SERVICE} ended in state ${state} — escalate immediately.`);
  }

  const health = await verifyHealth(log);
  return {
    restoredFromVersion: target.version ?? -1,
    deploymentState: state,
    serviceUrl: health.serviceUrl,
    healthStatus: health.status,
  };
}
