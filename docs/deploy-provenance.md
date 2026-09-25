# Knowing what is actually running

APEX production is the Railway service `apex-backend` in project `APEX`, mapped to
`https://apex.donmatthews.live`. Google Cloud Run is a retired, gated
migration-back path only. The GitHub `Vercel` status is the dashboard project
`don-matthews/apex` (`vercel.json` builds `@workspace/dashboard` only) and is
not production provenance.

A deployment is not considered successful merely because a build completed, a
commit reached `main`, or Railway reported Success. The code answering
production traffic must be the exact reviewed Git commit and its task queue must
remain healthy.

## Current Railway provenance chain

The ordinary production chain is:

1. review the exact commit intended for release;
2. require GitHub Actions `production-checks` to be green;
3. merge/push that commit to `main`;
4. Railway's configured Wait-for-CI trigger builds the repository `Dockerfile`
   and deploys service `apex-backend`;
5. confirm Railway reports Success for that same commit;
6. verify `https://apex.donmatthews.live/health` reports the expected build SHA,
   and authenticated `GET /api/health/detail` reports a healthy `taskQueue.verdict`;
7. smoke-test the changed production path.

`railway.toml` fixes the build to the repository `Dockerfile` and the health
check to `/health`. Railway injects `RAILWAY_GIT_COMMIT_SHA`; current
`packages/core/src/runtime-health.ts` reports `APEX_BUILD_SHA` when explicitly
provided, otherwise that Railway commit SHA, otherwise `unknown`.

## What `/health` proves

Public `GET /health` is the Railway healthcheck and the unauthenticated release
probe. It returns HTTP 200 when the task queue can dequeue, and HTTP 503 when
that queue is provably broken. The body is only:

- `status` — `ok` or `degraded` (matches the HTTP status);
- `build.sha` / `build.version` — the source commit reported by the running
  service; on Railway this falls back to `RAILWAY_GIT_COMMIT_SHA`;
- `build.startedAt` / `build.uptimeSeconds` — evidence that a running instance
  actually started.

`taskQueue.verdict`, `llmCapacity.state`, account identity, spend, request
caps, and worker ids are on authenticated `GET /api/health/detail`.

A health response is runtime evidence, not a substitute for the CI and Railway
deployment records. Conversely, a successful Railway deployment is not enough
if the public health endpoint is serving a different SHA.

## Current release verification

```bash
curl -s https://apex.donmatthews.live/health | jq
curl -s -H "Authorization: Bearer $APEX_ADMIN_TOKEN" \
  https://apex.donmatthews.live/api/health/detail | jq
```

Record the reviewed SHA, the `production-checks` result, the Railway
`apex-backend` deployment result, the live health SHA, the authenticated
task-queue verdict, and the production smoke test. Never invent or infer a
missing service ID, token, secret, or deployment result.

## Retired Cloud Run migration-back path

`cloudbuild.apex.yaml` and
`packages/cicd-automation/src/cloud-run-deployer.ts` remain in the repository as
an emergency migration-back implementation. The former GitHub Cloud Run deploy
workflow has been removed. This path is not the current production release
mechanism and must not be enabled while its documented prerequisites, including
GCP billing, are absent.

If an operator explicitly decides to migrate back to Cloud Run, the retained
deployer is fail-closed: it requires explicit existing project/region/service
configuration and `APEX_DEPLOY_ENABLED`, builds an immutable commit-tagged image,
updates only the configured existing service, waits for readiness, and verifies
health. It must never create a substitute service because the intended target
cannot be accessed.

The required GCP configuration names for that retired path are:

```text
APEX_DEPLOY_ENABLED
APEX_GCP_PROJECT_ID
APEX_CLOUD_RUN_REGION
APEX_CLOUD_RUN_SERVICE
APEX_CLOUD_BUILD_REGION        # optional
APEX_DEPLOY_HEALTH_URL         # optional
APEX_DEPLOY_SOURCE_DIR         # optional
```

Do not put service-account JSON keys in the repository. Any future reactivation
requires an explicit operator decision, a reviewed security/deployment plan,
and live verification after cutover.
