// ─── Job dispatch map ───────────────────────────────────────────────────────
//
// One handler per externalJobs.jobType (convex/schema.ts's JOB_TYPE union,
// 15 values). Each handler takes the job's `payload` (exactly what
// toolRegistry.ts's buildJobPayload() built on the Convex side) and returns
// the raw value that becomes reportJobResult's `result` -- which agentLoop.ts
// wraps as `{ success: true, result }` into the conversation history. A
// handler that throws is caught by src/index.ts's per-job try/catch and
// reported as `{ success: false, error: err.message }` instead.
import type { Doc } from '@workspace/convex-backend/dataModel';

import { handleReadFile, handleWriteFile, handleListDir } from './fs.js';
import { handleRunShell, handleRunSandbox } from './shell.js';
import { handleGitStatus, handleCreateBranch, handlePush, handleCreatePr } from './git.js';
import { handleTest, handleLint, handleBuild } from './ci.js';
import { handleDeploy, handleRollback } from './deploy.js';
import { handleBrowserCheck } from './browser.js';

export type JobType = Doc<'externalJobs'>['jobType'];

export type JobHandler = (payload: any) => Promise<unknown>;

export const jobHandlers: Record<JobType, JobHandler> = {
  test: () => handleTest(),
  lint: () => handleLint(),
  build: () => handleBuild(),
  deploy: (payload) => handleDeploy(payload),
  rollback: (payload) => handleRollback(payload),
  git_status: () => handleGitStatus(),
  create_branch: (payload) => handleCreateBranch(payload),
  push: (payload) => handlePush(payload),
  create_pr: (payload) => handleCreatePr(payload),
  run_shell: (payload) => handleRunShell(payload),
  read_file: (payload) => handleReadFile(payload),
  write_file: (payload) => handleWriteFile(payload),
  list_dir: (payload) => handleListDir(payload),
  run_sandbox: (payload) => handleRunSandbox(payload),
  browser_check: (payload) => handleBrowserCheck(payload),
};
