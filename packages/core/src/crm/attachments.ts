/**
 * Swappable attachment storage. The default writes through the artifact store
 * (APEX_ARTIFACT_BUCKET or APEX_ARTIFACT_DIR). Tests can pass an in-memory store.
 */
export interface StoredAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
}

export interface AttachmentStorage {
  put(input: { filename: string; contentType: string; bytes: Buffer }): Promise<StoredAttachment>;
}

export function memoryAttachmentStorage(): AttachmentStorage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(input) {
      const storageKey = `memory/${Date.now()}-${input.filename.replace(/[^\w.-]+/g, '_')}`;
      objects.set(storageKey, input.bytes);
      return {
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.bytes.length,
        storageKey,
      };
    },
  };
}

export function artifactAttachmentStorage(): AttachmentStorage {
  return {
    async put(input) {
      const safeName = input.filename.replace(/[^\w.-]+/g, '_') || 'attachment';
      const storageKey = `crm/inbound/${Date.now()}-${safeName}`;
      try {
        const { ArtifactStore } = await import('../artifact-store.js');
        const store = new ArtifactStore();
        await store.upload({
          objectName: storageKey,
          content: input.bytes,
          mimeType: input.contentType,
        });
        return {
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.bytes.length,
          storageKey,
        };
      } catch (error) {
        console.warn(
          '[crm] attachment storage unavailable (APEX_ARTIFACT_BUCKET / APEX_ARTIFACT_DIR):',
          error instanceof Error ? error.message : String(error),
        );
        return {
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.bytes.length,
          storageKey: `unconfigured/${safeName}`,
        };
      }
    },
  };
}
