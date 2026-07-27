// ─── Git / GitHub job handlers (git_status / create_branch / push / create_pr) ─
//
// Ported straight from packages/core/src/tool-registry.ts's git_status /
// create_feature_branch / push_to_remote / create_pull_request tool
// definitions (lines ~1364-1470 there).
//
// Behavior difference from the original (deliberate): the old code called
// `execAsync(...)` for these four with NO explicit `cwd`, implicitly relying
// on the long-lived monolithic server process's cwd already being the repo
// root. This worker is a standalone process that may be launched from
// anywhere, so all git commands here explicitly pass `cwd: workspaceRoot()`
// -- same WORKSPACE_ROOT concept the fs handlers use -- instead of trusting
// process.cwd() to already be correct.
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT ?? process.cwd();
}

export interface GitStatusResult {
  branch: string;
  uncommittedChanges: string[];
  lastCommit: { hash: string; author: string; subject: string };
}

export async function handleGitStatus(): Promise<GitStatusResult | { error: string }> {
  const cwd = workspaceRoot();
  try {
    const [branch, status, lastCommit] = await Promise.all([
      execAsync('git rev-parse --abbrev-ref HEAD', { cwd }),
      execAsync('git status --short', { cwd }),
      execAsync('git log -1 --format=%H%n%an%n%s', { cwd }),
    ]);
    const [hash, author, subject] = lastCommit.stdout.trim().split('\n');
    return {
      branch: branch.stdout.trim(),
      uncommittedChanges: status.stdout.trim().split('\n').filter(Boolean),
      lastCommit: { hash, author, subject },
    };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}

export interface CreateBranchPayload {
  branchName: string;
}

export async function handleCreateBranch(
  payload: CreateBranchPayload,
): Promise<{ success: boolean; branchName?: string; error?: string }> {
  const cwd = workspaceRoot();
  try {
    await execAsync(`git checkout -b ${payload.branchName}`, { cwd });
    return { success: true, branchName: payload.branchName };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

export interface PushPayload {
  branch?: string;
  remote?: string;
}

export async function handlePush(
  payload: PushPayload,
): Promise<{ success: boolean; branch?: string; remote?: string; output?: string; error?: string }> {
  const cwd = workspaceRoot();
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { success: false, error: 'GITHUB_TOKEN is not configured in this environment' };
  }
  try {
    const targetBranch = payload.branch ?? (await execAsync('git rev-parse --abbrev-ref HEAD', { cwd })).stdout.trim();
    const remoteName = payload.remote ?? 'origin';
    const { stdout: remoteUrlRaw } = await execAsync(`git remote get-url ${remoteName}`, { cwd });
    const authedUrl = remoteUrlRaw.trim().replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
    const { stdout, stderr } = await execAsync(`git push ${authedUrl} ${targetBranch}`, { cwd });
    return { success: true, branch: targetBranch, remote: remoteName, output: (stdout || stderr).slice(0, 4000) };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

export interface CreatePrPayload {
  title: string;
  body: string;
  headBranch: string;
  baseBranch?: string;
  repo?: string;
}

export async function handleCreatePr(payload: CreatePrPayload): Promise<{
  success: boolean;
  prUrl?: string;
  number?: number;
  title?: string;
  headBranch?: string;
  baseBranch?: string;
  error?: string;
  details?: unknown;
}> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { success: false, error: 'GITHUB_TOKEN is not configured in this environment' };
  }
  const targetRepo = payload.repo ?? 'patriotnewsactivism/Apex';
  const res = await fetch(`https://api.github.com/repos/${targetRepo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: payload.title, body: payload.body, head: payload.headBranch, base: payload.baseBranch ?? 'main' }),
  });
  const data: any = await res.json();
  if (!res.ok) {
    return { success: false, error: data?.message || `GitHub API error ${res.status}`, details: data };
  }
  return {
    success: true,
    prUrl: data.html_url,
    number: data.number,
    title: payload.title,
    headBranch: payload.headBranch,
    baseBranch: payload.baseBranch ?? 'main',
  };
}
