import { access, readFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { db, auditEvents } from '@workspace/db';
import type { ToolContext } from './types.js';

const recordedTasks = new Set<string>();

const READ_ONLY_TOOLS = new Set([
  'readFile',
  'listDir',
  'webSearch',
  'fetchUrl',
  'browserCheck',
  'get_task_details',
  'get_delegation_status',
  'get_system_status',
  'get_metrics_view',
  'get_active_alerts',
  'health_check',
  'listResearchedLeads',
  'getResearchedLeadById',
  'list_goals',
  'list_workstreams',
  'list_scheduled_tasks',
  'get_job_history',
  'get_executor_status',
  'list_artifacts',
  'read_artifact',
  'git_status',
  'get_email_campaign_status',
  'get_call_status',
  'searchBusinessDirectory',
]);

const MUTATION_PREFIXES = [
  'add',
  'approve',
  'acknowledge',
  'cancel',
  'configure',
  'create',
  'delegate',
  'deploy',
  'dispatch',
  'enroll',
  'import',
  'make_',
  'pause',
  'provision',
  'publish',
  'push',
  'record',
  'register',
  'reject',
  'resume',
  'rollback',
  'run',
  'save',
  'schedule',
  'send',
  'start',
  'store',
  'sync',
  'update',
  'write',
];

export interface RuntimeProvenanceSnapshot {
  repo_root: string;
  git_commit: string;
  branch: string;
  package_root: string | null;
  runtime_entrypoint: string;
  resolved_workspace_package: string | null;
  artifact_root: string | null;
  database_target: string | null;
  environment_name: string;
  target_path: string | null;
  target_workspace_root: string | null;
  checked_at: string;
}

export interface RuntimeProvenanceResult {
  ok: boolean;
  reasons: string[];
  snapshot: RuntimeProvenanceSnapshot;
  recorded: boolean;
}

function isProductionRuntime(): boolean {
  return Boolean(
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_ENVIRONMENT_NAME,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findWorkspaceRoot(start: string): Promise<string | null> {
  let current = resolve(start);
  while (true) {
    if (
      (await exists(join(current, 'pnpm-workspace.yaml'))) &&
      (await exists(join(current, 'package.json')))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function findPackageRoot(start: string, stopAt: string): Promise<string | null> {
  let current = resolve(start);
  const stop = resolve(stopAt);
  while (true) {
    if (await exists(join(current, 'package.json'))) return current;
    if (current === stop) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function packageName(packageRoot: string | null): Promise<string | null> {
  if (!packageRoot) return null;
  try {
    const raw = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof raw.name === 'string' ? raw.name : null;
  } catch {
    return null;
  }
}

function sanitizeDatabaseTarget(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol}//${url.hostname}${port}${url.pathname}`;
  } catch {
    return 'configured-unparseable';
  }
}

function artifactRoot(): string | null {
  const dir = process.env.APEX_ARTIFACT_DIR?.trim();
  if (dir) return resolve(dir);
  const bucket = process.env.APEX_ARTIFACT_BUCKET?.trim();
  return bucket ? `gcs://${bucket}` : null;
}

function extractTargetPath(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): string | null {
  const candidates = ['path', 'cwd', 'filePath', 'directory', 'workspacePath', 'repoPath'];
  for (const key of candidates) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return resolve(workspaceRoot, value);
    }
  }
  if (toolName === 'writeFile' && typeof args.path === 'string') {
    return resolve(workspaceRoot, args.path);
  }
  return null;
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !rel.includes(`${sep}..${sep}`));
}

function isMutationTool(name: string): boolean {
  if (READ_ONLY_TOOLS.has(name)) return false;
  if (name === 'sendMessage') return true;
  if (name === 'writeFile' || name === 'runShell' || name === 'runInSandbox') return true;
  return MUTATION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function persistSnapshot(
  context: ToolContext,
  result: Omit<RuntimeProvenanceResult, 'recorded'>,
): Promise<boolean> {
  const key = context.taskId ?? `${context.agentId}:unscoped`;
  if (recordedTasks.has(key)) return true;

  try {
    await db
      .insert(auditEvents)
      .values({
        organizationId: 'apex',
        actorType: 'agent',
        actorId: context.agentId,
        action: result.ok ? 'runtime.provenance_verified' : 'runtime.provenance_failed',
        entityType: context.taskId ? 'task_runtime_provenance' : null,
        entityId: context.taskId ?? null,
        metadata: {
          ...result.snapshot,
          reasons: result.reasons,
          task_id: context.taskId ?? null,
          goal_id: context.goalId ?? null,
        },
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    recordedTasks.add(key);
    return true;
  } catch (error) {
    console.error(
      '[runtime-provenance] could not persist provenance:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Verify that an agent is operating against the canonical deployed workspace
 * before a state-changing tool is allowed to run. The first tool invocation
 * for each task writes a durable provenance record. Reads can continue when
 * provenance is incomplete so an agent can diagnose the mismatch; writes fail
 * closed.
 */
export async function ensureRuntimeProvenance(
  toolName: string,
  rawArgs: Record<string, unknown>,
  context: ToolContext,
): Promise<RuntimeProvenanceResult> {
  const canonicalRoot = resolve(process.env.APEX_CANONICAL_REPO_ROOT || process.cwd());
  const contextRoot = resolve(context.workspaceRoot || canonicalRoot);
  const targetPath = extractTargetPath(toolName, rawArgs, contextRoot);
  const targetProbe = targetPath ? dirname(targetPath) : contextRoot;
  const detectedRoot =
    (await findWorkspaceRoot(targetProbe)) ??
    (await findWorkspaceRoot(contextRoot));

  const packageRoot = await findPackageRoot(targetProbe, canonicalRoot);
  const expectedSha = (process.env.APEX_BUILD_SHA || '').trim();
  const production = isProductionRuntime();
  const artifact = artifactRoot();
  const databaseTarget = sanitizeDatabaseTarget(process.env.DATABASE_URL);
  const environmentName =
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.NODE_ENV ||
    'development';

  const snapshot: RuntimeProvenanceSnapshot = {
    repo_root: canonicalRoot,
    git_commit: expectedSha || 'unknown',
    branch: process.env.APEX_SOURCE_BRANCH || 'main',
    package_root: packageRoot,
    runtime_entrypoint: process.argv[1] || 'unknown',
    resolved_workspace_package: await packageName(packageRoot),
    artifact_root: artifact,
    database_target: databaseTarget,
    environment_name: environmentName,
    target_path: targetPath,
    target_workspace_root: detectedRoot,
    checked_at: new Date().toISOString(),
  };

  const reasons: string[] = [];

  if (!pathWithin(canonicalRoot, contextRoot)) {
    reasons.push(`context workspace ${contextRoot} is outside canonical repo root ${canonicalRoot}`);
  }

  if (detectedRoot && resolve(detectedRoot) !== canonicalRoot) {
    reasons.push(
      `target resolves to shadow/nested workspace ${resolve(detectedRoot)} instead of canonical ${canonicalRoot}`,
    );
  }

  if (targetPath) {
    if (!pathWithin(canonicalRoot, targetPath)) {
      reasons.push(`target path ${targetPath} is outside canonical repo root ${canonicalRoot}`);
    }
    const normalized = targetPath.split('\\').join('/');
    if (normalized.includes('/node_modules/')) {
      reasons.push('writes into node_modules are forbidden; edit the canonical workspace package instead');
    }
  }

  if (production && (!expectedSha || expectedSha === 'unknown')) {
    reasons.push('APEX_BUILD_SHA is missing/unknown in production');
  }
  if (production && !artifact) {
    reasons.push('durable artifact root is not configured');
  }
  if (production && !databaseTarget) {
    reasons.push('DATABASE_URL is not configured');
  }

  const baseResult = { ok: reasons.length === 0, reasons, snapshot };
  const recorded = await persistSnapshot(context, baseResult);
  const mutation = isMutationTool(toolName);

  if (mutation && !recorded) {
    reasons.push('runtime provenance could not be written to the durable audit chain');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    snapshot,
    recorded,
  };
}

export function runtimeProvenanceRequiresGate(toolName: string): boolean {
  return isMutationTool(toolName);
}
