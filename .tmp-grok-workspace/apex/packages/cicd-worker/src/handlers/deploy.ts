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
// CORRECTED 2026-09-05: the paragraph below originally claimed Apex
// production was AWS Lightsail. That was already stale when written and was
// never caught, because scripts/verify-retired-hosting-instructions.ts only
// scans a fixed list of .md files, not packages/**/src/*.ts -- this file was
// an un-caught blind spot for exactly the class of bug that guard exists to
// catch. Per ADR-001 in docs/ARCHITECTURE_DECISIONS.md, Apex production is
// the existing **Google Cloud Run** service behind
// https://apex.donmatthews.live. AWS Lightsail/CodeBuild and Railway are
// retired hosting paths. Vercel, Railway, Render, and similar platforms may
// still appear elsewhere in this repo as deploy targets for CLIENT projects
// the CI/CD tooling manages -- that is not where Apex itself runs.
//
// This worker intentionally does NOT perform a real deploy: cicd-worker is
// part of the unfinished Convex migration (see apexplan.md), depends only on
// @workspace/convex-backend, and is not the process running in production.
// Real Apex deploys go through packages/cicd-automation/src/cloud-run-deployer.ts,
// invoked via the api-server tool `deploy_to_environment` / POST
// /api/cicd/deploy -- see docs/PRODUCTION_OPERATIONS.md for the exact
// sequence. These handlers keep throwing, and point there, so a job routed
// here fails loudly rather than silently no-op'ing or reporting a fabricated
// success against infrastructure Apex doesn't run on.
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
  platform?: 'cloud-run' | 'local';
}

export interface DeployResult {
  deploymentId: string;
  status: string;
  deploymentUrl?: string;
}

export const CLOUD_RUN_DEPLOY_RUNBOOK =
  'Deploys are implemented in the api-server process, not this worker: use the ' +
  '`deploy_to_environment` tool or POST /api/cicd/deploy (requires ' +
  'APEX_DEPLOY_ENABLED plus an authenticated gcloud identity or Workload ' +
  'Identity). Apex production runs on the existing Google Cloud Run service ' +
  'behind https://apex.donmatthews.live -- see docs/PRODUCTION_OPERATIONS.md. ' +
  'Deploying requires, in order: (1) Google Cloud Build from cloudbuild.apex.yaml ' +
  'against the exact reviewed commit, producing an immutable :<sha>-tagged ' +
  'image, (2) wait for the build to succeed, (3) `gcloud run services update` ' +
  '(never `deploy`/`create`) on the existing configured service, (4) poll the ' +
  'new revision to Ready and verify /health.build.sha matches. No gcloud ' +
  'credentials or platform API are wired into this worker, so this job ' +
  'cannot perform that sequence — escalate to a human instead of reporting ' +
  'a deploy as done.';

/** @deprecated Renamed to {@link CLOUD_RUN_DEPLOY_RUNBOOK} -- Apex production
 * is Google Cloud Run, not AWS Lightsail. Kept as an alias only in case an
 * external caller still imports the old name; do not add new references. */
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
      `${CLOUD_RUN_DEPLOY_RUNBOOK} Roll back by deploying the previous image ` +
      `tag to apex-service.`,
  );
}
