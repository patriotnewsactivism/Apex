// ─── KnowledgeBridge ─────────────────────────────────────────────────────────
//
// Read-only bridge that exposes shared learnings across portfolio applications.

import { db, memories } from '@workspace/db';
import { desc, like } from 'drizzle-orm';

export class KnowledgeBridge {
  /** Retrieve cross-application shared insights (read-only by default). */
  async getSharedInsights(limit: number = 20) {
    const rows = await db
      .select()
      .from(memories)
      .where(like(memories.key, 'global:%'))
      .orderBy(desc(memories.createdAt))
      .limit(limit);

    return rows;
  }
}
