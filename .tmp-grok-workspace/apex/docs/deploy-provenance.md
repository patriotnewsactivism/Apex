# Knowing what is actually running

APEX production is the existing Google Cloud Run service mapped to
`https://apex.donmatthews.live`.

A deployment is not considered successful merely because a build completed or
Cloud Run created a revision. The code answering production traffic must be the
exact reviewed Git commit and its task queue must remain healthy.

## What `/health` proves

```bash
curl -s https://apex.donmatthews.live/health | jq
```

Important fields:

- `build.sha` — exact source commit baked into the image by
  `cloudbuild.apex.yaml`.
- `build.builtAt` — image build time.
- `build.startedAt` / `build.uptimeSeconds` — confirms a new instance actually
  started.
- `taskQueue.verdict` — must be `ok` after rollout. Repeated dequeue failures
  deliberately make the health endpoint fail rather than allowing a broken
  workforce to look healthy.
- `llmCapacity.state` — operational LLM-capacity signal; provider exhaustion is
  reported separately from application health.

## Immutable Cloud Build image

`cloudbuild.apex.yaml` builds the production Dockerfile and requires three
substitutions from the deployer:

- `_IMAGE` — the existing Cloud Run image repository with `:<commit-sha>` tag.
- `_APEX_BUILD_SHA` — the exact clean Git commit being built.
- `_APEX_BUILD_TIME` — UTC build timestamp.

The Dockerfile bakes the latter two into the image. The deployer does **not**
forge `APEX_BUILD_SHA` as a runtime environment override; `/health` therefore
reports what the image was actually built from.

## Existing-service-only rule

APEX must never create a second Cloud Run service during an ordinary release.
The deployer first runs `gcloud run services describe` against the explicitly
configured project, region, and service. If that exact service cannot be read,
it stops.

After Cloud Build publishes the immutable image, deployment uses:

```text
gcloud run services update <existing-service> --image <immutable-image>
```

Using `services update` rather than `run deploy` is intentional. It updates the
existing service and preserves configuration that should not be reconstructed
from this repository: environment variables, Secret Manager references, runtime
service account, scaling, CPU/memory, ingress, domain mapping, and related
Google-managed settings.

## Required deployment configuration

The operator or CI environment must have an authenticated `gcloud` identity and
set:

```text
APEX_DEPLOY_ENABLED=production
APEX_GCP_PROJECT_ID=<the existing APEX Google Cloud project>
APEX_CLOUD_RUN_REGION=<the existing service region>
APEX_CLOUD_RUN_SERVICE=<the existing service name>
```

Optional:

```text
APEX_CLOUD_BUILD_REGION=<regional Cloud Build location, if used>
APEX_DEPLOY_HEALTH_URL=https://apex.donmatthews.live
APEX_DEPLOY_SOURCE_DIR=<clean APEX checkout; defaults to current directory>
```

Do not put service-account JSON keys in the repository. Use an authenticated
human `gcloud` session for an operator release or Google Workload Identity for
CI/automation.

## Production deploy

From a clean checkout whose `HEAD` is the reviewed release:

```bash
export APEX_DEPLOY_ENABLED=production
export APEX_GCP_PROJECT_ID=...
export APEX_CLOUD_RUN_REGION=...
export APEX_CLOUD_RUN_SERVICE=...
./scripts/deploy-from-shell.sh
```

The wrapper passes the exact `git rev-parse HEAD` to
`packages/cicd-automation/scripts/deploy.mts`. The deployment fails if the tree
is dirty, if the requested SHA differs from the checkout, if Google Cloud Build
fails, if the existing service cannot be found, if the new revision does not
become Ready, if `/health` is non-200, or if `/health.build.sha` does not match
the requested commit.

## Rollback

Rollback routes 100% traffic to the previous Cloud Run revision and then checks
`/health`. It does not rebuild an old mutable image and does not declare success
until the production health endpoint responds successfully.
