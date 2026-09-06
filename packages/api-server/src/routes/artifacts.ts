import { Router } from 'express';
import { randomUUID } from 'crypto';
import { db, artifacts } from '@workspace/db';
import { and, eq, desc } from 'drizzle-orm';
import { ArtifactStore } from '@workspace/core';

// ─── Artifact API Routes ─────────────────────────────────────────────────────
//
// Phase 1 of the autonomous-execution scheduler — mounted under /api (behind
// requireAdminAuth). Listing and the artifacts index are JSON; downloads
// stream the object bytes from the bucket.

export function createArtifactsRouter(): Router {
  const router = Router();

  // GET /api/artifacts?project=&task=&kind=&limit=
  router.get('/', async (req, res) => {
    try {
      const limit = Math.min(200, parseInt(String(req.query.limit ?? '50'), 10));
      const { project, task, kind } = req.query as Record<string, string | undefined>;
      const filters = [];
      if (project) filters.push(eq(artifacts.projectId, project));
      if (task) filters.push(eq(artifacts.taskId, task));
      if (kind) filters.push(eq(artifacts.kind, kind));
      const rows = await db.select().from(artifacts)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(artifacts.createdAt))
        .limit(limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/artifacts/:id/download — stream artifact bytes back.
  router.get('/:id/download', async (req, res) => {
    try {
      const [row] = await db.select().from(artifacts).where(eq(artifacts.id, req.params.id)).limit(1);
      if (!row) {
        res.status(404).json({ error: `Artifact ${req.params.id} not found` });
        return;
      }
      const store = new ArtifactStore();
      const content = await store.download(row.objectName);
      res.setHeader('Content-Type', row.mimeType ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${row.fileName.replace(/"/g, '')}"`);
      res.send(content);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/artifacts — admin upload. Body: { fileName, content (base64),
  // mimeType?, kind?, projectId?, taskId? }.
  router.post('/', async (req, res) => {
    try {
      const { fileName, content, mimeType, kind, projectId, taskId } = req.body as Record<string, unknown>;
      if (typeof fileName !== 'string' || !fileName) {
        res.status(400).json({ error: 'fileName is required' });
        return;
      }
      if (typeof content !== 'string' || !content) {
        res.status(400).json({ error: 'content (base64) is required' });
        return;
      }
      const store = new ArtifactStore();
      const buffer = Buffer.from(content, 'base64');
      const objectName = `projects/${typeof projectId === 'string' && projectId ? projectId : 'apex'}/${typeof taskId === 'string' && taskId ? taskId : 'manual'}/${fileName.replace(/^[/\\]+/, '')}`;
      const result = await store.upload({ objectName, content: buffer, mimeType: typeof mimeType === 'string' ? mimeType : undefined });
      const id = randomUUID();
      await db.insert(artifacts).values({
        id,
        taskId: typeof taskId === 'string' ? taskId : null,
        projectId: typeof projectId === 'string' ? projectId : null,
        objectName,
        fileName,
        mimeType: typeof mimeType === 'string' ? mimeType : null,
        sizeBytes: buffer.length,
        sha256: result.sha256,
        kind: typeof kind === 'string' ? kind : 'other',
        createdAt: new Date(),
      });
      res.status(201).json({ id, objectName, sizeBytes: buffer.length, sha256: result.sha256 });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}