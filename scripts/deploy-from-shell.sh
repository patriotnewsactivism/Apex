#!/usr/bin/env bash
# Deploy the reviewed APEX commit to its EXISTING Google Cloud Run service.
#
# This wrapper intentionally does not create infrastructure. The TypeScript
# deployer it calls first describes the exact configured Cloud Run service,
# reuses its existing image repository, builds the clean Git tree with Google
# Cloud Build, updates only that service's image, and verifies /health.
#
# Required environment variables:
#   APEX_DEPLOY_ENABLED=production
#   APEX_GCP_PROJECT_ID=<existing project id>
#   APEX_CLOUD_RUN_REGION=<existing service region>
#   APEX_CLOUD_RUN_SERVICE=<existing service name>
#
# Optional:
#   APEX_CLOUD_BUILD_REGION=<regional Cloud Build location>
#   APEX_DEPLOY_HEALTH_URL=https://apex.donmatthews.live
#
# Authentication is provided by gcloud (human login or Workload Identity).
# Never paste a service-account key into this script or the repository.
set -euo pipefail

command -v gcloud >/dev/null || { echo '[deploy] gcloud CLI is required' >&2; exit 2; }
command -v git >/dev/null || { echo '[deploy] git is required' >&2; exit 2; }
command -v pnpm >/dev/null || { echo '[deploy] pnpm is required' >&2; exit 2; }

SHA="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo '[deploy] Refusing production deploy from a dirty working tree.' >&2
  exit 2
fi

: "${APEX_DEPLOY_ENABLED:=production}"
export APEX_DEPLOY_ENABLED

exec pnpm --filter @workspace/cicd-automation exec tsx \
  "$(pwd)/packages/cicd-automation/scripts/deploy.mts" \
  production --expect-sha "$SHA"
