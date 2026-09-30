// ─── Shell job handlers (run_shell / run_sandbox) ──────────────────────────
//
// Ported straight from packages/core/src/tool-registry.ts's runShell /
// runInSandbox tool definitions (lines ~182-198 and ~715-783 there).
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { mkdir, readdir, writeFile, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { getWorkspaceRoot, resolveInWorkspace } from '@workspace/core/workspace-root';

const execAsync = promisify(exec);

const MAX_REPORTED_SANDBOX_FILES = 200;

async function listSandboxFiles(directory: string, prefix = '', limit = MAX_REPORTED_SANDBOX_FILES + 2): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (files.length >= limit) break;
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listSandboxFiles(
        join(directory, entry.name),
        relativePath,
        limit - files.length,
      ));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

export interface RunShellPayload {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

// NOTE: deliberately does not catch/normalize exec errors -- like the
// original, a failing command (non-zero exit, timeout) throws, and the
// caller (src/index.ts's per-job try/catch) reports the job as failed with
// that error message, exactly mirroring the old ToolRegistry.execute()'s
// catch-and-report-error behavior one level up.
export async function handleRunShell(payload: RunShellPayload): Promise<{ stdout: string; stderr: string }> {
  const root = getWorkspaceRoot();
  const execCwd = payload.cwd ? resolveInWorkspace(root, payload.cwd) : root;
  const { stdout, stderr } = await execAsync(payload.command, {
    cwd: execCwd,
    timeout: payload.timeoutMs ?? 30000,
  });
  return { stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 2000) };
}

export interface RunSandboxPayload {
  code: string;
  language: 'typescript' | 'javascript' | 'python' | 'shell';
  timeoutMs?: number;
}

export interface RunSandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxDir: string;
  discardedFiles: string[];
  discardedFilesTruncated: boolean;
  warning?: string;
}

export async function handleRunSandbox(payload: RunSandboxPayload): Promise<RunSandboxResult> {
  const root = getWorkspaceRoot();
  const uuid = randomUUID();
  const sandboxDir = resolveInWorkspace(root, join('.local', 'sandboxes', uuid));
  await mkdir(sandboxDir, { recursive: true });

  let fileName = 'script';
  let command = '';

  if (payload.language === 'typescript') {
    fileName = 'index.ts';
    command = 'npx tsx index.ts';
  } else if (payload.language === 'javascript') {
    fileName = 'index.js';
    command = 'node index.js';
  } else if (payload.language === 'python') {
    fileName = 'index.py';
    command = 'python index.py';
  } else if (payload.language === 'shell') {
    fileName = process.platform === 'win32' ? 'index.bat' : 'index.sh';
    command = process.platform === 'win32' ? 'index.bat' : 'bash index.sh';
  }

  const filePath = join(sandboxDir, fileName);
  await writeFile(filePath, payload.code, 'utf8');

  let executionResult: Omit<RunSandboxResult, 'discardedFiles' | 'discardedFilesTruncated' | 'warning'>;
  let discardedFiles: string[] = [];
  let discardedFilesTruncated = false;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: sandboxDir,
      timeout: payload.timeoutMs ?? 10000,
      env: {
        ...process.env,
        APEX_WORKSPACE_ROOT: root,
        WORKSPACE_ROOT: root,
      },
    });

    executionResult = {
      success: true,
      stdout: stdout.slice(0, 5000),
      stderr: stderr.slice(0, 5000),
      exitCode: 0,
      sandboxDir: uuid,
    };
  } catch (err: any) {
    executionResult = {
      success: false,
      stdout: err.stdout?.slice(0, 5000) ?? '',
      stderr: err.stderr?.slice(0, 5000) ?? err.message,
      exitCode: err.code ?? 1,
      sandboxDir: uuid,
    };
  } finally {
    try {
      const generatedFiles = (await listSandboxFiles(sandboxDir))
        .filter((path) => path !== fileName);
      discardedFilesTruncated = generatedFiles.length > MAX_REPORTED_SANDBOX_FILES;
      discardedFiles = generatedFiles
        .slice(0, MAX_REPORTED_SANDBOX_FILES)
        .sort();
    } catch (listErr) {
      console.error('Failed to list discarded sandbox files:', listErr);
    }
    try {
      await rm(sandboxDir, { recursive: true, force: true });
    } catch (cleanErr) {
      console.error('Failed to clean up sandbox directory:', cleanErr);
    }
  }
  return {
    ...executionResult,
    discardedFiles,
    discardedFilesTruncated,
    warning: discardedFiles.length > 0 || discardedFilesTruncated
      ? `Deleted ${discardedFiles.length}${discardedFilesTruncated ? '+' : ''} file(s) created in the temporary sandbox. Write deliverables with write_file or the durable artifact tools.`
      : undefined,
  };
}
