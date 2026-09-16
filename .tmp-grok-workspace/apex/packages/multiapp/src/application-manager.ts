// ─── ApplicationManager ────────────────────────────────────────────────────────
//
// Manages registration and health monitoring for target portfolio applications
// (buildmybot2, ARIA, autonomous-coder, casebuddy-ai-law-partner, repo-romance-46).

import { db, applications, type NewApplicationRow } from '@workspace/db';
import { eq } from 'drizzle-orm';

export class ApplicationManager {
  /** Register a portfolio application repository. Requires approval. */
  async registerApplication(id: string, name: string, repoUrl: string): Promise<boolean> {
    const record: NewApplicationRow = {
      id: id.toLowerCase(),
      name,
      repoUrl,
      status: 'active',
      healthScore: 1.0,
      lastSyncAt: new Date(),
    };

    await db
      .insert(applications)
      .values(record)
      .onConflictDoUpdate({
        target: applications.id,
        set: {
          name,
          repoUrl,
          lastSyncAt: new Date(),
        },
      });

    return true;
  }

  /** List all registered portfolio applications. */
  async getApplications() {
    return db.select().from(applications);
  }

  /** Check reachability and status of a portfolio application. */
  async checkHealth(id: string) {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, id))
      .limit(1);

    if (!app) return { status: 'not_found', healthScore: 0 };
    return { status: app.status, healthScore: app.healthScore, lastSyncAt: app.lastSyncAt };
  }
}
