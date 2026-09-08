// ─── Durable Work Tools (artifact store, repos, deploy hooks, workspaces) ────
//
// Phases 1–5 of the autonomous-execution scheduler. All durable-work tools
// live here (not in the already-2000-line tool-registry.ts) and are registered
// by getToolRegistry() the same way the campaign/connector tools are.
//
// Gating summary (see approval-policy.ts):
//   auto            — internal bookkeeping / reads, no external side effects
//   gated           — external side effect or new capability; human approval,
//                     unless the owning project's autonomy mode allows it
//   hard-gated      — never auto-approvable (HARD_GATED_TOOLS)
//
// Every bucket operation fails closed when APEX_ARTIFACT_BUCKET is unset;
// hook URLs are secret-ref style (`env:VAR_NAME`) and never logged.

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { resolve, basename, join } from 'path';
import { readFile } from 'fs/promises';
import type { ToolDefinition, ToolContext } from './types.js';
import {
  ArtifactStore,
  artifactBucketName,
  isArtifactStoreConfigured,
  objectNameFor,
  sha256Hex,
} from './artifact-store.js';
import { db, artifacts, tasks, goals, projects, deployHooks, workstreams, deployments } from '@workspace/db';
import { eq, and, desc, ilike } from 'drizzle-orm';
import { recordHeavyWorkRoutedToExecutor } from './runtime-health.js';

// ─── In-process artifact tracker (TaskResult.artifacts wiring) ───────────────
//
// store_artifact records every artifact it publishes per task id. When
// BaseAgent completes the task it drains this map into tasks.result_artifacts
// so results carry real object URLs. In-memory by design: the durable record
// is the artifacts table row; this is only the completion-time link.
const taskArtifacts = new Map<string, string[]>();

export function rememberTaskArtifact(taskId: string, url: string): void {
  const list = taskArtifacts.get(taskId) ?? [];
  if (!list.includes(url)) list.push(url);
  taskArtifacts.set(taskId, list);
}

export function drainTaskArtifacts(taskId: string): string[] {
  const list = taskArtifacts.get(taskId) ?? [];
  taskArtifacts.delete(taskId);
  return list;
}

/** Non-destructive read, for a checkpoint written mid-task (Phase 2): the
 *  task is not complete, so its artifact refs must survive to be drained for
 *  real when it eventually does complete. */
export function peekTaskArtifacts(taskId: string): string[] {
  return [...(taskArtifacts.get(taskId) ?? [])];
}

// ─── Project resolution helpers ──────────────────────────────────────────────

/** Resolve the owning project id for a tool context (task → goal → project). */
export async function resolveProjectIdForContext(
  ctx: ToolContext,
  explicitProjectId?: string,
): Promise<{ projectId: string; project?: typeof projects.$inferSelect }> {
  if (explicitProjectId) {
    const [project] = await db.select().from(projects).where(eq(projects.id, explicitProjectId)).limit(1);
    return { projectId: explicitProjectId, project: project ?? undefined };
  }
  if (ctx.taskId) {
    const [task] = await db.select({ goalId: tasks.goalId }).from(tasks).where(eq(tasks.id, ctx.taskId)).limit(1);
    if (task?.goalId) {
      const [goal] = await db.select({ projectId: goals.projectId }).from(goals).where(eq(goals.id, task.goalId)).limit(1);
      if (goal?.projectId) {
        const [project] = await db.select().from(projects).where(eq(projects.id, goal.projectId)).limit(1);
        return { projectId: goal.projectId, project: project ?? undefined };
      }
    }
  }
  return { projectId: 'apex' };
}

async function recordArtifactRow(input: {
  taskId?: string | null;
  projectId?: string | null;
  objectName: string;
  fileName: string;
  mimeType?: string | null;
  sizeBytes: number;
  sha256: string;
  publicUrl?: string | null;
  kind: string;
}): Promise<void> {
  await db.insert(artifacts).values({
    id: randomUUID(),
    taskId: input.taskId ?? null,
    projectId: input.projectId ?? null,
    objectName: input.objectName,
    fileName: input.fileName,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    publicUrl: input.publicUrl ?? null,
    kind: input.kind,
    createdAt: new Date(),
  }).onConflictDoNothing({ target: [artifacts.taskId, artifacts.objectName] });
}

// ─── Tool factory ────────────────────────────────────────────────────────────

export function createDurableWorkTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const store = (name: string, description: string, schema: z.ZodSchema, requiresApproval: boolean, execute: (input: any, ctx: ToolContext) => Promise<unknown>) => {
    tools.push({ name, description, schema, requiresApproval, execute });
  };

  // ── Phase 1: artifact store ────────────────────────────────────────────

  store(
    'store_artifact',
    'Upload a durable artifact into the APEX artifact bucket (documents, builds, renders, output files). ' +
      'Accepts either `path` (a file already written under the workspace via writeFile) or inline `content`. ' +
      'Returns the object URL and records an artifacts row. Fails closed when APEX_ARTIFACT_BUCKET is unset.',
    z.object({
      fileName: z.string().describe('Desired file name (e.g. "report.md" or "out/index.html")'),
      path: z.string().optional().describe('Workspace-relative path of an existing file to upload'),
      content: z.string().optional().describe('Inline text content (used when `path` is not given)'),
      mimeType: z.string().optional().describe('MIME type (defaults to application/octet-stream)'),
      kind: z.enum(['document', 'build', 'code', 'workspace', 'deployment', 'other']).optional().describe('Artifact kind'),
      projectId: z.string().optional().describe('Explicit project id (defaults to the task goal\'s project)'),
    }),
    false,
    async ({ fileName, path, content, mimeType, kind, projectId }, ctx) => {
      if (!isArtifactStoreConfigured()) {
        throw new Error(
          'APEX_ARTIFACT_BUCKET is not configured — nothing was stored. ' +
            'Set the env var (see docs/PRODUCTION_OPERATIONS.md) before using store_artifact.',
        );
      }
      if (!path && content === undefined) {
        throw new Error('store_artifact requires either `path` or `content`');
      }
      const { projectId: resolvedProject } = await resolveProjectIdForContext(ctx, projectId);
      let buffer: Buffer;
      let sizeBytes: number;
      let sha256: string;
      if (path) {
        const abs = resolve(ctx.workspaceRoot, path);
        buffer = await readFile(abs);
        sizeBytes = buffer.length;
        sha256 = sha256Hex(buffer);
      } else {
        buffer = Buffer.from(content, 'utf8');
        sizeBytes = buffer.length;
        sha256 = sha256Hex(buffer);
      }
      const safeName = fileName.replace(/^[/\\]+/, '');
      const objectName = objectNameFor(resolvedProject, ctx.taskId ?? 'manual', safeName);
      const store = new ArtifactStore();
      const result = await store.upload({ objectName, content: buffer, mimeType });
      await recordArtifactRow({
        taskId: ctx.taskId ?? null,
        projectId: resolvedProject,
        objectName,
        fileName: safeName,
        mimeType: mimeType ?? null,
        sizeBytes,
        sha256,
        kind: kind ?? 'other',
      });
      const url = await store.signedUrl(objectName);
      if (ctx.taskId) rememberTaskArtifact(ctx.taskId, url);
      return { objectName, url, gsUri: result.gsUri, sizeBytes, sha256, bucket: artifactBucketName() };
    },
  );

  store(
    'read_artifact',
    'Download artifact content back from the bucket for rework. Returns the decoded text (or base64 for binary) and metadata.',
    z.object({
      objectName: z.string().describe('Object name as returned by store_artifact / list_artifacts'),
      binary: z.boolean().optional().describe('Return base64 content instead of UTF-8 text (default false)'),
    }),
    false,
    async ({ objectName, binary }) => {
      const store = new ArtifactStore();
      const content = await store.download(objectName);
      const [row] = await db.select({ fileName: artifacts.fileName, mimeType: artifacts.mimeType, sizeBytes: artifacts.sizeBytes, sha256: artifacts.sha256 })
        .from(artifacts).where(eq(artifacts.objectName, objectName)).limit(1);
      return {
        objectName,
        content: binary ? content.toString('base64') : content.toString('utf8'),
        encoded: binary ? 'base64' : 'utf8',
        fileName: row?.fileName ?? basename(objectName),
        mimeType: row?.mimeType ?? null,
        sizeBytes: row?.sizeBytes ?? content.length,
        sha256: row?.sha256 ?? sha256Hex(content),
      };
    },
  );

  store(
    'list_artifacts',
    'List artifact records and bucket objects by project, task, or prefix.',
    z.object({
      projectId: z.string().optional().describe('Filter by project'),
      taskId: z.string().optional().describe('Filter by task'),
      kind: z.string().optional().describe('Filter by kind (document|build|code|workspace|deployment|other)'),
      limit: z.number().optional().describe('Max rows (default 50)'),
    }),
    false,
    async ({ projectId, taskId, kind, limit }) => {
      const filters = [];
      if (projectId) filters.push(eq(artifacts.projectId, projectId));
      if (taskId) filters.push(eq(artifacts.taskId, taskId));
      if (kind) filters.push(eq(artifacts.kind, kind));
      const rows = await db.select().from(artifacts)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(artifacts.createdAt))
        .limit(limit ?? 50);
      return rows;
    },
  );

  store(
    'publish_artifact',
    'Make an artifact publicly readable and return its shareable URL. Gated: visible to anyone with the link. Auto-approvable only inside an autonomy-mode project that lists publish_artifact.',
    z.object({
      objectName: z.string().describe('Object name to publish'),
    }),
    true,
    async ({ objectName }) => {
      const store = new ArtifactStore();
      const url = await store.makePublic(objectName);
      await db.update(artifacts).set({ publicUrl: url }).where(eq(artifacts.objectName, objectName));
      return { objectName, publicUrl: url };
    },
  );

  // ── Phase 2: code deliverables (GitHub repos) ───────────────────────────

  store(
    'create_github_repo',
    'Create a new GitHub repository under the configured org (APEX_GITHUB_ORG, default "patriotnewsactivism") ' +
      'for a workstream deliverable, initialized with a README. Returns the clone URL. ' +
      'Requires GITHUB_TOKEN_4 with repo create scope. Gated by default; auto-approvable in autonomy mode.',
    z.object({
      name: z.string().describe('Repository name, e.g. "<workstream>-<slug>" (lowercase, dashes)'),
      description: z.string().optional().describe('Repository description'),
      private: z.boolean().optional().describe('Create as private (default false)'),
      org: z.string().optional().describe('GitHub org (defaults to APEX_GITHUB_ORG env, then "patriotnewsactivism")'),
    }),
    true,
    async ({ name, description, private: isPrivate, org }) => {
      const token = process.env.GITHUB_TOKEN_4;
      if (!token) return { success: false, error: 'GITHUB_TOKEN_4 is not configured in this environment' };
      const orgName = org ?? process.env.APEX_GITHUB_ORG ?? 'patriotnewsactivism';
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        return { success: false, error: `Invalid repo name: ${name} (lowercase letters, digits, dashes only)` };
      }
      const res = await fetch(`https://api.github.com/orgs/${orgName}/repos`, {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          description: description ?? 'Created autonomously by APEX',
          private: isPrivate ?? false,
          auto_init: true,
        }),
      });
      const data: any = await res.json();
      if (!res.ok) {
        return { success: false, error: data?.message || `GitHub API error ${res.status}`, details: data };
      }
      return {
        success: true,
        repo: `${orgName}/${name}`,
        cloneUrl: data.clone_url,
        htmlUrl: data.html_url,
        defaultBranch: data.default_branch ?? 'main',
      };
    },
  );

  // ── Phase 2: deploy hooks ───────────────────────────────────────────────

  store(
    'register_deploy_hook',
    'Register a hosting-platform deploy webhook for a project. hookUrl is an https URL or an `env:VAR_NAME` ' +
      'secret reference resolved at deploy time; the value is never stored in plaintext and never logged. ' +
      'Hard-gated: installing a new external capability is an operator action.',
    z.object({
      name: z.string().describe('Hook name (e.g. "vercel-prod")'),
      hookUrl: z.string().describe('https URL or env:VAR_NAME secret reference'),
      platform: z.enum(['vercel', 'railway', 'render', 'cloudflare', 'custom']).optional().describe('Hosting platform'),
      projectId: z.string().optional().describe('Project this hook deploys'),
    }),
    true,
    async ({ name, hookUrl, platform, projectId }, ctx) => {
      const { projectId: resolvedProject } = await resolveProjectIdForContext(ctx, projectId);
      const isRef = hookUrl.startsWith('env:');
      if (!isRef && !/^https:\/\//.test(hookUrl)) {
        return { success: false, error: 'hookUrl must be an https URL or an env:VAR_NAME reference' };
      }
      const id = randomUUID();
      await db.insert(deployHooks).values({
        id,
        projectId: resolvedProject,
        name,
        hookUrl,
        platform: platform ?? 'custom',
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [deployHooks.projectId, deployHooks.name],
        set: { hookUrl, platform: platform ?? 'custom', active: true, updatedAt: new Date() },
      });
      return { success: true, hookId: id, name, projectId: resolvedProject, secretRefStyle: isRef };
    },
  );

  store(
    'list_deploy_hooks',
    'List registered deploy hooks with their platform, active state, and last status. Never returns hook URLs.',
    z.object({
      projectId: z.string().optional().describe('Filter by project'),
    }),
    false,
    async ({ projectId }) => {
      const rows = projectId
        ? await db.select({
            id: deployHooks.id, projectId: deployHooks.projectId, name: deployHooks.name,
            platform: deployHooks.platform, active: deployHooks.active, lastStatus: deployHooks.lastStatus,
            updatedAt: deployHooks.updatedAt,
          }).from(deployHooks).where(eq(deployHooks.projectId, projectId)).orderBy(desc(deployHooks.createdAt))
        : await db.select({
            id: deployHooks.id, projectId: deployHooks.projectId, name: deployHooks.name,
            platform: deployHooks.platform, active: deployHooks.active, lastStatus: deployHooks.lastStatus,
            updatedAt: deployHooks.updatedAt,
          }).from(deployHooks).orderBy(desc(deployHooks.createdAt));
      return rows;
    },
  );

  store(
    'deploy_via_hook',
    'Trigger a registered deploy hook (e.g. Vercel build webhook) for a project. Records the result in the hook row, ' +
      'writes a deployment.txt summary artifact into the bucket, and records a deployments row with platform="hook". ' +
      'Gated by default; auto-approvable in autonomy mode for registered hooks.',
    z.object({
      hookId: z.string().describe('Hook id from register_deploy_hook / list_deploy_hooks'),
      summary: z.string().optional().describe('Short deployment summary to include in the artifact'),
    }),
    true,
    async ({ hookId, summary }, ctx) => {
      const [hook] = await db.select().from(deployHooks).where(eq(deployHooks.id, hookId)).limit(1);
      if (!hook) return { success: false, error: `No deploy hook with id ${hookId}` };
      if (!hook.active) return { success: false, error: `Deploy hook ${hook.name} is inactive` };

      let url: string;
      if (hook.hookUrl.startsWith('env:')) {
        const envName = hook.hookUrl.slice(4);
        url = process.env[envName] ?? '';
        if (!url) return { success: false, error: `Deploy hook ${hook.name} references env:${envName} which is not set` };
      } else {
        url = hook.hookUrl;
      }

      let response: Response;
      let bodyText: string;
      try {
        response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(60_000) });
        bodyText = (await response.text()).slice(0, 4000);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await db.update(deployHooks).set({
          lastStatus: { ok: false, at: new Date().toISOString(), error: detail.slice(0, 500) },
          updatedAt: new Date(),
        }).where(eq(deployHooks.id, hookId));
        return { success: false, error: `Deploy hook request failed: ${detail}` };
      }

      const ok = response.ok;
      await db.update(deployHooks).set({
        lastStatus: { ok, at: new Date().toISOString(), status: response.status, body: bodyText.slice(0, 500) },
        updatedAt: new Date(),
      }).where(eq(deployHooks.id, hookId));

      const deploymentId = randomUUID();
      const deploymentUrl = ok ? url.split('?')[0] : null;
      await db.insert(deployments).values({
        id: deploymentId,
        environment: 'production',
        platform: 'hook',
        deploymentUrl,
        status: ok ? 'deploying' : 'failed',
        error: ok ? null : bodyText.slice(0, 500),
        deployedAt: new Date(),
      }).onConflictDoNothing({ target: deployments.id });

      // Deployment summary artifact (Phase 2.4) — best-effort; a bucket
      // outage must not turn a successful webhook trigger into a failure.
      let artifact: Record<string, unknown> | undefined;
      try {
        const { projectId: resolvedProject } = await resolveProjectIdForContext(ctx, hook.projectId ?? undefined);
        const content = [
          `Deployment via hook: ${hook.name} (${hook.platform})`,
          `Hook id: ${hookId}`,
          `Triggered at: ${new Date().toISOString()}`,
          `HTTP status: ${response.status} (${ok ? 'OK' : 'FAILED'})`,
          summary ? `Summary: ${summary}` : '',
          ok ? `Live URL: ${deploymentUrl ?? 'see hosting platform'}` : `Response body: ${bodyText.slice(0, 500)}`,
        ].join('\n');
        const objectName = objectNameFor(resolvedProject, ctx.taskId ?? 'deploy', `deployment-${deploymentId}.txt`);
        const buffer = Buffer.from(content, 'utf8');
        const store = new ArtifactStore();
        const result = await store.upload({ objectName, content: buffer, mimeType: 'text/plain' });
        await recordArtifactRow({
          taskId: ctx.taskId ?? null,
          projectId: resolvedProject,
          objectName,
          fileName: `deployment-${deploymentId}.txt`,
          mimeType: 'text/plain',
          sizeBytes: buffer.length,
          sha256: sha256Hex(buffer),
          kind: 'deployment',
        });
        const urlVal = await store.signedUrl(objectName);
        artifact = { objectName: result.objectName, url: urlVal };
        await db.update(deployments).set({ deploymentUrl: urlVal }).where(eq(deployments.id, deploymentId));
      } catch (err) {
        console.warn('[deploy_via_hook] deployment artifact failed:', err instanceof Error ? err.message : err);
      }

      return { success: ok, hookId, name: hook.name, platform: hook.platform, httpStatus: response.status, body: bodyText, artifact, deploymentId };
    },
  );

  store(
    'get_deploy_status',
    'Read the last recorded deploy-hook status (and current deployments row) for a hook or project.',
    z.object({
      hookId: z.string().optional().describe('Hook id'),
      projectId: z.string().optional().describe('Project id (returns latest deployment rows)'),
    }),
    false,
    async ({ hookId, projectId }) => {
      const out: Record<string, unknown> = {};
      if (hookId) {
        const [hook] = await db.select({
          id: deployHooks.id, projectId: deployHooks.projectId, name: deployHooks.name,
          platform: deployHooks.platform, active: deployHooks.active, lastStatus: deployHooks.lastStatus,
          updatedAt: deployHooks.updatedAt,
        }).from(deployHooks).where(eq(deployHooks.id, hookId)).limit(1);
        out.hook = hook ?? null;
      }
      const rows = projectId
        ? await db.select().from(deployments).where(eq(deployments.platform, 'hook')).orderBy(desc(deployments.deployedAt)).limit(10)
        : await db.select().from(deployments).where(eq(deployments.platform, 'hook')).orderBy(desc(deployments.deployedAt)).limit(10);
      out.recentDeployments = rows;
      return out;
    },
  );

  // ── Phase 3: durable workspace sync ─────────────────────────────────────

  store(
    'init_workspace',
    'Snapshot the current workspace tree (or a `path`-relative subtree) into the project\'s durable workspace prefix in the bucket.',
    z.object({
      worktreeName: z.string().optional().describe('Workspace name (default "main")'),
      path: z.string().optional().describe('Subtree to snapshot (default: whole workspaceRoot)'),
      projectId: z.string().optional().describe('Explicit project id'),
    }),
    false,
    async ({ worktreeName, path, projectId }, ctx) => {
      if (!isArtifactStoreConfigured()) throw new Error('APEX_ARTIFACT_BUCKET is not configured — workspace is not durable');
      const { projectId: resolvedProject } = await resolveProjectIdForContext(ctx, projectId);
      const worktree = worktreeName ?? 'main';
      const rootDir = path ? resolve(ctx.workspaceRoot, path) : ctx.workspaceRoot;
      const { snapshotWorkspace } = await import('./workspace-sync.js');
      return snapshotWorkspace({
        projectId: resolvedProject,
        worktree,
        rootDir,
        store: new ArtifactStore(),
      });
    },
  );

  store(
    'sync_workspace',
    'Pull the project\'s durable workspace prefix into a local temp directory (checksum-diff; unchanged files are skipped) and return the local path. Call this at the start of work that must survive instance recycle.',
    z.object({
      worktreeName: z.string().optional().describe('Workspace name (default "main")'),
      destDir: z.string().optional().describe('Absolute destination directory (defaults to <workspaceRoot>/.local/workspaces/<worktree>)'),
      projectId: z.string().optional().describe('Explicit project id'),
    }),
    false,
    async ({ worktreeName, destDir, projectId }, ctx) => {
      const { projectId: resolvedProject } = await resolveProjectIdForContext(ctx, projectId);
      const worktree = worktreeName ?? 'main';
      const dest = destDir ?? join(ctx.workspaceRoot, '.local', 'workspaces', `${resolvedProject}-${worktree}`);
      const { pullWorkspace } = await import('./workspace-sync.js');
      return pullWorkspace({
        projectId: resolvedProject,
        worktree,
        destDir: dest,
        store: new ArtifactStore(),
      });
    },
  );

  store(
    'push_workspace',
    'Push changed files from a local directory back to the project\'s durable workspace prefix (checksum-diff against the stored manifest; unchanged files skipped). Runs automatically before task completion.',
    z.object({
      worktreeName: z.string().optional().describe('Workspace name (default "main")'),
      sourceDir: z.string().optional().describe('Absolute source directory (defaults to the synced workspace dir)'),
      projectId: z.string().optional().describe('Explicit project id'),
    }),
    false,
    async ({ worktreeName, sourceDir, projectId }, ctx) => {
      const { projectId: resolvedProject } = await resolveProjectIdForContext(ctx, projectId);
      const worktree = worktreeName ?? 'main';
      const src = sourceDir ?? join(ctx.workspaceRoot, '.local', 'workspaces', `${resolvedProject}-${worktree}`);
      const { pushWorkspace } = await import('./workspace-sync.js');
      return pushWorkspace({
        projectId: resolvedProject,
        worktree,
        sourceDir: src,
        store: new ArtifactStore(),
      });
    },
  );

  // ── Phase 4: sandbox executor dispatch ──────────────────────────────────

  store(
    'run_executor_job',
    'Enqueue a heavy task to run in the sandbox executor (Cloud Run Jobs): claims happen outside the normal agent loop, ' +
      'the workspace syncs to GCS, and the run may take up to ~50 minutes (builds, renders, test suites). ' +
      'Returns the task id. Gated by default; auto-approvable in autonomy mode.',
    z.object({
      title: z.string().describe('Task title'),
      description: z.string().describe('Work instructions for the executor agent'),
      goalId: z.string().optional().describe('Goal this task belongs to'),
      parentTaskId: z.string().optional().describe('Parent task id'),
      projectId: z.string().optional().describe('Explicit project id (also embedded in task context)'),
      priority: z.number().optional().describe('Priority 1-10 (default 5)'),
    }),
    true,
    async ({ title, description, goalId, parentTaskId, projectId, priority }, ctx) => {
      const { projectId: resolvedProject } = await resolveProjectIdForContext(ctx, projectId);
      const id = randomUUID();
      const now = new Date();
      await db.insert(tasks).values({
        id,
        goalId: goalId ?? null,
        parentTaskId: parentTaskId ?? ctx.taskId ?? null,
        title,
        description,
        status: 'pending',
        priority: priority ?? 5,
        assignedAgentId: 'apex-executor-001',
        createdByAgentId: ctx.agentId ?? 'system-scheduler',
        createdAt: now,
        updatedAt: now,
        retryCount: 0,
        maxRetries: 1,
        context: {
          runtime: 'job',
          projectId: resolvedProject,
          worktree: 'main',
          dispatchSource: ctx.taskId ?? null,
        },
      });
      recordHeavyWorkRoutedToExecutor();
      return { taskId: id, runtime: 'job', assignedAgentId: 'apex-executor-001', note: 'dispatched to Cloud Run Jobs sandbox' };
    },
  );

  store(
    'get_executor_status',
    'Read the status of a runtime="job" task: claim state, dispatch record, and completion result.',
    z.object({
      taskId: z.string().describe('The executor task id returned by run_executor_job'),
    }),
    false,
    async ({ taskId }) => {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (!task) return { taskId, found: false };
      return {
        taskId,
        found: true,
        status: task.status,
        runtime: (task.context as Record<string, unknown> | null)?.runtime ?? 'process',
        errorMessage: task.errorMessage,
        result: task.result,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        leasedAt: task.leasedAt,
      };
    },
  );

  // ── Phase 5: workstreams ────────────────────────────────────────────────

  store(
    'create_workstream',
    'Create a long-lived workstream (deliverable unit) under a project: one repo / one deliverable family per workstream. ' +
      'work_generation plans batches of tasks from open workstreams. Gated by default; auto-approvable in autonomy mode.',
    z.object({
      projectId: z.string().describe('Project id'),
      name: z.string().describe('Workstream name (e.g. "marketing-site")'),
      goalId: z.string().optional().describe('Goal this workstream serves'),
      repoUrl: z.string().optional().describe('GitHub repository URL once created'),
      scheduleHint: z.string().optional().describe('Cron hint for work_generation (default "*/15 * * * *", floor 15 min)'),
      autonomyLevel: z.string().optional().describe('Autonomy level for this workstream (default "supervisor")'),
    }),
    true,
    async ({ projectId, name, goalId, repoUrl, scheduleHint, autonomyLevel }) => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        return { success: false, error: 'workstream name must be lowercase alphanumeric + dashes' };
      }
      const [existing] = await db.select({ id: workstreams.id }).from(workstreams)
        .where(and(eq(workstreams.projectId, projectId), ilike(workstreams.name, name))).limit(1);
      if (existing) {
        return { success: false, error: `Workstream ${projectId}/${name} already exists (${existing.id})` };
      }
      const id = randomUUID();
      const now = new Date();
      const hint = scheduleHint ?? '*/15 * * * *';
      await db.insert(workstreams).values({
        id,
        projectId,
        name,
        goalId: goalId ?? null,
        repoUrl: repoUrl ?? null,
        artifactPrefix: `projects/${projectId}/workspace/${name}/`,
        scheduleHint: hint,
        status: 'active',
        autonomyLevel: autonomyLevel ?? 'supervisor',
        createdAt: now,
        updatedAt: now,
      });
      return { success: true, id, projectId, name, artifactPrefix: `projects/${projectId}/workspace/${name}/`, scheduleHint: hint };
    },
  );

  store(
    'list_workstreams',
    'List workstreams by project with status, repo URL, artifact prefix, and schedule hint.',
    z.object({
      projectId: z.string().optional().describe('Filter by project'),
      status: z.string().optional().describe('Filter by status (active|paused|archived)'),
    }),
    false,
    async ({ projectId, status }) => {
      const filters = [];
      if (projectId) filters.push(eq(workstreams.projectId, projectId));
      if (status) filters.push(eq(workstreams.status, status));
      return db.select().from(workstreams)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(workstreams.updatedAt));
    },
  );

  return tools;
}

export { artifactBucketName, isArtifactStoreConfigured };