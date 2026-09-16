// ─── DeploymentManager ──────────────────────────────────────────────────────
//
// Records and executes APEX deployment attempts. Production deployments remain
// approval-gated by the tool layer. APEX itself runs on Google Cloud Run.
// Client projects may still use other deployment platforms elsewhere in the
// broader CI/CD tooling; that is separate from where the APEX control plane is
// hosted.
//
// The manager never fabricates success. It records the attempt as `deploying`,
// calls the real Cloud Run deployment path, verifies the live health endpoint,
// and only then records `healthy`. Missing Google auth/configuration is recorded
// as `blocked`, not as a failed release, because nothing was shipped.

import { db, deployments, type NewDeploymentRow } from '@workspace/db';
import { deployToCloudRun, rollbackCloudRun, DeployNotConfiguredError } from './cloud-run-deployer.js';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

/** Where APEX itself runs. `cloud-run` is the production target; `local` is a
 * developer environment with no remote deployment target. */
export type ApexDeployPlatform = 'cloud-run' | 'local';

export interface DeploymentConfig {
  environment: 'staging' | 'production';
  platform: ApexDeployPlatform;
  runId?: string;
  /** Optional exact commit that must be the clean source and become live. */
  expectSha?: string;
}

export const CLOUD_RUN_DEPLOY_RUNBOOK =
  'APEX production runs on the existing Google Cloud Run service mapped to ' +
  '`https://apex.donmatthews.live`. Deployment requires an authenticated gcloud ' +
  'environment plus APEX_GCP_PROJECT_ID, APEX_CLOUD_RUN_REGION, and ' +
  'APEX_CLOUD_RUN_SERVICE. The deployer first describes that exact existing ' +
  'service, builds a clean Git commit through Google Cloud Build using ' +
  'cloudbuild.apex.yaml, tags the image with the commit SHA, updates the existing ' +
  'service image with `gcloud run services update`, waits for Ready, and verifies ' +
  '/health. It never creates a new Cloud Run service or reconstructs its env/secrets.';

export class DeploymentManager {
  async deploy(config: DeploymentConfig): Promise<{
    deploymentId: string;
    status: string;
    deploymentUrl?: string;
    buildId?: string;
    revisionName?: string;
  }> {
    const deploymentId = `deploy-${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = new Date();
    const logLines: string[] = [];
    const log = (message: string) => {
      logLines.push(message);
      console.log(`[deploy ${deploymentId}] ${message}`);
    };

    if (config.platform === 'local') {
      throw new Error(`platform 'local' has no remote deploy target — use 'cloud-run' for APEX production.`);
    }

    const record: NewDeploymentRow = {
      id: deploymentId,
      runId: config.runId ?? null,
      environment: config.environment,
      platform: config.platform,
      deploymentUrl: null,
      status: 'deploying',
      rolledBack: false,
      error: null,
      deployedAt: startedAt,
    };
    try {
      await db.insert(deployments).values(record);
    } catch (err) {
      console.error('[DeploymentManager] Failed to record deploy attempt:', err);
    }

    try {
      const result = await deployToCloudRun(config.environment, log, config.expectSha);
      await this.updateRow(deploymentId, {
        status: 'healthy',
        deploymentUrl: result.serviceUrl,
        error: null,
      });
      return {
        deploymentId,
        status: 'healthy',
        deploymentUrl: result.serviceUrl,
        buildId: result.buildId,
        revisionName: result.revisionName,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof DeployNotConfiguredError ? 'blocked' : 'failed';
      await this.updateRow(deploymentId, {
        status,
        error: [message, ...logLines.map((line) => `  · ${line}`)].join('\n'),
      });
      throw new Error(`${message} (deployment ${deploymentId}, status ${status})`);
    }
  }

  private async updateRow(deploymentId: string, values: Partial<NewDeploymentRow>): Promise<void> {
    try {
      await db.update(deployments).set(values).where(eq(deployments.id, deploymentId));
    } catch (err) {
      console.error('[DeploymentManager] Failed to update deploy row:', err);
    }
  }

  /** Route traffic back to the previous Cloud Run revision and verify health. */
  async rollback(deploymentId: string): Promise<{
    success: boolean;
    rolledBackId: string;
    restoredRevision: string;
    serviceUrl: string;
  }> {
    const [existing] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);

    if (!existing) throw new Error(`Deployment ${deploymentId} not found`);

    const environment = (existing.environment === 'staging' ? 'staging' : 'production') as
      | 'staging'
      | 'production';
    const result = await rollbackCloudRun(environment);

    await this.updateRow(deploymentId, {
      status: 'rolled_back',
      rolledBack: true,
      error: `Traffic rolled back to Cloud Run revision ${result.restoredRevision}; health ${result.healthStatus}`,
    });

    return {
      success: true,
      rolledBackId: deploymentId,
      restoredRevision: result.restoredRevision,
      serviceUrl: result.serviceUrl,
    };
  }
}
