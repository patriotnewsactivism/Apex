// ─── CloudRunDeployer — APEX production deployment path ─────────────────────
//
// APEX production runs on Google Cloud Run. This deployer is deliberately
// conservative:
//   1. It requires an authenticated gcloud session and explicit project,
//      region, and EXISTING service name.
//   2. It verifies the source tree is a clean Git commit and, when supplied,
//      exactly matches the requested SHA.
//   3. It reads the existing Cloud Run service and reuses its current image
//      repository. It never invents a new service or repository.
//   4. Google Cloud Build builds that exact tree with APEX_BUILD_SHA and
//      APEX_BUILD_TIME baked into the image and pushes an immutable :<sha> tag.
//   5. `gcloud run services update --image ...` updates the EXISTING service,
//      preserving its env vars, Secret Manager refs, service account, scaling,
//      ingress, custom domain mapping, CPU/memory, and other configuration.
//   6. It waits for Ready and verifies /health. The caller separately confirms
//      that /health build.sha equals the requested commit.
//
// Credentials never live in this repo. gcloud may obtain them from a human
// login, Workload Identity Federation, or another Google-supported credential
// source. If authentication/configuration is absent, deployment fails loudly.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = Number(process.env.APEX_DEPLOY_COMMAND_TIMEOUT_MS ?? 30 * 60_000);
const ACTIVATION_TIMEOUT_MS = Number(process.env.APEX_DEPLOY_ACTIVATION_TIMEOUT_MS ?? 15 * 60_000);
const POLL_INTERVAL_MS = Number(process.env.APEX_DEPLOY_POLL_INTERVAL_MS ?? 5_000);
const HEALTH_TIMEOUT_MS = 20_000;
export const MAX_HEALTH_BODY_CHARS = 64_000;

export interface DeployLogger {
  (message: string): void;
}

export interface CloudRunDeployResult {
  buildId: string;
  buildStatus: string;
  revisionName: string;
  deploymentState: string;
  serviceUrl: string;
  healthStatus: number;
  healthBody: string;
  image: string;
}

export interface CloudRunRollbackResult {
  restoredRevision: string;
  serviceUrl: string;
  healthStatus: number;
  healthBody: string;
}

export class DeployNotConfiguredError extends Error {}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function retainHealthResponseBody(body: string): string {
  if (body.length > MAX_HEALTH_BODY_CHARS) {
    throw new Error(`/health response exceeded ${MAX_HEALTH_BODY_CHARS} characters; refusing an unbounded body.`);
  }
  return body;
}

export function isDeployEnabled(environment: 'staging' | 'production'): boolean {
  const raw = (process.env.APEX_DEPLOY_ENABLED ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'true' || raw === '1' || raw === 'all') return true;
  return raw.split(',').map((value) => value.trim()).includes(environment);
}

export function immutableImageRef(image: string, sourceSha: string): string {
  const sha = sourceSha.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new Error(`Cannot create immutable image tag from invalid source SHA: ${sourceSha}`);
  }
  const tag = sha.slice(0, 12);
  const withoutDigest = image.replace(/@sha256:[0-9a-f]+$/i, '');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  if (!repository.includes('/')) {
    throw new Error(`Existing Cloud Run image '${image}' is not a usable registry image reference.`);
  }
  return `${repository}:${tag}`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new DeployNotConfiguredError(`${name} is required for Cloud Run deployment.`);
  return value;
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return String(stdout).trim();
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string; code?: string | number };
    const detail = String(e.stderr || e.stdout || e.message || err).trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${detail.slice(0, 4000)}`);
  }
}

async function assertConfigured(environment: 'staging' | 'production'): Promise<{
  projectId: string;
  region: string;
  service: string;
  sourceDir: string;
}> {
  if (!isDeployEnabled(environment)) {
    throw new DeployNotConfiguredError(
      `Deploys to ${environment} are disabled. Set APEX_DEPLOY_ENABLED=${environment} (or "all") to opt in.`,
    );
  }

  const projectId = required('APEX_GCP_PROJECT_ID');
  const region = required('APEX_CLOUD_RUN_REGION');
  const service = required('APEX_CLOUD_RUN_SERVICE');
  const sourceDir = resolve(process.env.APEX_DEPLOY_SOURCE_DIR ?? process.cwd());

  try {
    await runCommand('gcloud', ['--version']);
  } catch (err) {
    throw new DeployNotConfiguredError(
      `Google Cloud CLI is not available. Run this deployer from an authenticated operator/CI environment with gcloud installed. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const account = await runCommand('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  if (!account) {
    throw new DeployNotConfiguredError('gcloud has no active authenticated account or workload identity.');
  }

  return { projectId, region, service, sourceDir };
}

interface ServiceDescription {
  spec?: { template?: { spec?: { containers?: Array<{ image?: string }> } } };
  status?: {
    url?: string;
    latestCreatedRevisionName?: string;
    latestReadyRevisionName?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
  template?: { containers?: Array<{ image?: string }> };
  uri?: string;
}

async function describeExistingService(projectId: string, region: string, service: string): Promise<ServiceDescription> {
  let raw: string;
  try {
    raw = await runCommand('gcloud', [
      'run', 'services', 'describe', service,
      '--project', projectId,
      '--region', region,
      '--platform', 'managed',
      '--format=json',
    ]);
  } catch (err) {
    throw new DeployNotConfiguredError(
      `Existing Cloud Run service '${service}' could not be read in ${projectId}/${region}. ` +
      `This deployer will not create a replacement or guess another target. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return JSON.parse(raw) as ServiceDescription;
}

function currentImage(service: ServiceDescription): string {
  const image = service.template?.containers?.[0]?.image ?? service.spec?.template?.spec?.containers?.[0]?.image;
  if (!image) {
    throw new Error('Existing Cloud Run service returned no application image; refusing to guess a registry/repository.');
  }
  return image;
}

async function exactCleanSourceSha(sourceDir: string, expectedSha?: string): Promise<string> {
  const head = (await runCommand('git', ['rev-parse', 'HEAD'], sourceDir)).trim();
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error(`Could not resolve a full Git SHA from ${sourceDir}.`);
  const dirty = await runCommand('git', ['status', '--porcelain'], sourceDir);
  if (dirty) {
    throw new Error('Deployment source tree is dirty. Commit/review changes before building production.');
  }
  if (expectedSha && head.slice(0, 12) !== expectedSha.slice(0, 12)) {
    throw new Error(`Deployment source is ${head.slice(0, 12)}, not requested ${expectedSha.slice(0, 12)}.`);
  }
  return head;
}

async function buildImmutableImage(
  log: DeployLogger,
  projectId: string,
  sourceDir: string,
  image: string,
  sourceSha: string,
): Promise<{ buildId: string; buildStatus: string }> {
  const buildTime = new Date().toISOString();
  const args = [
    'builds', 'submit', sourceDir,
    '--project', projectId,
    '--config', resolve(sourceDir, 'cloudbuild.apex.yaml'),
    '--substitutions', `_IMAGE=${image},_APEX_BUILD_SHA=${sourceSha},_APEX_BUILD_TIME=${buildTime}`,
    '--quiet',
    '--format=json',
  ];
  const buildRegion = process.env.APEX_CLOUD_BUILD_REGION?.trim();
  if (buildRegion) args.push('--region', buildRegion);

  log(`Cloud Build: building ${sourceSha.slice(0, 12)} as ${image}`);
  const raw = await runCommand('gcloud', args, sourceDir);
  const parsed = JSON.parse(raw || '{}') as { id?: string; status?: string; metadata?: { build?: { id?: string; status?: string } } };
  const buildId = parsed.id ?? parsed.metadata?.build?.id ?? 'gcloud-build';
  const buildStatus = parsed.status ?? parsed.metadata?.build?.status ?? 'SUCCESS';
  if (!['SUCCESS', 'SUCCEEDED'].includes(buildStatus.toUpperCase())) {
    throw new Error(`Cloud Build ${buildId} ended ${buildStatus}; nothing will be deployed.`);
  }
  return { buildId, buildStatus };
}

async function updateExistingService(
  log: DeployLogger,
  projectId: string,
  region: string,
  service: string,
  image: string,
): Promise<{ revisionName: string; serviceUrl: string }> {
  log(`Cloud Run: updating EXISTING service ${service} to ${image}`);
  await runCommand('gcloud', [
    'run', 'services', 'update', service,
    '--image', image,
    '--project', projectId,
    '--region', region,
    '--platform', 'managed',
    '--quiet',
    '--format=json',
  ]);

  const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const description = await describeExistingService(projectId, region, service);
    const ready = description.status?.conditions?.find((condition) => condition.type === 'Ready');
    const created = description.status?.latestCreatedRevisionName;
    const latestReady = description.status?.latestReadyRevisionName;
    if (ready?.status === 'True' && created && latestReady === created) {
      const serviceUrl = description.status?.url ?? description.uri;
      if (!serviceUrl) throw new Error('Cloud Run reports Ready but returned no service URL.');
      log(`Cloud Run revision ${created} is Ready.`);
      return { revisionName: created, serviceUrl };
    }
    if (ready?.status === 'False') {
      throw new Error(`Cloud Run revision failed readiness: ${ready.message ?? 'no condition message'}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Cloud Run service ${service} did not become Ready within ${Math.round(ACTIVATION_TIMEOUT_MS / 60000)} minutes.`);
}

async function verifyHealth(log: DeployLogger, serviceUrl: string): Promise<{ status: number; body: string }> {
  const base = (process.env.APEX_DEPLOY_HEALTH_URL?.trim() || 'https://apex.donmatthews.live').replace(/\/$/, '');
  const healthUrl = base.endsWith('/health') ? base : `${base}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    const body = retainHealthResponseBody(await response.text());
    log(`Health check ${healthUrl} -> ${response.status} (Cloud Run canonical URL ${serviceUrl})`);
    if (!response.ok) {
      throw new Error(`Cloud Run revision is Ready but ${healthUrl} returned ${response.status}: ${body.slice(0, 500)}`);
    }
    return { status: response.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${healthUrl} did not respond within ${HEALTH_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function deployToCloudRun(
  environment: 'staging' | 'production',
  log: DeployLogger = console.log,
  expectedSha?: string,
): Promise<CloudRunDeployResult> {
  const { projectId, region, service, sourceDir } = await assertConfigured(environment);
  const existing = await describeExistingService(projectId, region, service);
  const sourceSha = await exactCleanSourceSha(sourceDir, expectedSha);
  const image = immutableImageRef(currentImage(existing), sourceSha);
  const build = await buildImmutableImage(log, projectId, sourceDir, image, sourceSha);
  const updated = await updateExistingService(log, projectId, region, service, image);
  const health = await verifyHealth(log, updated.serviceUrl);
  return {
    buildId: build.buildId,
    buildStatus: build.buildStatus,
    revisionName: updated.revisionName,
    deploymentState: 'READY',
    serviceUrl: updated.serviceUrl,
    healthStatus: health.status,
    healthBody: health.body,
    image,
  };
}

export async function rollbackCloudRun(
  environment: 'staging' | 'production',
  log: DeployLogger = console.log,
): Promise<CloudRunRollbackResult> {
  const { projectId, region, service } = await assertConfigured(environment);
  const raw = await runCommand('gcloud', [
    'run', 'revisions', 'list',
    '--service', service,
    '--project', projectId,
    '--region', region,
    '--platform', 'managed',
    '--sort-by=~metadata.creationTimestamp',
    '--limit=2',
    '--format=json',
  ]);
  const revisions = JSON.parse(raw) as Array<{ metadata?: { name?: string } }>;
  const previous = revisions[1]?.metadata?.name;
  if (!previous) throw new Error(`No previous Cloud Run revision exists for ${service}; rollback is impossible.`);

  log(`Cloud Run: routing 100% traffic back to ${previous}`);
  await runCommand('gcloud', [
    'run', 'services', 'update-traffic', service,
    '--to-revisions', `${previous}=100`,
    '--project', projectId,
    '--region', region,
    '--platform', 'managed',
    '--quiet',
  ]);
  const description = await describeExistingService(projectId, region, service);
  const serviceUrl = description.status?.url ?? description.uri;
  if (!serviceUrl) throw new Error('Cloud Run returned no service URL after rollback.');
  const health = await verifyHealth(log, serviceUrl);
  return {
    restoredRevision: previous,
    serviceUrl,
    healthStatus: health.status,
    healthBody: health.body,
  };
}
