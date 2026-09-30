// ─── Filesystem job handlers (read_file / write_file / list_dir) ──────────
//
// Ported straight from packages/core/src/tool-registry.ts's readFile /
// writeFile / listDir tool definitions (lines ~115-178 there). Same path
// resolution and workspace-containment behavior.
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { getWorkspaceRoot, pathWithin, resolveInWorkspace } from '@workspace/core/workspace-root';

export interface ReadFilePayload {
  path: string;
  startLine?: number;
  endLine?: number;
}

export async function handleReadFile(payload: ReadFilePayload): Promise<{ path: string; content: string }> {
  const root = getWorkspaceRoot();
  const abs = resolveInWorkspace(root, payload.path);
  const content = await fsReadFile(abs, 'utf8');
  if (payload.startLine !== undefined || payload.endLine !== undefined) {
    const lines = content.split('\n');
    const sl = (payload.startLine ?? 1) - 1;
    const el = payload.endLine ?? lines.length;
    return { path: abs, content: lines.slice(sl, el).join('\n') };
  }
  return { path: abs, content };
}

export interface WriteFilePayload {
  path: string;
  content: string;
  append?: boolean;
}

export async function handleWriteFile(payload: WriteFilePayload): Promise<{ path: string; written: boolean; durable: boolean }> {
  const root = getWorkspaceRoot();
  const abs = resolveInWorkspace(root, payload.path);
  await mkdir(dirname(abs), { recursive: true });
  if (payload.append && existsSync(abs)) {
    const existing = await fsReadFile(abs, 'utf8');
    await fsWriteFile(abs, existing + payload.content, 'utf8');
  } else {
    await fsWriteFile(abs, payload.content, 'utf8');
  }
  const artifactRoot = process.env.APEX_ARTIFACT_DIR?.trim();
  return {
    path: abs,
    written: true,
    durable: Boolean(artifactRoot && pathWithin(resolve(artifactRoot), abs)),
  };
}

export interface ListDirPayload {
  path?: string;
}

export async function handleListDir(payload: ListDirPayload): Promise<{
  path: string;
  entries: Array<{ name: string; type: 'dir' | 'file' }>;
}> {
  const root = getWorkspaceRoot();
  const abs = resolveInWorkspace(root, payload.path ?? '.');
  const entries = await readdir(abs, { withFileTypes: true });
  return {
    path: abs,
    entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : ('file' as const) })),
  };
}
