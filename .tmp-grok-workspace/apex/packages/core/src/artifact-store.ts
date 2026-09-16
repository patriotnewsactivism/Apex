// ─── Durable Artifact Store (GCS bucket) ─────────────────────────────────────
//
// Phase 1 of the autonomous-execution scheduler. The container filesystem is
// ephemeral; finished work (documents, builds, rendered sites, outputs) lives
// in a Google Cloud Storage bucket named by APEX_ARTIFACT_BUCKET.
//
// Object naming is uniformly `projects/<projectId>/<taskId>/<fileName>` (or
// `projects/<projectId>/workspace/<worktree>/*` for workspace snapshots), so
// listing by prefix is the only query primitive needed.
//
// The Google Cloud Storage client is loaded lazily via dynamic import: the
// package is a hard dependency, but no client is constructed (and no
// credentials touched) until a tool actually uses the bucket. When
// APEX_ARTIFACT_BUCKET is unset, every operation fails closed with an
// actionable error — never a silent no-op and never a fake success.
//
// On Cloud Run this authenticates through Workload Identity / the instance's
// default service account; locally it can use Application Default Credentials
// (`gcloud auth application-default login`).

import { createHash, randomUUID } from 'crypto';
import { readFile, stat, readdir } from 'fs/promises';
import { join, relative, sep } from 'path';

export const ARTIFACT_BUCKET_ENV = 'APEX_ARTIFACT_BUCKET';

export function artifactBucketName(): string | null {
  const name = (process.env[ARTIFACT_BUCKET_ENV] ?? '').trim();
  return name.length > 0 ? name : null;
}

export function isArtifactStoreConfigured(): boolean {
  return artifactBucketName() !== null;
}

/** Fail-closed guard every store operation calls before touching GCS. */
function requireBucket(operation: string): string {
  const bucket = artifactBucketName();
  if (!bucket) {
    throw new Error(
      `[ArtifactStore.${operation}] ${ARTIFACT_BUCKET_ENV} is not set. ` +
        'Create the bucket in the existing GCP project/region and configure the env var ' +
        '(see docs/PRODUCTION_OPERATIONS.md). Nothing was written.',
    );
  }
  return bucket;
}

export function objectNameFor(projectId: string, taskId: string, fileName: string): string {
  return `projects/${projectId}/${taskId}/${fileName.replace(/^[/\\]+/, '')}`;
}

export function workspaceObjectPrefix(projectId: string, worktreeName: string): string {
  return `projects/${projectId}/workspace/${worktreeName}/`;
}

export function sha256Hex(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

const MANIFEST_FILE = '.apex-manifest.json';

/**
 * Recursively compute a deterministic manifest of a directory:
 * `{ relPath: sha256 }` keyed by POSIX-style relative paths. The manifest file
 * itself is excluded so a sync round-trip cannot chase its own tail. Pure
 * filesystem I/O only — no bucket, no credentials — so the checksum
 * round-trip can be regression-tested without GCS.
 */
export async function computeDirectoryChecksums(
  rootDir: string,
  options?: { skipFile?: (relPath: string) => boolean },
): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  const skip = options?.skipFile ?? (() => false);

  async function walk(dirAbs: string): Promise<void> {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dirAbs, entry.name);
      const rel = relative(rootDir, abs).split(sep).join('/');
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        if (rel === MANIFEST_FILE || skip(rel)) continue;
        const content = await readFile(abs);
        checksums[rel] = sha256Hex(content);
      }
    }
  }

  await walk(rootDir);
  return checksums;
}

export interface UploadResult {
  objectName: string;
  sizeBytes: number;
  sha256: string;
  gsUri: string;
}

export interface ListEntry {
  objectName: string;
  sizeBytes: number;
  updatedAt?: string;
}

/**
 * Thin, fail-closed wrapper over @google-cloud/storage. Each method is
 * idempotent-safe (upload overwrites by object name) and every error is a
 * hard throw — callers decide whether the failure is fatal for their task.
 */
export class ArtifactStore {
  private clientPromise: Promise<import('@google-cloud/storage').Storage> | null = null;
  private readonly bucketName: string;

  constructor(bucketName?: string) {
    this.bucketName = bucketName ?? requireBucket('constructor');
  }

  private async client(): Promise<import('@google-cloud/storage').Storage> {
    if (!this.clientPromise) {
      this.clientPromise = import('@google-cloud/storage').then((mod) => new mod.Storage());
    }
    return this.clientPromise;
  }

  async upload(options: {
    objectName: string;
    content: Buffer;
    mimeType?: string;
    public?: boolean;
  }): Promise<UploadResult> {
    const { objectName, content, mimeType } = options;
    if (!objectName || objectName.startsWith('/')) {
      throw new Error(`[ArtifactStore.upload] invalid object name: ${objectName}`);
    }
    const storage = await this.client();
    const file = storage.bucket(this.bucketName).file(objectName);
    await file.save(content, {
      contentType: mimeType,
      resumable: false,
      metadata: { cacheControl: 'no-cache' },
    });
    if (options.public) {
      await file.makePublic();
    }
    return {
      objectName,
      sizeBytes: content.length,
      sha256: sha256Hex(content),
      gsUri: `gs://${this.bucketName}/${objectName}`,
    };
  }

  async uploadFromFile(options: {
    objectName: string;
    filePath: string;
    mimeType?: string;
    public?: boolean;
  }): Promise<UploadResult> {
    const content = await readFile(options.filePath);
    const sizeBytes = content.length;
    const result = await this.upload({
      objectName: options.objectName,
      content,
      mimeType: options.mimeType,
      public: options.public,
    });
    return { ...result, sizeBytes };
  }

  async download(objectName: string): Promise<Buffer> {
    if (!objectName) throw new Error('[ArtifactStore.download] objectName required');
    const storage = await this.client();
    const file = storage.bucket(this.bucketName).file(objectName);
    const [content] = await file.download();
    return content;
  }

  async list(prefix: string, maxResults = 500): Promise<ListEntry[]> {
    const storage = await this.client();
    const [files] = await storage.bucket(this.bucketName).getFiles({
      prefix,
      maxResults,
    });
    return files.map((file) => ({
      objectName: file.name,
      sizeBytes: Number(file.metadata.size ?? 0),
      updatedAt: file.metadata.updated as string | undefined,
    }));
  }

  /** Make one object publicly readable and return its shareable URL. */
  async makePublic(objectName: string): Promise<string> {
    const storage = await this.client();
    const file = storage.bucket(this.bucketName).file(objectName);
    await file.makePublic();
    return `https://storage.googleapis.com/${this.bucketName}/${objectName}`;
  }

  /** A short-lived authenticated URL; the artifact stays private. */
  async signedUrl(objectName: string, ttlMs = 15 * 60 * 1000): Promise<string> {
    const storage = await this.client();
    const file = storage.bucket(this.bucketName).file(objectName);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + ttlMs,
    });
    return url;
  }

  /** Liveness probe: does the bucket exist and is it reachable? */
  async ping(): Promise<{ ok: boolean; bucket: string; detail: string }> {
    try {
      const storage = await this.client();
      const [exists] = await storage.bucket(this.bucketName).exists();
      return {
        ok: exists,
        bucket: this.bucketName,
        detail: exists ? 'bucket exists and is reachable' : 'bucket does not exist (or credential lacks storage.buckets.get)',
      };
    } catch (err) {
      return {
        ok: false,
        bucket: this.bucketName,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** stat wrapper needed by the workspace sync layer (kept here for reuse). */
export async function fileSizeBytes(filePath: string): Promise<number> {
  const info = await stat(filePath);
  return info.size;
}

export function randomArtifactId(): string {
  return randomUUID();
}