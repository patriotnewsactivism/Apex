#!/usr/bin/env bash
# Deploy Apex to Lightsail from AWS CloudShell — no credentials leave AWS.
#
# This exists because the GitHub Actions route (docs/deploy-workflow.yml) needs a
# workflow file that only a human can commit, and because pasting AWS keys into a
# chat window to let something else deploy is not an acceptable alternative.
# Everything here runs inside your own AWS session.
#
#   curl -sL https://raw.githubusercontent.com/patriotnewsactivism/Apex/main/scripts/deploy-from-shell.sh | bash
#
# What it does, in order:
#   1. Starts the CodeBuild build and waits for the real terminal status.
#   2. Redeploys the Lightsail service, forcing a genuinely new container spec so
#      a cached ':latest' digest cannot be silently reused (the exact failure
#      that made a fixed bug look unfixed on 2026-08-19).
#   3. Waits for ACTIVE, then verifies /health and reports which commit is live.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PROJECT="${APEX_CODEBUILD_PROJECT:-apex-lightsail-build}"
SERVICE="${APEX_LIGHTSAIL_SERVICE:-apex-service}"
BUILD_TIMEOUT="${APEX_DEPLOY_BUILD_TIMEOUT:-1200}"
ACTIVE_TIMEOUT="${APEX_DEPLOY_ACTIVATION_TIMEOUT:-900}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] FAILED: %s\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || die "aws CLI not found (run this in AWS CloudShell)."
command -v jq  >/dev/null || die "jq not found (run this in AWS CloudShell)."

# ── 1. Build ────────────────────────────────────────────────────────────────
log "Starting CodeBuild project $PROJECT ($REGION)"
BUILD_ID=$(aws codebuild start-build --region "$REGION" --project-name "$PROJECT" \
  --query 'build.id' --output text) || die "start-build failed."
log "Build $BUILD_ID started; waiting (timeout ${BUILD_TIMEOUT}s)"

deadline=$(( $(date +%s) + BUILD_TIMEOUT ))
while :; do
  read -r STATUS PHASE <<<"$(aws codebuild batch-get-builds --region "$REGION" --ids "$BUILD_ID" \
    --query 'builds[0].[buildStatus,currentPhase]' --output text)"
  [[ "$STATUS" != "IN_PROGRESS" ]] && break
  (( $(date +%s) > deadline )) && die "build still $STATUS in phase $PHASE after ${BUILD_TIMEOUT}s."
  log "  building… phase=$PHASE"
  sleep 15
done
[[ "$STATUS" == "SUCCEEDED" ]] || die "CodeBuild ended $STATUS in phase $PHASE — no new image was published.
  Logs: aws codebuild batch-get-builds --ids $BUILD_ID --query 'builds[0].logs.deepLink' --output text"
log "Build SUCCEEDED"
SRC_SHA=$(aws codebuild batch-get-builds --region "$REGION" --ids "$BUILD_ID" \
  --query 'builds[0].resolvedSourceVersion' --output text 2>/dev/null || echo unknown)
log "Built from commit ${SRC_SHA:0:12}"

# ── 2. Redeploy, defeating the ':latest' cache ───────────────────────────────
# Reusing the previous spec verbatim lets Lightsail treat the deployment as a
# no-op and keep the old container. Changing one env value guarantees a new spec
# and therefore a real pull + restart.
log "Reading current deployment spec for $SERVICE"
SPEC=$(aws lightsail get-container-services --region "$REGION" --service-name "$SERVICE" \
  --query 'containerServices[0].currentDeployment.{containers:containers,publicEndpoint:publicEndpoint}' \
  --output json) || die "could not read $SERVICE. Wrong service name or region?"
[[ "$(jq -r '.containers // "null"' <<<"$SPEC")" == "null" ]] && die "$SERVICE has no current deployment to base a redeploy on."

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
# Only a timestamp is injected. APEX_BUILD_SHA is deliberately NOT set here:
# /health reads it from the environment, so setting it in the deployment spec
# would override whatever the image was built with and make the provenance
# check below pass unconditionally — a green light that proves nothing.
CONTAINERS=$(jq -c --arg s "$STAMP" \
  '.containers | with_entries(.value.environment = ((.value.environment // {}) + {APEX_DEPLOY_STAMP: $s}))' \
  <<<"$SPEC") || die "could not build the new container spec."
ENDPOINT=$(jq -c '{containerName:.publicEndpoint.containerName, containerPort:.publicEndpoint.containerPort, healthCheck:(.publicEndpoint.healthCheck // {path:"/health"})}' <<<"$SPEC")

log "Creating deployment (stamp $STAMP, so the spec is genuinely new)"
NEW_VERSION=$(aws lightsail create-container-service-deployment --region "$REGION" \
  --service-name "$SERVICE" --containers "$CONTAINERS" --public-endpoint "$ENDPOINT" \
  --query 'containerService.nextDeployment.version' --output text) || die "create-container-service-deployment failed."
log "Deployment v$NEW_VERSION submitted; waiting for ACTIVE (timeout ${ACTIVE_TIMEOUT}s)"

deadline=$(( $(date +%s) + ACTIVE_TIMEOUT ))
while :; do
  read -r CUR STATE <<<"$(aws lightsail get-container-services --region "$REGION" --service-name "$SERVICE" \
    --query 'containerServices[0].currentDeployment.[version,state]' --output text)"
  [[ "$CUR" == "$NEW_VERSION" && "$STATE" == "ACTIVE" ]] && break
  [[ "$STATE" == "FAILED" ]] && die "deployment v$NEW_VERSION FAILED. Container logs:
  aws lightsail get-container-log --service-name $SERVICE --container-name <name> --region $REGION"
  (( $(date +%s) > deadline )) && die "v$NEW_VERSION not ACTIVE after ${ACTIVE_TIMEOUT}s (current v$CUR/$STATE)."
  log "  deploying… current=v$CUR state=$STATE"
  sleep 15
done
log "Deployment v$NEW_VERSION is ACTIVE"

# ── 3. Prove it ─────────────────────────────────────────────────────────────
URL=$(aws lightsail get-container-services --region "$REGION" --service-name "$SERVICE" \
  --query 'containerServices[0].url' --output text)
HEALTH="${URL%/}/health"
log "Verifying $HEALTH"
CODE=$(curl -s -o /tmp/apex-health.json -w '%{http_code}' --max-time 20 "$HEALTH" || echo 000)
BODY=$(cat /tmp/apex-health.json 2>/dev/null || true)

if [[ "$CODE" != "200" ]]; then
  printf '%s\n' "$BODY" | jq . 2>/dev/null || printf '%s\n' "$BODY"
  # 503 is deliberate: the service reports itself degraded when the task queue
  # is failing repeatedly, so a broken release cannot pass as a good deploy.
  die "/health returned HTTP $CODE. The container is running but not healthy — see the body above."
fi

LIVE_SHA=$(jq -r '.build.sha // "missing"' <<<"$BODY")
VERDICT=$(jq -r '.taskQueue.verdict // "unreported"' <<<"$BODY")
UPTIME=$(jq -r '.build.uptimeSeconds // "?"' <<<"$BODY")
log "live commit=${LIVE_SHA:0:12}  queue=$VERDICT  uptime=${UPTIME}s"

if [[ "$LIVE_SHA" == "unknown" || "$LIVE_SHA" == "missing" ]]; then
  log "WARNING: the running image does not report a commit. The CodeBuild buildspec is not"
  log "         passing --build-arg APEX_BUILD_SHA, so nothing can prove which code is live."
  log "         See docs/deploy-provenance.md."
elif [[ "${LIVE_SHA:0:12}" != "${SRC_SHA:0:12}" ]]; then
  die "STALE IMAGE: built ${SRC_SHA:0:12} but ${LIVE_SHA:0:12} is answering /health.
  The service did not pull the new image. Deploy an immutable ':<sha>' tag instead of ':latest'
  (docs/deploy-provenance.md)."
else
  log "Provenance verified: the commit that was built is the commit that is live."
fi

[[ "$VERDICT" == "ok" ]] || log "NOTE: task queue verdict is '$VERDICT' — check .taskQueue in the body above."
log "Done. Service: $URL"
