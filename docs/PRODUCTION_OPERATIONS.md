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
- LLM capacity state is understood if degraded (see below);
- the changed user/operator path works in a real smoke test.

### Reading `llmCapacity.state`

The four values are not degrees of the same thing. Two of them mean the
workforce has stopped:

| `state` | Meaning | Is work being claimed? |
|---|---|---|
| `available` | No capacity constraint. | Yes |
| `paced` | One or more individual providers are resting or capped. | **Yes** — other providers still serve |
| `workforce_paused` | The workspace-wide daily allowance is exhausted. | **No** — every agent stops |
| `capped` | A hard total or per-provider cap is reached. | **No** |

`workforce_paused` reports the same conditions `llmCapacityAvailableNow()`
gates on, which stop task claiming for every agent in the process. There are
two of them — the token pacing window and the request pacing window — and
either alone parks the workforce. It typically clears at the 00:00 UTC
allowance reset; `nextResumeAt` gives the time.

This distinction is not cosmetic. Before 2026-09-08, `paced` covered both the
benign per-provider case and the total stall, and a 64-minute production
outage was invisible: `status: ok`, `taskQueue.verdict: ok`, zero failures, a
healthy poll loop, and `tasksClaimed` frozen. `workforceParkedUntil` does not
help here — it reports the base-agent shared latch and stays `null` when the
workspace allowance is the cause. `scripts/verify-capacity-observability.ts`
guards the distinction in CI.

**A stalled workforce looks healthy.** When triaging "APEX is doing nothing",
`tasksClaimed` failing to advance over a 2-minute sample is the symptom;
`llmCapacity.state` is the cause. Neither `status` nor `verdict` will tell you.

### Reading `llmRequests` (burn rate)

APEX's provider allowance is rationed per **request**, not per token: the
OpenRouter free tier permits a fixed number of calls per account per UTC day
regardless of their size. Every cap and pause in the process was denominated
in tokens until 2026-09-12, so the number that was actually running out was
counted nowhere. APEX was issuing roughly 5,000 requests/day against a
3,000/day ceiling and nothing reported it.

`/health` now carries the figure, unauthenticated, because a burn rate nobody
can see is how that went unnoticed:

| Field | Meaning |
|---|---|
| `used` | Requests spent today (UTC), **including failed ones** — a 429 or a timeout spent the allowance too |
| `cap` | `APEX_REQUEST_CAP_TOTAL`, default 2600 |
| `projected` | Requests/day at today's rate. **This is the number to compare against the provider allowance.** `null` before 00:15 UTC, when too little has elapsed to extrapolate honestly |
| `releasedSoFar` | How much of the cap the pacing ramp has released so far today |
| `lastMinute` / `ratePerMinute` | Requests in the last 60s against the short-window limit. **Watch this, not just `used`** — a day fully under budget can still be spent in half an hour |
| `accounts[]` | Per-account split. Accounts are grouped by the **key itself**, not the env var name: APEX reads OpenRouter keys from five env names across three real accounts, and the BYOK rung must reuse an existing account's key. Names holding the same key appear as one row (`OPENROUTER_API_KEY + OPENROUTER_BYOK_API_KEY`) |
| `persistence` | `memory-only` means a restart reset today's count; a deploy would then hand the workforce a fresh full allowance |

There are two limits and they protect against different things. The daily cap
bounds the day's total; the short-window limit (`APEX_REQUEST_RATE_PER_MIN`,
default 15) bounds any single minute. On 2026-09-12 only the first existed, and
APEX issued 1,388 requests in 26 minutes — comfortably under the day's budget,
and enough to trip OpenRouter's own per-minute limiter and park every provider
until the UTC reset.

**Free throughput scales with ACCOUNTS, not models.** OpenRouter's free
allowance is a per-account daily request budget shared across every `:free`
model at once — confirmed live on 2026-09-12 by an HTTP 429 carrying
`free-models-per-day-high-balance`, `X-RateLimit-Limit: 1000` and
`limit_source: openrouter_free_tier_daily`. Adding more free *models* buys
nothing against it (all three rungs went into cooldown together, because they
draw on one bucket); adding a key for another account buys a whole extra
1,000/day. `OPENROUTER_API_KEY_4` is wired for exactly that — set it and load
balancing picks the account up with no other change.

Keys added for free throughput are deliberately kept out of the paid credential
list. The $10 deposit on an account exists to lift its free tier from ~200/day
to 1,000/day; spending that balance on tokens is how the paid chain reached
HTTP 402 on 2026-09-12 while three accounts' free allowance sat unused.

Note also that some free models are gated: `thinkingmachines/inkling:free` and
`inkling-small:free` return `403 — only available on agentic harnesses` for
direct API use, and need the app registered at openrouter.ai/apps.

Credentials are tried **least-loaded first**, so several accounts share a quota
instead of the first one absorbing everything. Before that change one key took
1,299 of 1,388 requests (94%) and was driven past its daily limit while the
other two sat on 15 and 52 — three accounts delivering barely one account's
worth. If `accounts[]` ever shows one account far ahead of the others again,
that ordering has regressed.

Exceeding the cap shows as `llmCapacity.state: capped`; running ahead of the
pacing ramp shows as `workforce_paused`. Neither is an outage — the ramp
releases more allowance continuously, so a paced workforce resumes on its own.

To raise or remove the budget, set `APEX_REQUEST_CAP_TOTAL` (`0` disables it).

Per-account caps (`APEX_REQUEST_CAPS`) are written against env var **names**,
since that is what an operator can see, but they resolve to the account that
key belongs to. When several names hold one key the strictest cap among them
applies to the account as a whole — summing them would authorize more than the
account actually allows, which is the failure the key-based grouping exists to
prevent. Read the `accounts[]` labels on `/health` to see which names APEX has
resolved to the same account before setting them.

`scripts/verify-request-budget.ts` guards the accounting in CI.

### Reading `providerCredits`

APEX's automatic routing chain is **free-only** as of 2026-09-12. Nothing on the
default path can spend money, so an empty OpenRouter balance is no longer an
outage — but it was one, and that is why this field exists.

On 2026-09-12 the account held $20 of credits against $24.28 of usage. The
routing chain was paid-only, there was no free rung to fall through to, and
**every LLM request returned HTTP 402** while `/health` reported `status: ok`,
`taskQueue.verdict: ok`, 13 live agents and a healthy poll loop. Tasks were
being claimed and every one of them failed.

| `status` | Meaning |
|---|---|
| `ok` | Balance above $2 |
| `low` | Under $2 — paid rungs will start failing soon |
| `exhausted` | At or below zero. Free routing is unaffected; an explicit operator model policy that routes paid will 402 |
| `unknown` | No key configured, or the lookup failed. `detail` says which |

The balance is cached for 10 minutes and fetched in the background: `/health`
never awaits it, because a health endpoint that hangs on a third party is a
worse outage than the one it reports. The credits endpoint is an account
lookup, not a generation, so it consumes none of the daily request allowance
and is deliberately not counted in `llmRequests`.

### Reading `agentStatusCounts`

`error` in `agentStatusCounts` means **an agent's last task failed**. It does
not mean the agent is out of service, and it never did: the task queue does
not filter agents by status, so an agent showing `error` dequeues and executes
exactly like an idle one. The only other readers are a reporting count in
`tool-registry.ts` and the manual `POST /recover-workforce` reset.

Before 2026-09-12 that status was also sticky — `executeTask()` set it on
failure and only the *next* task's `setStatus('thinking')` cleared it, so on a
quiet queue an agent advertised `error` for hours after recovering. Three of
thirteen agents sat that way on build `3793abc` while `tasksClaimed` kept
climbing, which reads as a collapsing workforce and was not one. The polling
loop now clears a stale `error` in its idle branch, so it self-heals within
one poll cycle. `scripts/verify-agent-status-recovery.ts` guards this in CI.

**Do not diagnose a workforce outage from `agentStatusCounts` alone.** Whether
work is flowing is `taskQueue.tasksClaimed` advancing over a 2-minute sample —
claims are bursty and a shorter window reads as frozen.

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

## Restoring a service with no Ready revision

Symptom, as observed on 2026-08-30: `https://apex.donmatthews.live` answers
**503** from Google Frontend, and the deploy workflow's preflight reports

```text
Current ready revision: none — recovery rollout required
Latest created revision: <service>-00002-9vg
Current service URL:
Missing required APEX runtime configuration: DATABASE_URL
```

An empty `status.url` is the tell: Cloud Run does not assign one until a
revision has gone Ready, so the service has never served, and the custom
domain mapping in front of it has nothing healthy to route to.

`APEX_ADMIN_TOKEN` and `APEX_ADMIN_PASSWORD` were already attached from Secret
Manager. Only `DATABASE_URL` was absent — both from the service spec and from
the GitHub `DATABASE_URL` production secret, which is empty. The preflight
refuses to roll out without it, so every recovery attempt since 2026-08-29
stopped at the same place.

**The database itself is not the problem.** The APEX Supabase project is
`ACTIVE_HEALTHY` and holds live production state — the agent roster, the
researched-lead pipeline, and the full task and memory history. Losing it
would be unrecoverable.

So the rule for this failure is narrow:

> Restore the connection string. **Never provision a new database.**
> A fresh, empty Postgres makes the deploy go green while silently orphaning
> production data — the failure mode this runbook exists to prevent.

The deploy workflow resolves the credential from, in order:

1. the GitHub `DATABASE_URL` production secret;
2. a Google Secret Manager secret named `apex-database-url`, `apex-db-url`,
   `apex-supabase-database-url`, `apex-postgres-url`, `database-url`, or
   `DATABASE_URL`.

A Secret Manager match is preferred and attached with `--update-secrets`, so
the DSN stays off the revision spec. When nothing matches, the run lists the
secret **names** that do exist in the project (never values) and writes the
exact recovery commands to the job summary.

To restore, store the existing Supabase DSN — do not mint a new database —
and grant the runtime service account read access:

```bash
printf '%s' "$APEX_DSN" | gcloud secrets create apex-database-url \
  --project "$APEX_GCP_PROJECT_ID" --replication-policy=automatic --data-file=-

gcloud secrets add-iam-policy-binding apex-database-url \
  --project "$APEX_GCP_PROJECT_ID" \
  --member "serviceAccount:$APEX_RUNTIME_SERVICE_ACCOUNT" \
  --role roles/secretmanager.secretAccessor
```

Then re-run *Deploy to Cloud Run*. Verification is unchanged: the public
health endpoint must report the intended `build.sha`, and anonymous
`/api/tasks` must still return 401.

Note that APEX's startup path tolerates an unreachable database — `migrate()`,
`loadSettingsIntoEnv()`, `initializeTokenLedgerPersistence()` and
`recoverStaleLeasedTasks()` each swallow their own failures so the HTTP
listener still binds. A revision can therefore go Ready while the agents have
no durable state at all. Treat "the service is up" and "APEX has its brain"
as two separate checks.

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

## Durable artifact store, sandbox executor, and cron governance (2026-09-06)

The autonomous-execution scheduler adds three operator-configured GCP-scoped resources. Real values are configuration, never guessed (ADR-010):

- `APEX_ARTIFACT_BUCKET` — GCS bucket in the existing project/region, created once:
  `gcloud storage buckets create gs://<name> --location=<region>`.
  Artifact/workspace tools fail closed when unset. Give the runtime service account `roles/storage.objectUser` on the bucket (Workload Identity on Cloud Run authenticates the control plane; the executor job uses the same image and can use its own job service account with the same role).
- `APEX_EXECUTOR_JOB` — Cloud Run Jobs resource name (e.g. `apex-executor`). Until set, the 30-second dispatch loop is a no-op and `executor_dispatch` cron fires report "no-op". Create once with the same project/region, image = the same immutable SHA image, task timeout ≤ 60 min, no HTTP (jobs API), args = task id (dispatch passes `--args=<taskId>` via `gcloud run jobs execute`). This is a new GCP resource — it is NOT the control-plane service, so ADR-001/002 release rules are unchanged: APEX's own deploy still goes through `gcloud run services update` on the existing service.
- `GITHUB_TOKEN_4` (existing) needs `repo` create scope for `create_github_repo`; `APEX_GITHUB_ORG` defaults to `patriotnewsactivism`.

Autonomy mode: a project (`projects`) with `autonomyLevel` in the autonomy modes and a non-empty `autoapproveTools` list may auto-approve only the bounded eligible set (push/PR, `create_github_repo`, `deploy_via_hook`, `create_workstream`, `run_executor_job`, `publish_artifact`). Hard-gated tools are never auto-approvable regardless of the list.

### Incidents

- **Bucket auth broken**: `store_artifact`/`sync_workspace` throw with an actionable error and the task records the failure; nothing is silently dropped (the tool result carries the error). Check the runtime service account's storage roles and Workload Identity binding; `ArtifactStore.ping()` in /api diagnostics or a `store_artifact` call reports the state.
- **Executor job queue backlog**: tasks with `context.runtime='job'` sit `pending` with no `dispatchedAt`. Check `APEX_EXECUTOR_JOB` is set, `gcloud run jobs execute` works from the control-plane identity (`gcloud run jobs list`), and the dispatch loop log line `[executor-dispatch]`. Dispatch failures retry with durable backoff; claimed-but-crashed jobs recover via the task lease semantics (executor tasks are exempt from the in-process 10-min sweep — their wall clock lives in the job).
- **Cron explosion**: the governor pauses offending jobs (frequency floor 15 min, ceiling `APEX_MAX_DYNAMIC_JOBS` default 25, per-workstream 3) and writes `cron-governor:health` memory; `GET /api/jobs` shows `error` text on paused rows.

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
