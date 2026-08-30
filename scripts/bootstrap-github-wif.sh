#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-apex-503709}"
PROJECT_NUMBER="${PROJECT_NUMBER:-429262820734}"
POOL_NAME="${POOL_NAME:-github-pool}"
PROVIDER_NAME="${PROVIDER_NAME:-github-provider}"
GITHUB_REPO="${GITHUB_REPO:-patriotnewsactivism/Apex}"
SA="${SA:-429262820734-compute@developer.gserviceaccount.com}"
REGION="${REGION:-us-central1}"
ARTIFACT_REPO="${ARTIFACT_REPO:-cloud-run-source-deploy}"

command -v gcloud >/dev/null 2>&1 || {
  echo "gcloud CLI is required. Run this script from Google Cloud Shell." >&2
  exit 1
}

echo "Configuring APEX GitHub OIDC deployment"
echo "  project: $PROJECT_ID"
echo "  repository: $GITHUB_REPO"
echo "  service account: $SA"

gcloud config set project "$PROJECT_ID"

gcloud services enable \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  serviceusage.googleapis.com

if ! gcloud iam workload-identity-pools describe "$POOL_NAME" \
  --project="$PROJECT_ID" \
  --location="global" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_NAME" \
    --project="$PROJECT_ID" \
    --location="global" \
    --display-name="GitHub Actions"
fi

if gcloud iam workload-identity-pools providers describe "$PROVIDER_NAME" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="$POOL_NAME" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_NAME" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_NAME" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='$GITHUB_REPO'"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_NAME" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_NAME" \
    --display-name="GitHub Provider" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='$GITHUB_REPO'"
fi

WIF_MEMBER="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_NAME/attribute.repository/$GITHUB_REPO"

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="$WIF_MEMBER"

for role in \
  roles/run.admin \
  roles/artifactregistry.writer \
  roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA" \
    --role="$role" \
    --condition=None >/dev/null
  echo "Granted $role"
done

# Cloud Run deployment requires iam.serviceAccounts.actAs on the runtime SA.
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:$SA" \
  --role="roles/iam.serviceAccountUser" >/dev/null

echo "Granted roles/iam.serviceAccountUser on $SA"

if ! gcloud artifacts repositories describe "$ARTIFACT_REPO" \
  --project="$PROJECT_ID" \
  --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$ARTIFACT_REPO" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --repository-format=docker \
    --description="APEX Cloud Run production images"
fi

echo
echo "=== PROVIDER ==="
gcloud iam workload-identity-pools providers describe "$PROVIDER_NAME" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="$POOL_NAME" \
  --format="yaml(name,attributeMapping,attributeCondition,state)"

echo
echo "=== SERVICE ACCOUNT WIF POLICY ==="
gcloud iam service-accounts get-iam-policy "$SA" \
  --project="$PROJECT_ID" \
  --format=yaml

echo
echo "APEX GitHub Workload Identity bootstrap complete."
