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
  async deploy(config: DeploymentConfig): Promise<never> {
    const deploymentId = `deploy-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    const error =
      `Automated deploy is not implemented. ${LIGHTSAIL_DEPLOY_RUNBOOK}`;

    const record: NewDeploymentRow = {
      id: deploymentId,
      runId: config.runId ?? null,
      environment: config.environment,
      platform: config.platform,
      // No URL is invented. The only real Apex production hostname is the
      // Lightsail service URL that apex.donmatthews.live points at, and this
      // code has no way to look it up without AWS credentials.
      deploymentUrl: undefined,
      status: 'failed',
      rolledBack: false,
      error,
      deployedAt: now,
    };

    // Best effort: the audit row matters, but a DB hiccup must not mask the
    // real message below.
    try {
      await db.insert(deployments).values(record);
    } catch (err) {
      console.error('[DeploymentManager] Failed to record deploy attempt:', err);
    }

    throw new Error(`${error} (attempt recorded as ${deploymentId})`);
  }

  /** Rollback a deployment. Also not implemented: this only ever flipped the
   *  `rolled_back` flag on a DB row, which is worse than failing — it ends
   *  the incident in the agent's mind (and in the dashboard) while production
   *  is still serving the bad release. Throws before mutating anything. */
  async rollback(deploymentId: string): Promise<never> {
    const [existing] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);

    if (!existing) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    throw new Error(
      `Automated rollback is not implemented for deployment ${deploymentId}. ` +
        `${LIGHTSAIL_DEPLOY_RUNBOOK} Roll back by deploying the previous image ` +
        `tag to apex-service, then update this row by hand.`,
    );
  }
}
