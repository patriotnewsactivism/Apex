# APEX Production Operations Runbook

This runbook governs ordinary APEX production releases, verification, rollback, and first-response incident handling.

APEX production is the **existing Google Cloud Run service** behind:

`https://apex.donmatthews.live`

The retired AWS Lightsail/CodeBuild and Railway hosting paths are not production fallbacks.

## Operating principles

1. Never guess the Google Cloud project, region, service name, secret values, live SHA, or database target.
2. Never create a replacement Cloud Run service because the intended service cannot be found or accessed.
3. Build from a clean, reviewed Git commit and use an immutable image tag derived from that commit.
4. Preserve existing Cloud Run configuration unless the change is specifically intended to modify it.
5. A build is not a deployment, a Ready revision is not proof of production traffic, and an agent statement is not operational evidence.
6. Production is considered released only when the public health endpoint reports the intended `build.sha` and the changed behavior has been smoke-tested.

## Required release configuration

The deploy process requires:

```text
APEX_DEPLOY_ENABLED=production
APEX_GCP_PROJECT_ID=<existing APEX project>
APEX_CLOUD_RUN_REGION=<existing APEX service region>
APEX_CLOUD_RUN_SERVICE=<existing APEX service name>
```

Optional:

```text
APEX_CLOUD_BUILD_REGION=<regional Cloud Build location if applicable>
APEX_DEPLOY_HEALTH_URL=https://apex.donmatthews.live
APEX_DEPLOY_SOURCE_DIR=<clean checkout path>
```

Authentication must come from an authorized `gcloud` identity or Google Workload Identity. Do not commit service-account JSON keys.

The exact project/region/service identifiers are deployment configuration, not values to invent in documentation.

## Preflight

Before a production release:

```bash
git fetch origin
git status --short
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm run typecheck:production
pnpm run build
```

Confirm:

- working tree is clean;
- `HEAD` is the intended reviewed release SHA;
- CI for the release state is green;
- no unresolved high-severity production issue makes rollout unsafe;
- the authenticated Google identity can read the exact configured Cloud Run service;
- required deployment environment variables are present by name;
- any required new runtime secret has already been configured through the approved secret-management path.

Do not dump environment variables or secret values to prove configuration.

## Confirm the existing Cloud Run target

Before changing anything, establish that the intended service exists:

```bash
gcloud run services describe "$APEX_CLOUD_RUN_SERVICE" \
  --project "$APEX_GCP_PROJECT_ID" \
  --region "$APEX_CLOUD_RUN_REGION"
```

If this fails because the service is absent, the project/region is wrong, or the identity lacks access, stop. Do not substitute a different service.

## Production deploy

From the clean reviewed checkout:

```bash
export APEX_DEPLOY_ENABLED=production
export APEX_GCP_PROJECT_ID=...
export APEX_CLOUD_RUN_REGION=...
export APEX_CLOUD_RUN_SERVICE=...
./scripts/deploy-from-shell.sh
```

The wrapper obtains the exact Git SHA and calls the TypeScript deployment path in `packages/cicd-automation`.

The intended sequence is:

1. validate explicit deployment authorization;
2. validate clean Git state and expected SHA;
3. describe the existing Cloud Run service;
4. derive/reuse the existing image repository;
5. invoke Google Cloud Build with `cloudbuild.apex.yaml`;
6. build and push an immutable image tagged with the exact commit;
7. update only the existing service image with `gcloud run services update`;
8. wait for the new revision to become Ready;
9. verify the public health endpoint;
10. fail if the live `build.sha` does not equal the requested SHA.

Do not use `gcloud run deploy` as an ordinary APEX release fallback.

## Production verification

Inspect the public health endpoint:

```bash
curl -fsS https://apex.donmatthews.live/health
```

Required release evidence includes:

- HTTP success;
- `build.sha` equals the exact release commit;
- `taskQueue.verdict` is healthy;
- no new repeated queue failures are accumulating;
- LLM capacity state is understood if degraded;
- the changed user/operator path works in a real smoke test.

When the change affects authentication, dashboard behavior, agent execution, provider routing, deployment, scheduler behavior, or a connector, smoke-test that specific path rather than relying only on `/health`.

Record any part that could not be verified.

## Rollback

Rollback should route production traffic to the previous known-good Cloud Run revision and then verify the public health endpoint.

Do not rebuild an old mutable `latest` tag as a substitute for revision rollback.

A rollback is successful only when:

- traffic is serving the intended prior revision;
- `/health` returns successfully;
- the live `build.sha` is understood;
- the incident symptom is rechecked.

If rollback fails, preserve evidence and escalate rather than repeatedly changing infrastructure.

## Failed rollout response

If a new revision does not become healthy:

1. stop additional feature work;
2. record intended SHA, current live SHA, Cloud Build result, and revision status;
3. inspect startup/runtime logs without printing secrets;
4. determine whether failure is image/runtime, configuration, database, provider capacity, or external dependency related;
5. prefer rollback when the previous revision is known-good and the new release is causing production impact;
6. make one evidence-backed fix at a time;
7. rerun CI/build/provenance checks before redeploying.

Do not declare the issue fixed until production traffic verifies the correction.

## Incident first response

For a production incident, establish these facts first:

```text
Current public /health status
Current live build.sha
Expected/last known-good SHA
Task queue verdict and repeated failure count
LLM capacity state
Most recent release/change window
Database reachability
Relevant external-provider status/error class
Available rollback revision
```

Avoid speculative broad rewrites while these facts are unknown.

Provider capacity errors should not automatically be treated as application crashes. APEX distinguishes provider/capacity pauses from ordinary task failures; preserve that distinction during triage.

## Secrets and configuration changes

Image-only releases should preserve existing Cloud Run service configuration.

If the release intentionally changes environment variables, Secret Manager references, runtime service account, scaling, ingress, resources, domain mapping, or other service settings, treat that as a separate reviewed infrastructure change. Capture the previous state before modifying it and define the rollback path.

Never expose secret values in command output, commits, issues, PRs, screenshots, or agent reports.

## Database changes

Do not couple an image release with an unreviewed production schema or Supabase-management change.

Before a production migration or management-plane operation:

- verify the exact target project/database;
- verify the credential is intended for that target and operation;
- obtain explicit authorization;
- use a reviewable migration or command;
- understand backward compatibility with the currently live revision;
- prepare rollback/recovery;
- verify the migration independently from the application rollout.

Runtime DB connectivity is not management authorization.

## Post-release record

For material production releases, retain a concise record containing:

```text
Release SHA:
CI result:
Cloud Build result:
Cloud Run revision:
Live /health SHA:
Task queue verdict:
Smoke test performed:
Rollback target:
Known follow-ups / unverified items:
```

Do not include secret values.

## Source of truth

Implementation:

- `packages/cicd-automation/src/cloud-run-deployer.ts`
- `packages/cicd-automation/src/deployment-manager.ts`
- `packages/cicd-automation/scripts/deploy.mts`
- `scripts/deploy-from-shell.sh`
- `cloudbuild.apex.yaml`

Policy and provenance:

- `AGENTS.md`
- `SECURITY.md`
- `docs/ARCHITECTURE_DECISIONS.md`
- `docs/deploy-provenance.md`

When this runbook conflicts with current source or direct production evidence, stop, identify the conflict, and update the documentation after establishing the truth. Do not silently follow stale instructions.
