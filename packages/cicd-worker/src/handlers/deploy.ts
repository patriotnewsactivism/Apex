// ─── Deploy / rollback job handlers ─────────────────────────────────────────
//
// Ported from packages/cicd-automation/src/deployment-manager.ts.
//
// deploy()/rollback() were NEVER real platform API calls -- deploy()
// hardcoded a deploymentUrl and status='healthy' unconditionally; rollback()
// just flipped a status flag.
//
// 2026-08-19: they now FAIL LOUDLY instead of returning fabricated success.
// Silent fake success is the single most dangerous shape a tool can have in
// an autonomous workforce: an agent told to "deploy and verify" got
// status='healthy' plus the URL 'https://apex.vercel.app', reported the goal
// complete, and nobody learned that nothing shipped -- to a platform Apex
// isn't even hosted on.
//
// CURRENT STATUS: this package is part of the unfinished Convex migration and
// is excluded from the production typecheck. APEX production runs on Railway
// (project APEX, service apex-backend) and normally deploys automatically from
// main after green CI. The Cloud Run implementation elsewhere in this repository
// is retained only as an explicitly gated migration-back path.
//
// This worker intentionally does NOT perform a real deployment. Its handlers
// fail loudly so an autonomous task cannot confuse a queued worker job with a
// production release. Use the Railway deployment status plus the live /health
// build SHA for ordinary production evidence.
//
// Behavior difference from the original (forced, not a choice): the old
// rollback() first looked up the deployment row in Postgres and THREW if it
// didn't exist. That `deployments` table has no equivalent read/write
// mutation exposed to this worker over the convex/cicd.ts contract (only
// claimNextJob/reportJobResult) -- there is nothing for this worker to query
// against -- so existence-checking is simply dropped and rollback always
// also fails loudly rather than fabricating rollback success for an arbitrary deploymentId.
import crypto from 'crypto';

export interface DeployPayload {
  environment: 'staging' | 'production';
  /** 'vercel' is deliberately absent -- Apex is not hosted on Vercel. */
  platform?: 'cloud-run' | 'local';
}

export interface DeployResult {
  deploymentId: string;
  status: string;
  deploymentUrl?: string;
}

export const CLOUD_RUN_DEPLOY_RUNBOOK =
  'APEX production runs on Railway and this experimental worker cannot deploy or roll it back. ' +
  'Ordinary releases come from main after green CI and must be verified from Railway deployment ' +
  'status plus the live /health build SHA. The Cloud Run code elsewhere is a retired, gated ' +
  'migration-back path only; never report this worker as having changed production.';

/** @deprecated Historical alias retained only for compatibility. */
export const LIGHTSAIL_DEPLOY_RUNBOOK = CLOUD_RUN_DEPLOY_RUNBOOK;

export async function handleDeploy(payload: DeployPayload): Promise<DeployResult> {
  const deploymentId = `deploy-${crypto.randomUUID().slice(0, 8)}`;
  throw new Error(
    `Automated deploy is not implemented (${payload.environment}, platform ` +
      `${payload.platform ?? 'local'}, attempt ${deploymentId}). ${CLOUD_RUN_DEPLOY_RUNBOOK}`,
  );
}

export interface RollbackPayload {
  deploymentId: string;
}

export interface RollbackResult {
  success: boolean;
  rolledBackId: string;
}

export async function handleRollback(payload: RollbackPayload): Promise<RollbackResult> {
  // Same reasoning as handleDeploy: reporting success for a rollback that
  // never happened is worse than failing, because it ends the incident in
  // the agent's mind while production is still broken.
  throw new Error(
    `Automated rollback is not implemented (deployment ${payload.deploymentId}). ` +
      `${CLOUD_RUN_DEPLOY_RUNBOOK}`,
  );
}
