// ─── Shell job handlers (run_shell / run_sandbox) ──────────────────────────
//
// Ported straight from packages/core/src/tool-registry.ts's runShell /
// runInSandbox tool definitions (lines ~182-198 and ~715-783 there).
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve, join } from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT ?? process.cwd();
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
  const root = workspaceRoot();
  const execCwd = payload.cwd ? resolve(root, payload.cwd) : root;
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
}

export async function handleRunSandbox(payload: RunSandboxPayload): Promise<RunSandboxResult> {
  const root = workspaceRoot();
  const uuid = randomUUID();
  const sandboxDir = resolve(root, '.local', 'sandboxes', uuid);
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

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: sandboxDir,
      timeout: payload.timeoutMs ?? 10000,
    });

    return {
      success: true,
      stdout: stdout.slice(0, 5000),
      stderr: stderr.slice(0, 5000),
      exitCode: 0,
      sandboxDir: uuid,
    };
  } catch (err: any) {
    return {
      success: false,
      stdout: err.stdout?.slice(0, 5000) ?? '',
      stderr: err.stderr?.slice(0, 5000) ?? err.message,
      exitCode: err.code ?? 1,
      sandboxDir: uuid,
    };
  } finally {
    try {
      await rm(sandboxDir, { recursive: true, force: true });
    } catch (cleanErr) {
      console.error('Failed to clean up sandbox directory:', cleanErr);
    }
  }
}
