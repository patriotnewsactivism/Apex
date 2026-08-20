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
// Apex production is the **AWS Lightsail** container service `apex-service`,
// image built by CodeBuild project `apex-lightsail-build` (Railway retired
// 2026-08-16; see AGENTS.md for the canonical deploy sequence). Vercel and
// Railway do still appear elsewhere in this repo as deploy targets for
// CLIENT projects the CI/CD tooling manages -- that is not where Apex runs.
// 2026-08-19 (second pass): a REAL Lightsail deploy path now exists at
// packages/cicd-automation/src/lightsail-deployer.ts (CodeBuild StartBuild →
// poll → CreateContainerServiceDeployment → poll to ACTIVE → verify /health).
// This worker intentionally does NOT call it: cicd-worker is part of the
// unfinished Convex migration (see apexplan.md), depends only on
// @workspace/convex-backend, and is not the process running in production.
// Deploys go through the api-server tool `deploy_to_environment` /
// POST /api/cicd/deploy instead. These handlers keep throwing, and point
// there, so a job routed here fails loudly rather than silently no-op'ing.
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
  /** 'vercel' is deliberately absent -- Apex is not hosted on Vercel. */
  platform?: 'lightsail' | 'local';
}

export interface DeployResult {
  deploymentId: string;
  status: string;
  deploymentUrl?: string;
}

export const LIGHTSAIL_DEPLOY_RUNBOOK =
  'Deploys are implemented in the api-server process, not this worker: use the ' +
  '`deploy_to_environment` tool or POST /api/cicd/deploy (requires ' +
  'APEX_DEPLOY_ENABLED plus scoped AWS credentials). ' +
  'Apex production runs on AWS Lightsail container service `apex-service` ' +
  '(image 535203103662.dkr.ecr.us-east-1.amazonaws.com/apex-lightsail:latest). ' +
  'Deploying requires, in order: (1) `aws codebuild start-build --project-name ' +
  'apex-lightsail-build --region us-east-1`, (2) wait for SUCCEEDED, ' +
  '(3) `aws lightsail create-container-service-deployment` for apex-service, ' +
  '(4) poll `aws lightsail get-container-service-deployments`. No AWS ' +
  'credentials or platform API are wired into this worker, so this job ' +
  'cannot perform that sequence — escalate to a human instead of reporting ' +
  'a deploy as done.';

export async function handleDeploy(payload: DeployPayload): Promise<DeployResult> {
  const deploymentId = `deploy-${crypto.randomUUID().slice(0, 8)}`;
  throw new Error(
    `Automated deploy is not implemented (${payload.environment}, platform ` +
      `${payload.platform ?? 'local'}, attempt ${deploymentId}). ${LIGHTSAIL_DEPLOY_RUNBOOK}`,
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
      `${LIGHTSAIL_DEPLOY_RUNBOOK} Roll back by deploying the previous image ` +
      `tag to apex-service.`,
  );
}
