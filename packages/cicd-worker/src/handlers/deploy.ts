// ─── Deploy / rollback job handlers ─────────────────────────────────────────
//
// Ported from packages/cicd-automation/src/deployment-manager.ts.
//
// IMPORTANT, carried over unchanged from the original: DeploymentManager.
// deploy()/.rollback() were NEVER real Railway/Vercel API calls -- deploy()
// hardcoded deploymentUrl='https://apex-production.up.railway.app' and
// status='healthy' unconditionally; rollback() just flipped a status flag.
// This is a known, pre-existing limitation of the CURRENT system, not
// something introduced or "fixed" here -- wiring up real deploy automation
// is separate future scope that needs real Railway/Vercel API tokens nobody
// has configured yet. Do not treat this handler as doing anything real.
//
// Behavior difference from the original (forced, not a choice): the old
// rollback() first looked up the deployment row in Postgres and THREW if it
// didn't exist. That `deployments` table has no equivalent read/write
// mutation exposed to this worker over the convex/cicd.ts contract (only
// claimNextJob/reportJobResult) -- there is nothing for this worker to query
// against -- so existence-checking is simply dropped and rollback always
// reports success for whatever deploymentId it's given.
import crypto from 'crypto';

export interface DeployPayload {
  environment: 'staging' | 'production';
  platform?: 'railway' | 'vercel' | 'local';
}

export interface DeployResult {
  deploymentId: string;
  status: string;
  deploymentUrl?: string;
}

export async function handleDeploy(payload: DeployPayload): Promise<DeployResult> {
  const deploymentId = `deploy-${crypto.randomUUID().slice(0, 8)}`;
  const platform = payload.platform ?? 'railway';
  const deploymentUrl =
    platform === 'railway'
      ? 'https://apex-production.up.railway.app'
      : platform === 'vercel'
        ? 'https://apex.vercel.app'
        : undefined;

  return {
    deploymentId,
    status: 'healthy',
    deploymentUrl,
  };
}

export interface RollbackPayload {
  deploymentId: string;
}

export interface RollbackResult {
  success: boolean;
  rolledBackId: string;
}

export async function handleRollback(payload: RollbackPayload): Promise<RollbackResult> {
  return {
    success: true,
    rolledBackId: payload.deploymentId,
  };
}
