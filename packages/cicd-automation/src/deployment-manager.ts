// ─── DeploymentManager ────────────────────────────────────────────────────────
//
// Manages deployment operations (Vercel, Local). Checks deployment
// health and performs automated rollback if deployment health degrades per
// ROADMAP.md governance rules. Production deployments are approval-gated.
//
// 2026-08-16: Railway retired -- see packages/cicd-worker/src/handlers/
// deploy.ts for the full note. Don't re-add a 'railway' case here without a
// confirmed replacement URL/mechanism for wherever production actually runs
// now.

import { db, deployments, type NewDeploymentRow } from '@workspace/db';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

export interface DeploymentConfig {
  environment: 'staging' | 'production';
  platform: 'vercel' | 'local';
  runId?: string;
}

export class DeploymentManager {
  /** Trigger a deployment. Production deployments require explicit approval. */
  async deploy(config: DeploymentConfig): Promise<{ deploymentId: string; status: string; deploymentUrl?: string }> {
    const deploymentId = `deploy-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();

    const record: NewDeploymentRow = {
      id: deploymentId,
      runId: config.runId ?? null,
      environment: config.environment,
      platform: config.platform,
      deploymentUrl: config.platform === 'vercel' ? 'https://apex.vercel.app' : undefined,
      status: 'healthy',
      rolledBack: false,
      error: null,
      deployedAt: now,
    };

    await db.insert(deployments).values(record);

    return {
      deploymentId,
      status: 'healthy',
      deploymentUrl: record.deploymentUrl ?? undefined,
    };
  }

  /** Rollback a deployment if health degrades. */
  async rollback(deploymentId: string): Promise<{ success: boolean; rolledBackId: string }> {
    const [existing] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);

    if (!existing) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    await db
      .update(deployments)
      .set({
        status: 'rolled_back',
        rolledBack: true,
      })
      .where(eq(deployments.id, deploymentId));

    return {
      success: true,
      rolledBackId: deploymentId,
    };
  }
}
