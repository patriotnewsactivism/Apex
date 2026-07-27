// ─── Filesystem job handlers (read_file / write_file / list_dir) ──────────
//
// Ported straight from packages/core/src/tool-registry.ts's readFile /
// writeFile / listDir tool definitions (lines ~115-178 there). Same path
// resolution and the same workspace-containment check, including its known
// limitation: `abs.startsWith(root)` is a plain string prefix check, so e.g.
// root=/home/user and abs=/home/user2 would incorrectly pass. That's the
// pre-existing behavior in the original tool, not something introduced or
// fixed here — porting faithfully per the migration plan.
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, relative, dirname } from 'path';

/** Real, persistent checkout this worker treats as "the workspace" for file ops. Mirrors WORKSPACE_ROOT from the old @workspace/core (base-agent.ts:290). */
function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT ?? process.cwd();
}

export interface ReadFilePayload {
  path: string;
  startLine?: number;
  endLine?: number;
}

export async function handleReadFile(payload: ReadFilePayload): Promise<string> {
  const root = workspaceRoot();
  const abs = resolve(root, payload.path);
  if (!abs.startsWith(root)) throw new Error('Path outside workspace');
  const content = await fsReadFile(abs, 'utf8');
  if (payload.startLine !== undefined || payload.endLine !== undefined) {
    const lines = content.split('\n');
    const sl = (payload.startLine ?? 1) - 1;
    const el = payload.endLine ?? lines.length;
    return lines.slice(sl, el).join('\n');
  }
  return content;
}

export interface WriteFilePayload {
  path: string;
  content: string;
  append?: boolean;
}

export async function handleWriteFile(payload: WriteFilePayload): Promise<{ path: string; written: boolean }> {
  const root = workspaceRoot();
  const abs = resolve(root, payload.path);
  if (!abs.startsWith(root)) throw new Error('Path outside workspace');
  await mkdir(dirname(abs), { recursive: true });
  if (payload.append && existsSync(abs)) {
    const existing = await fsReadFile(abs, 'utf8');
    await fsWriteFile(abs, existing + payload.content, 'utf8');
  } else {
    await fsWriteFile(abs, payload.content, 'utf8');
  }
  return { path: relative(root, abs), written: true };
}

export interface ListDirPayload {
  path?: string;
}

export async function handleListDir(payload: ListDirPayload): Promise<Array<{ name: string; type: 'dir' | 'file' }>> {
  const root = workspaceRoot();
  const abs = resolve(root, payload.path ?? '.');
  if (!abs.startsWith(root)) throw new Error('Path outside workspace');
  const entries = await readdir(abs, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : ('file' as const) }));
}
