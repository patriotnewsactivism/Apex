// ─── Sandbox Executor entrypoint (Cloud Run Jobs) ────────────────────────────
//
// Phase 4 of the autonomous-execution scheduler. Container image =
// same immutable SHA-tagged image as the control plane, new Cloud Run Job
// resource. Run:
//
//   pnpm --filter @workspace/executor run start:executor <taskId>
//
// Flow:
//   1. claim the task by id (guarded lease) — if unclaimable, exit 0
//      (another dispatcher already won; this container idles out);
//   2. sync the project's GCS workspace prefix into a local sandbox dir
//      (best-effort — the work itself is the durable record either way);
//   3. run the instrumented BaseAgent executeTask loop with EXECUTOR_MAX_TURNS
//      and the job-runtime hard timeout (default 55 min);
//   4. push the workspace back (checksum-diff) and exit with the task's
//      success/failure as the container exit code.
//
// The task's complete()/fail() are performed by executeTask itself; the
// executor only reports the outcome.

import { resolve } from 'path';
import { pathToFileURL } from 'url';
import {
  BaseAgent,
  TaskQueue,
  getDefaultLLMConfig,
  isArtifactStoreConfigured,
  pullWorkspace,
  pushWorkspace,
  type AgentConfig,
  type LLMClientConfig,
} from '@workspace/core';
import { ArtifactStore } from '@workspace/core';
import { db, tasks } from '@workspace/db';
import { eq } from 'drizzle-orm';

const EXECUTOR_AGENT_ID = 'apex-executor-001';

const EXECUTOR_SYSTEM_PROMPT = `You are APEX's sandbox executor: a focused build-and-execute agent that runs inside an isolated Cloud Run Job.

Your job is to DO the work described in the task: create real files, run real builds, render real output. The container filesystem is temporary; anything that must survive goes to the durable workspace (sync_workspace / push_workspace) or the artifact bucket (store_artifact).

Rules:
- Execute, then verify. Building an artifact and never checking it works is not completion.
- publish finished documents, builds, rendered sites, and test reports via store_artifact (kind: document|build|code|deployment|other).
- push durable project files back with push_workspace before finishing.
- Heavy compile/test/build activity is normal here — you have up to ~50 minutes.
- Non-completion is the one unforgivable failure: describing what you would do is not doing it.
- A human may never answer approvals inside this sandbox; if a gated tool is genuinely required and the project is not autonomous for it, state that plainly in your final report and finish what you CAN do.`;

export class ExecutorAgent extends BaseAgent {
  constructor(config: AgentConfig) {
    super(config);
  }

  /** Public wrapper around the protected executeTask loop for single-task runs. */
  async runTask(
    taskId: string,
    title: string,
    description: string,
    context: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const result = await this.executeTask(taskId, title, description, context);
      return { success: result.success, output: result.output, error: result.error };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}

export function executorTools(): string[] {
  const tools = [
    // core filesystem / execution
    'readFile',
    'writeFile',
    'listDir',
    'webSearch',
    'runInSandbox',
    'health_check',
    'get_system_status',
    // CI runners (isolated checkouts)
    'run_tests',
    'run_lint',
    'build_project',
    'git_status',
    'create_feature_branch',
    // durable artifact store (Phase 1)
    'store_artifact',
    'read_artifact',
    'list_artifacts',
    'publish_artifact',
    // durable workspace (Phase 3)
    'init_workspace',
    'sync_workspace',
    'push_workspace',
    // deploy hooks & repos (Phase 2; gated — project autonomy decides)
    'create_github_repo',
    'register_deploy_hook',
    'list_deploy_hooks',
    'deploy_via_hook',
    'get_deploy_status',
    // workstreams & the scheduler (Phase 5)
    'list_workstreams',
    'create_workstream',
    'list_scheduled_tasks',
    'get_job_history',
    'get_executor_status',
    // orchestration (internal, auto-approved)
    'escalate_to_human',
    'get_delegation_status',
    'get_task_details',
    'list_goals',
    'update_goal_status',
  ];
  // runShell stays OFF by default inside the sandbox. Operators may enable it
  // deliberately with EXECUTOR_ALLOW_RUNSHELL=true — the approval gate still
  // applies to every runShell call; only autonomy-mode projects can auto-approve it.
  if (['1', 'true', 'on', 'yes'].includes((process.env.EXECUTOR_ALLOW_RUNSHELL ?? '').trim().toLowerCase())) {
    tools.push('runShell');
  }
  return tools;
}

export function executorMaxTurns(): number {
  const raw = Number(process.env.EXECUTOR_MAX_TURNS ?? 40);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 40;
}

export function resolveTaskProjectId(context: Record<string, unknown> | null): string {
  const projectId = (context?.projectId as string | undefined) ?? process.env.APEX_EXECUTOR_DEFAULT_PROJECT;
  return projectId ?? 'apex';
}

export async function main(argv: string[]): Promise<number> {
  const taskId = argv[2];
  if (!taskId) {
    console.error('[executor] usage: start:executor <taskId>');
    return 1;
  }
  console.log(`[executor] starting sandbox run for task ${taskId}`);

  const queue = new TaskQueue(EXECUTOR_AGENT_ID);
  const claimed = await queue.claimById(taskId);
  if (!claimed) {
    console.log(`[executor] task ${taskId} is not claimable (already claimed/terminal); exiting 0`);
    return 0;
  }
  console.log(`[executor] claimed task ${taskId}: "${claimed.title}"`);

  const context = (claimed.context ?? {}) as Record<string, unknown>;
  const projectId = resolveTaskProjectId(context);
  const worktree = (context.worktree as string | undefined) ?? 'main';

  // ── Step 2: sync the durable workspace (best-effort) ─────────────────────
  let sandboxDir = resolve(process.env.WORKSPACE_ROOT ?? process.cwd(), '.local', 'executor', taskId);
  if (isArtifactStoreConfigured()) {
    try {
      const result = await pullWorkspace({
        projectId,
        worktree,
        destDir: sandboxDir,
        store: new ArtifactStore(),
      });
      sandboxDir = result.destDir ?? sandboxDir;
      console.log(`[executor] workspace synced: ${result.downloaded} downloaded, ${result.skipped} skipped`);
    } catch (err) {
      console.warn('[executor] workspace pull failed (continuing with empty sandbox):', err instanceof Error ? err.message : err);
    }
  }

  // ── Step 3: the agent loop ───────────────────────────────────────────────
  const llm: LLMClientConfig = getDefaultLLMConfig('LEAD_DEV');
  const agent = new ExecutorAgent({
    id: EXECUTOR_AGENT_ID,
    name: 'APEX Executor',
    role: 'LEAD_DEV',
    tier: 3,
    parentId: 'apex-cto-001',
    systemPrompt: process.env.EXECUTOR_SYSTEM_PROMPT ?? EXECUTOR_SYSTEM_PROMPT,
    llm,
    tools: executorTools(),
    maxIterations: executorMaxTurns(),
    approvalRequired: false,
    concurrency: 1,
  });

  const completed = await agent.runTask(
    taskId,
    claimed.title,
    claimed.description,
    { ...context, runtime: 'job', executorRun: true },
  );

  // ── Step 4: push the workspace back (best-effort) ────────────────────────
  if (isArtifactStoreConfigured()) {
    try {
      const result = await pushWorkspace({
        projectId,
        worktree,
        sourceDir: sandboxDir,
        store: new ArtifactStore(),
      });
      console.log(`[executor] workspace pushed: ${result.pushed} changed, ${result.skipped} unchanged`);
    } catch (err) {
      console.warn('[executor] workspace push failed:', err instanceof Error ? err.message : err);
    }
  }

  // Re-read the task row: executeTask performs complete()/fail() itself.
  const [finalRow] = await db.select({ status: tasks.status, result: tasks.result, errorMessage: tasks.errorMessage })
    .from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const ok = finalRow?.status === 'done' || completed.success;
  console.log(
    `[executor] task ${taskId} final status=${finalRow?.status ?? 'unknown'} success=${ok} ` +
      `error=${finalRow?.errorMessage ?? completed.error ?? ''}`,
  );
  return ok ? 0 : 1;
}

// Local run support: `tsx src/main.ts <taskId>` — guard so importing this
// module from dispatch.ts does not trigger a run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv).then((code) => process.exit(code)).catch((err) => {
    console.error('[executor] FATAL:', err);
    process.exit(1);
  });
}