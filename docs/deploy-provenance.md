# Knowing what's actually running

On 2026-08-19 a single-line bug in `TaskQueue.dequeue()` took several
build → deploy → read-logs cycles to pin down, and most of that time went to a
question that should be free: **is the code I just built the code that's
running?** `:latest` is a mutable tag, `GET /health` returned a flat
`{status:'ok'}` that proved only that Express was listening, and Lightsail
reports a deployment `ACTIVE` whether or not the container can do any work.
Three separate signals, none of which answered the question.

## What `/health` now tells you

```bash
curl -s https://apex.donmatthews.live/health | jq
```

```json
{
  "status": "ok",
  "agents": 13,
  "build": { "sha": "c1a8374…", "builtAt": "…", "startedAt": "…", "uptimeSeconds": 412 },
  "taskQueue": { "attempts": 512, "successes": 512, "tasksClaimed": 7,
                 "failures": 0, "consecutiveFailures": 0, "verdict": "ok" }
}
```

- **`build.sha`** — the commit baked into the image. Compare it to the commit
  you expect. If they differ, the deployment did not pick up your build and no
  amount of log reading will change that.
- **`build.uptimeSeconds`** — small means the container really restarted. A
  large value right after a deployment means the old container is still serving.
- **`taskQueue`** — `attempts` climbing with `successes` flat is a queue failing
  on every call. `tasksClaimed: 0` on its own only means idle.
- **`status: "degraded"` + HTTP 503** once dequeue fails 5 times in a row (5, so
  a single dropped connection during a DB failover doesn't trip it). The
  automated deployer verifies `/health` after activation, so **a release that
  brings up a service whose queue is broken now fails the deploy** instead of
  being reported healthy.

## Required buildspec change

The build must pass the commit through, or `build.sha` reads `unknown`:

```yaml
build:
  commands:
    - |
      docker build \
        --build-arg APEX_BUILD_SHA="$CODEBUILD_RESOLVED_SOURCE_VERSION" \
        --build-arg APEX_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        -t "$ECR_REPO:latest" \
        -t "$ECR_REPO:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:12}" .
    - docker push "$ECR_REPO:latest"
    - docker push "$ECR_REPO:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:12}"
```

The buildspec lives in the CodeBuild project `apex-lightsail-build`, not in this
repo, so this file is the record of what it needs to contain.

## Recommended: stop deploying a mutable tag

The second tag above is the real fix for this class of confusion. Deploying
`:<sha>` instead of `:latest` makes every deployment name exactly one image, and
makes rollback meaningful — `rollbackLightsail()` currently warns that restoring
a spec pinned to `:latest` may re-pull the same bad image, because it can.

## How to deploy

```
Actions → Deploy → Run workflow → environment: staging | production
```

`.github/workflows/deploy.yml` (see `docs/deploy-workflow.yml` for the exact
contents to copy in — GitHub Apps are barred from writing workflow files, so it
has to be added by a human) runs `packages/cicd-automation/scripts/deploy.mts`,
which calls the same `deployToLightsail()` used everywhere else — CI does not
reimplement the deploy in YAML — and then additionally asserts that the commit
answering `/health` **is the commit that was just deployed**. A cached `:latest`
digest therefore fails the run instead of passing as green.

One-time setup in the repo (Settings):

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `AWS_ACCESS_KEY_ID` | the `apex-deployer` IAM user's key |
| Secret | `AWS_SECRET_ACCESS_KEY` | its secret |
| Variable | `APEX_DEPLOY_ENABLED` | `staging`, `production`, or `all` |
| Variable | `AWS_REGION` | `us-east-1` (default if unset) |

Use the scoped `apex-deployer` user from `docs/aws-deploy-iam-policy.json`, never
root credentials: the policy grants five actions and cannot touch anything else
if it leaks. With `APEX_DEPLOY_ENABLED` unset the deployer refuses to run, so
merging this workflow does not by itself enable deployments.
