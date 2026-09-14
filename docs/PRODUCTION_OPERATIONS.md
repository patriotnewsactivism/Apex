# APEX Production Operations Runbook

This runbook governs ordinary APEX production releases, verification, rollback, and first-response incident handling.

APEX production is the **existing Google Cloud Run service** behind:

`https://apex.donmatthews.live`

The retired AWS Lightsail/CodeBuild and Railway hosting paths are not production fallbacks. Planned Railway portability (not a live cutover) is documented in `docs/HOSTING_MIGRATION.md`. Zero-cost OpenRouter policy is documented in `docs/FREE_ONLY_MODEL_POLICY.md`.

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
| `cap` | `APEX_REQUEST_CAP_TOTAL`, default 2800 |
| `projected` | Requests/day at today's rate. **This is the number to compare against the provider allowance.** `null` before 00:15 UTC, when too little has elapsed to extrapolate honestly |
| `releasedSoFar` | How much of the cap the pacing ramp has released so far today |
| `lastMinute` / `ratePerMinute` | Requests in the last 60s against the short-window limit. **Watch this, not just `used`** — a day fully under budget can still be spent in half an hour |
| `accounts[]` | Per-account split. Accounts are grouped by the **key itself**, not the env var name: APEX reads OpenRouter keys from `OPENROUTER_FREE_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_API_KEY_2`, and `OPENROUTER_API_KEY_4` across three real qualifying accounts. `OPENROUTER_API_KEY_3` is burned and is not a roster member. Names holding the same key appear as one row and are not independent capacity. |
| `persistence` | `memory-only` means a restart reset today's count; a deploy would then hand the workforce a fresh full allowance |

**Cadence x maxPerRun is the demand knob.** A job's cost is its firings per day
multiplied by how many tasks each firing creates, and the second factor is the
one that hides: `system-delegation-followup` at `*/20` with `maxPerRun: 8` was
576 task-creations/day on its own. When the budget binds and the workforce sits
in `workforce_paused`, cutting `maxPerRun` reduces demand without delaying
anything, whereas stretching cadence alone leaves each firing as expensive as
before. A change to either is inert unless `systemDefinitionVersion` on that job
also goes up — the sync block skips rows whose version has not increased, and a
job with no version at all is never synced.

There are two limits and they protect against different things. The daily cap
bounds the day's total; the short-window limit (`APEX_REQUEST_RATE_PER_MIN`,
default 15) bounds any single minute. On 2026-09-12 only the first existed, and
APEX issued 1,388 requests in 26 minutes — comfortably under the day's budget,
and enough to trip OpenRouter's own per-minute limiter and park every provider
until the UTC reset.

**The cap is clamped to the accounts actually observed.** `llmRequests.cap` is
`min(configuredCap, observedAccounts x 1,000)`; `/health` reports both halves so
a number that disagrees with configuration explains itself. The clamp only ever
lowers the ceiling, and only on real probe data — a probe that has not reported
leaves the configured value alone, so a network hiccup cannot starve the
workforce by pretending there are fewer accounts than there are.

This exists because the request ledger fingerprints KEYS while OpenRouter meters
ACCOUNTS. On 2026-09-14 the credit probe found **3 live keys across 2 accounts**
(`OPENROUTER_FREE_API_KEY` and `OPENROUTER_API_KEY_2` share one), so a cap of
2,800 exceeded the true ceiling of 2,000 and APEX would have spent the
difference collecting 429s while its own budget still showed headroom. Read
`providerCredits.uniqueAccounts` and `sharedQuota` to see the real picture; a
new key raises the ceiling only if it belongs to a NEW account.

**The same mapping is what the load balancer levels.** The credit probe
publishes each key’s account to the ledger, so `accountRequests` — the number
credentials are sorted on — counts the whole bucket rather than the one key.
Without it a user holding two keys is asked for twice the work of a user holding
one, and the extra lands on the more exhausted of the two: measured the same day
at 14:30 UTC, **508 + 508 = 1,016 requests through a 1,000/day account while the
other sat at 737**, 263 short of its own ceiling. On `/health`, two
`accounts[]` rows carrying the same `openRouterAccount` are one bucket, and both
report that bucket’s combined `accountRequests`. A key the probe has not
resolved stays its own account — guessing a grouping would halve the capacity of
a workspace whose keys really are independent.

Per-account daily ceilings are deliberately **not** enforced as a second gate.
The total cap already bounds the day at `observedAccounts x 1,000`, and stacking
a second paced window on top would park accounts that the ramp had simply not
caught up with yet. Even distribution is what keeps each bucket under its own
ceiling; if `accounts[]` shows one `openRouterAccount` far ahead of another,
that is the ordering regressing, not a missing cap.

**Free throughput scales with ACCOUNTS, not models.** OpenRouter's free
allowance is a per-account daily request budget shared across every `:free`
model at once — confirmed live on 2026-09-12 by an HTTP 429 carrying
`free-models-per-day-high-balance`, `X-RateLimit-Limit: 1000` and
`limit_source: openrouter_free_tier_daily`. Adding more free *models* buys
nothing against it (all three rungs went into cooldown together, because they
draw on one bucket); adding a key for another account buys a whole extra
1,000/day. `OPENROUTER_API_KEY_4` is wired for exactly that — set it and load
balancing picks the account up with no other change. It has to be a key from an
account APEX does not already hold: a second key on an existing account raises
neither the ceiling nor the throughput, and `providerCredits.sharedQuota: true`
is how that mistake announces itself.

There is no paid credential list. The $10 historical deposit on each qualifying
account exists only to lift its `:free` tier from ~200/day to 1,000/day.
Spending that balance on paid tokens is how the retired chain reached HTTP 402
on 2026-09-12 while three accounts' free allowance sat unused. A 402 now cools
that account and rotates; it cannot select a paid model.

Note also that some free models are gated: `thinkingmachines/inkling:free` and
`inkling-small:free` return `403 — only available on agentic harnesses` for
direct API use, and need the app registered at openrouter.ai/apps.

Credentials are tried **least-loaded first**, so several accounts share a quota
instead of the first one absorbing everything. Before that change one key took
1,299 of 1,388 requests (94%) and was driven past its daily limit while the
other two sat on 15 and 52 — three accounts delivering barely one account's
worth. "Least-loaded" is measured per ACCOUNT (see the clamp section above), so
compare `accounts[].accountRequests` between distinct `openRouterAccount`
values; comparing `requests` between rows that share one account will always
look lopsided and mean nothing.

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

### Reading `llmSpend` (paid budget)

APEX runs free-first with a paid rung behind it. The two are rationed
differently and neither substitutes for the other: free inference is limited by
REQUEST COUNT (1,000/account/day, shared across every `:free` model), paid
inference by MONEY. A paid request therefore consumes none of the free
allowance, and is excluded from `llmRequests` on purpose.

| `state` | Meaning |
|---|---|
| `available` | Paid rung is in the routing order |
| `paced` | Budget exists but the ramp has not released it yet; clears shortly |
| `daily_cap` | Budget spent. **The paid rung drops out and APEX runs free-only** — the intended fallback, not an outage |
| `disabled` | `APEX_DAILY_SPEND_USD=0`, or the rung is not enabled |

Paid routing needs BOTH `APEX_PAID_FALLBACK=confirmed` (paid is allowed) and a
non-zero `APEX_DAILY_SPEND_USD` (this much). A zero cap means spend nothing —
money fails closed, where the request budget's `0` means uncapped.

At DeepSeek V4 Flash list price ($0.06/M in, $0.12/M out), $2/day buys roughly
1,000–3,300 requests depending on prompt size. Read `spentUsd` and
`projectedUsd` rather than trusting that estimate.

Two details that exist because they were got wrong first: cost is charged from
OpenRouter's settled `cost` figure, falling back to list price when it is
absent — recording zero there would let an unpriced response spend from the
budget for free. And a small reserve is held back before admitting a paid call,
because cost is only known after the response returns: without it a $2.00 cap
settled at $2.0004, and the overshoot multiplies with concurrency.

### Reading `providerCredits`

APEX's automatic routing chain is **zero-cost / free-only**. Nothing on the
default path or a persisted production policy can spend money. An empty
OpenRouter credit balance must never trigger paid inference; exhaustion is a
capacity pause.

Current automatic order:

1. `nex-agi/nex-n2.5-mini:free`
2. `nex-agi/nex-n2.5-pro:free`
3. `nvidia/nemotron-3-super-120b-a12b:free`
4. `nvidia/nemotron-3.5-lightning:free`
5. `openrouter/free`
6. `nvidia/nemotron-3-ultra-550b-a55b:free`

On 2026-09-12 the account held $20 of credits against $24.28 of usage. The
routing chain was paid-only, there was no free rung to fall through to, and
**every LLM request returned HTTP 402** while `/health` reported `status: ok`,
`taskQueue.verdict: ok`, 13 live agents and a healthy poll loop. Tasks were
being claimed and every one of them failed. That paid-only arrangement is
retired. A 402 now cools the exhausted account, rotates to another qualifying
free account, and eventually capacity-pauses. It cannot select a paid model.

The credits probe now asks **every live unique key**, not the first one it finds.
`loadedKeys` is how many distinct key strings are bound. `uniqueAccounts` is how
many distinct OpenRouter **users** those keys belong to (`oracct_<8 hex>` of
`creator_user_id`; never the raw user id). `sharedQuota: true` means two env
names are the same OpenRouter account and therefore share one 1,000/day `:free`
bucket — extra keys are not extra capacity.

| Field | Meaning |
|---|---|
| `loadedKeys` | Distinct inference keys currently bound |
| `uniqueAccounts` | Distinct OpenRouter users those keys belong to |
| `sharedQuota` | `true` when `loadedKeys > uniqueAccounts` |
| `accounts[].env` | Env name(s) holding that key |
| `accounts[].account` | Public account identity (`oracct_…` or `keyfp_…` if OpenRouter omitted the user id) |
| `llmRequests.accounts[].openRouterAccount` | The same identity on the request meter — rows sharing it share one free daily bucket |
| `llmRequests.accounts[].accountRequests` | Requests today across every key on that account: what the free tier meters and the balancer levels |
| `accounts[].dailyLimit` | OpenRouter-reported rate-limit `requests` for that key, when present |
| `management[]` | Optional management-key inventory. `liveInferenceKeyMatched` is whether this OpenRouter account listed a key APEX is actually using |

Optional management keys (`OPENROUTER_MGMT_KEY`, `_2`, `_3`, `_4`) are created at
https://openrouter.ai/settings/management-keys — one per independent OpenRouter
account. They cannot run completions. APEX uses them only to list that account's
inference keys. They never auto-create, disable, or rotate a production key.
Bind them as GitHub secrets of those names; the Cloud Run update will pick them
up. Do not paste management keys into chat.

| `status` | Meaning |
|---|---|
| `ok` | The most-alarming probed account is above $2. Informational only — production inference does not spend it. |
| `low` | Under $2. Informational only. Free `:free` routing is unaffected. |
| `exhausted` | At or below zero on at least one account. Free routing is unaffected. Paid models cannot be selected; APEX capacity-pauses if free capacity is also gone. |
| `unknown` | No key configured, or the lookup failed. `detail` says which |

The balance is cached for 10 minutes and fetched in the background: `/health`
never awaits it, because a health endpoint that hangs on a third party is a
worse outage than the one it reports. The credits and key-identity endpoints
are account lookups, not generations, so they consume none of the daily request
allowance and are deliberately not counted in `llmRequests`.

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
