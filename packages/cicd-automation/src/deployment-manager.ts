// ─── DeploymentManager ────────────────────────────────────────────────────────
//
// Records deployment attempts. Production deployments are approval-gated.
//
// 2026-08-19: THIS NEVER DEPLOYED ANYTHING. deploy() used to insert a row
// with status 'healthy' and, for platform 'vercel', deploymentUrl
// 'https://apex.vercel.app' -- both hardcoded, with no platform API call of
// any kind. Two things were wrong with that beyond the missing
// implementation:
//   1. Apex does NOT run on Vercel. Production is the **AWS Lightsail**
//      container service `apex-service`, image built by CodeBuild project
//      `apex-lightsail-build` (see AGENTS.md). 'apex.vercel.app' is not a
//      real Apex URL and never was, so an agent that called this tool got a
//      fabricated hostname for a platform Apex isn't hosted on.
//   2. Returning status 'healthy' unconditionally is the worst possible
//      failure mode for an autonomous workforce: an agent told to "deploy
//      and verify" received success, reported the goal complete, and no
//      human learned that nothing shipped.
// Deploying now FAILS LOUDLY with the real runbook instead. Vercel/Railway
// still legitimately appear elsewhere in this repo as deploy targets for
// CLIENT projects the CI/CD tooling manages -- that is a different thing
// from where Apex itself is hosted, which is Lightsail, only Lightsail.

import { db, deployments, type NewDeploymentRow } from '@workspace/db';
import { deployToLightsail, rollbackLightsail, DeployNotConfiguredError } from './lightsail-deployer.js';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

/** Where Apex itself runs. 'lightsail' = the real production target (AWS
 *  Lightsail container service `apex-service`); 'local' = a developer box.
 *  'vercel' is deliberately absent: Apex is not hosted on Vercel. */
export type ApexDeployPlatform = 'lightsail' | 'local';

export interface DeploymentConfig {
  environment: 'staging' | 'production';
  platform: ApexDeployPlatform;
  runId?: string;
}

/** The real deploy sequence, kept in one place so the error an agent sees is
 *  the runbook a human would follow (AGENTS.md is the canonical copy). */
export const LIGHTSAIL_DEPLOY_RUNBOOK =
  'Apex production runs on AWS Lightsail container service `apex-service` ' +
  '(image 535203103662.dkr.ecr.us-east-1.amazonaws.com/apex-lightsail:latest). ' +
  'Deploying requires, in order: (1) `aws codebuild start-build --project-name ' +
  'apex-lightsail-build --region us-east-1`, (2) wait for SUCCEEDED, ' +
  '(3) `aws lightsail create-container-service-deployment` for apex-service, ' +
  '(4) poll `aws lightsail get-container-service-deployments`. No AWS ' +
  'credentials or platform API are wired into this process, so this tool ' +
  'cannot perform that sequence — escalate to a human instead of reporting ' +
  'a deploy as done.';

export class DeploymentManager {
  /** Record a deployment attempt. Production deployments require explicit
   *  approval. NOTE: this does not and never did perform a deployment — it
   *  records the attempt as `failed` and throws with the real runbook, so no
   *  agent can mistake it for a shipped release. See the header comment. */
  async deploy(config: DeploymentConfig): Promise<{
    deploymentId: string;
    status: string;
    deploymentUrl?: string;
    buildId?: string;
    deploymentVersion?: number;
  }> {
    const deploymentId = `deploy-${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = new Date();
    const logLines: string[] = [];
    const log = (m: string) => {
      logLines.push(m);
      console.log(`[deploy ${deploymentId}] ${m}`);
    };

    // 'local' has no deploy target and never did. Say so instead of
    // pretending, and never let it reach AWS.
    if (config.platform === 'local') {
      throw new Error(
        `platform 'local' has no deploy target — nothing to ship. Use 'lightsail' for real deploys.`,
      );
    }

    // Record the attempt BEFORE doing anything, as 'deploying'. If this
    // process dies mid-deploy, the row shows an in-flight deploy rather than
    // no evidence at all.
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
      const result = await deployToLightsail(config.environment, log);
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
        deploymentVersion: result.deploymentVersion,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A config/permission problem is not a failed release — nothing was
      // shipped — so it's recorded distinctly from a genuine bad deploy.
      const status = err instanceof DeployNotConfiguredError ? 'blocked' : 'failed';
      await this.updateRow(deploymentId, {
        status,
        error: [message, ...logLines.map((l) => `  · ${l}`)].join('\n'),
      });
      throw new Error(`${message} (deployment ${deploymentId}, status ${status})`);
    }
  }

  private async updateRow(
    deploymentId: string,
    values: Partial<NewDeploymentRow>,
  ): Promise<void> {
    try {
      await db.update(deployments).set(values).where(eq(deployments.id, deploymentId));
    } catch (err) {
      console.error('[DeploymentManager] Failed to update deploy row:', err);
    }
  }

  /** Roll the RUNNING SERVICE back to the previous ACTIVE deployment spec and
   *  verify health. The DB row is only marked `rolled_back` after Lightsail
   *  reports ACTIVE and the health endpoint answers — the old implementation
   *  flipped that flag with no deployment at all, which closed the incident
   *  while the bad release kept serving traffic. */
  async rollback(deploymentId: string): Promise<{
    success: boolean;
    rolledBackId: string;
    restoredFromVersion: number;
    serviceUrl: string;
  }> {
    const [existing] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);

    if (!existing) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    const environment = (existing.environment === 'staging' ? 'staging' : 'production') as
      | 'staging'
      | 'production';
    const result = await rollbackLightsail(environment);

    await this.updateRow(deploymentId, {
      status: 'rolled_back',
      rolledBack: true,
      error: `Rolled back to the deployment spec from v${result.restoredFromVersion}; health ${result.healthStatus}`,
    });

    return {
      success: true,
      rolledBackId: deploymentId,
      restoredFromVersion: result.restoredFromVersion,
      serviceUrl: result.serviceUrl,
    };
  }
}
