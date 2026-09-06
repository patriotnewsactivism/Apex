// ─── Durable Workspace Sync (GCS-backed, checksum-diffed) ────────────────────
//
// Phase 3 of the autonomous-execution scheduler. The container filesystem is
// ephemeral, so durable project state lives in bucket prefixes:
//
//   projects/<projectId>/workspace/<worktreeName>/
//
// Each prefix carries a `.apex-manifest.json` of { relPath: sha256 } — the
// single source of truth for "what did we last have here". pullWorkspace
// downloads only missing/different files; pushWorkspace uploads only files
// whose checksum differs from the stored manifest; snapshotWorkspace writes
// the whole tree. The tools in durable-work-tools.ts and the sandbox executor
// (packages/executor) share these exact functions so they cannot drift.

import { existsSync } from 'fs';
import { mkdir, readFile, writeFile, stat } from 'fs/promises';
import { join, dirname } from 'path';
import {
  ArtifactStore,
  workspaceObjectPrefix,
  computeDirectoryChecksums,
  sha256Hex,
} from './artifact-store.js';

const MANIFEST_FILE = '.apex-manifest.json';

export interface WorkspaceSyncResult {
  projectId: string;
  worktree: string;
  prefix: string;
  destDir?: string;
  sourceDir?: string;
  downloaded?: number;
  pushed?: number;
  skipped: number;
  totalObjects?: number;
  changed: number;
}

export interface PullWorkspaceInput {
  projectId: string;
  worktree?: string;
  destDir: string;
  store: ArtifactStore;
}

/** Pull the workspace prefix into destDir; skip files whose local size already
 *  matches the remote object size. Returns a result description. */
export async function pullWorkspace(input: PullWorkspaceInput): Promise<WorkspaceSyncResult> {
  const { projectId, store, destDir } = input;
  const worktree = input.worktree ?? 'main';
  const prefix = workspaceObjectPrefix(projectId, worktree);
  const files = await store.list(prefix);
  await mkdir(destDir, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  for (const file of files) {
    const relPath = file.objectName.slice(prefix.length);
    if (!relPath || relPath === MANIFEST_FILE) continue;
    const abs = join(destDir, relPath);
    if (existsSync(abs)) {
      const info = await stat(abs);
      if (info.size === file.sizeBytes) {
        skipped++;
        continue;
      }
    }
    const content = await store.download(file.objectName);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    downloaded++;
  }

  return {
    projectId,
    worktree,
    prefix,
    destDir,
    downloaded,
    skipped,
    changed: downloaded,
    totalObjects: files.length,
  };
}

export interface PushWorkspaceInput {
  projectId: string;
  worktree?: string;
  sourceDir: string;
  store: ArtifactStore;
}

/** Upload only files whose checksum differs from the stored manifest, then
 *  rewrite the manifest. Unchanged files are skipped. */
export async function pushWorkspace(input: PushWorkspaceInput): Promise<WorkspaceSyncResult> {
  const { projectId, store, sourceDir } = input;
  const worktree = input.worktree ?? 'main';
  const prefix = workspaceObjectPrefix(projectId, worktree);
  const local = await computeDirectoryChecksums(sourceDir, { skipFile: (rel) => rel === MANIFEST_FILE });

  let remoteManifest: Record<string, string> = {};
  try {
    const manifestBuffer = await store.download(`${prefix}${MANIFEST_FILE}`);
    remoteManifest = JSON.parse(manifestBuffer.toString('utf8')) as Record<string, string>;
  } catch {
    remoteManifest = {};
  }

  let pushed = 0;
  let skipped = 0;
  for (const [relPath, hash] of Object.entries(local)) {
    if (remoteManifest[relPath] === hash) {
      skipped++;
      continue;
    }
    const content = await readFile(join(sourceDir, relPath));
    await store.upload({ objectName: `${prefix}${relPath}`, content });
    pushed++;
  }
  await store.upload({
    objectName: `${prefix}${MANIFEST_FILE}`,
    content: Buffer.from(JSON.stringify(local, null, 2), 'utf8'),
    mimeType: 'application/json',
  });

  return {
    projectId,
    worktree,
    prefix,
    sourceDir,
    pushed,
    skipped,
    changed: Object.keys(local).length - skipped,
  };
}

export interface SnapshotWorkspaceInput {
  projectId: string;
  worktree?: string;
  rootDir: string;
  store: ArtifactStore;
}

/** Full snapshot of a tree into the workspace prefix (init_workspace). */
export async function snapshotWorkspace(input: SnapshotWorkspaceInput): Promise<WorkspaceSyncResult> {
  const { projectId, store, rootDir } = input;
  const worktree = input.worktree ?? 'main';
  const prefix = workspaceObjectPrefix(projectId, worktree);
  const checksums = await computeDirectoryChecksums(rootDir, { skipFile: (rel) => rel === MANIFEST_FILE });

  let uploaded = 0;
  for (const [relPath] of Object.entries(checksums)) {
    const content = await readFile(join(rootDir, relPath));
    await store.upload({ objectName: `${prefix}${relPath}`, content });
    uploaded++;
  }
  await store.upload({
    objectName: `${prefix}${MANIFEST_FILE}`,
    content: Buffer.from(JSON.stringify(checksums, null, 2), 'utf8'),
    mimeType: 'application/json',
  });

  return {
    projectId,
    worktree,
    prefix,
    sourceDir: rootDir,
    pushed: uploaded,
    skipped: 0,
    changed: uploaded,
  };
}

/** sha256 of the given file contents — small helper for tool callers. */
export async function checksumFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return sha256Hex(content);
}