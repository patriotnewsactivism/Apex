// ─── Deploy / rollback job handlers ─────────────────────────────────────────
//
// Ported from packages/cicd-automation/src/deployment-manager.ts.
//
// IMPORTANT, carried over unchanged from the original: DeploymentManager.
// deploy()/.rollback() were NEVER real platform API calls -- deploy()
// hardcoded a deploymentUrl and status='healthy' unconditionally; rollback()
// just flipped a status flag. This is a known, pre-existing limitation of
// the CURRENT system, not something introduced or "fixed" here -- wiring up
// real deploy automation is separate future scope that needs a real
// platform API token nobody has configured yet. Do not treat this handler
// as doing anything real.
//
// 2026-08-16: Railway retired -- production is off Railway entirely (see
// the same date's commit removing railway.toml). The 'railway' platform
// option and its hardcoded *.up.railway.app URL were removed rather than
// pointed at a new value: the actual current production URL/platform is
// not yet documented anywhere in this repo, and guessing one would repeat
// exactly the mistake llm-client.ts's Gemini model-id churn made (picking
// a value with no verification). Confirm the real deployment target before
// adding a 'lightsail' (or other) case back here.
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
  platform?: 'vercel' | 'local';
}

export interface DeployResult {
  deploymentId: string;
  status: string;
  deploymentUrl?: string;
}

export async function handleDeploy(payload: DeployPayload): Promise<DeployResult> {
  const deploymentId = `deploy-${crypto.randomUUID().slice(0, 8)}`;
  const platform = payload.platform ?? 'local';
  const deploymentUrl = platform === 'vercel' ? 'https://apex.vercel.app' : undefined;

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
