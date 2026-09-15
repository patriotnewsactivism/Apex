# APEX hosting migration plan

## Current status — CUTOVER COMPLETE (2026-09-15)

**Railway is production.** Project `APEX`, service `apex-backend`, region `ams`, one replica, built from the repository `Dockerfile` per `railway.toml`, health-checked on `/health`, deploying itself from `main`. The custom domain `apex.donmatthews.live` resolves to it.

The plan below was written as preparation and was executed under pressure rather than in phases: Google Cloud Run stopped serving on 2026-09-14 when billing was disabled on project `apex-503709` — every route returned 503, and the image push was denied with "This API method requires billing to be enabled", so redeploying it was not an option either. Phases 2 and 3 (parallel rehearsal, then a planned freeze-and-switch) did not happen; the cutover was forced.

What that leaves open, and what is verified, is tracked in "Post-cutover state" below. The phase descriptions are retained as the record of intent, not as instructions.

The service reuses the existing external durable database and existing secret names. The existing Dockerfile, long-running Node API, WebSockets/background workers, Chromium tooling, runtime Git tooling, `/health`, and `PORT` support are the deployment artifact. Vercel is only an optional later destination for the React dashboard; do not redesign the APEX backend into Vercel serverless functions.

## Post-cutover state

Verified against the live service on 2026-09-15 (`https://apex.donmatthews.live/health`):

| Phase 1 acceptance check | Result |
|---|---|
| `/health` returns healthy | ✅ `status: ok` on both the Railway domain and `apex.donmatthews.live` |
| `/health` reports the expected build SHA | ✅ since 2026-09-15 16:40 UTC — see "Build provenance on Railway". The first attempt failed; the second is verified in production |
| API authentication remains enforced | ✅ `/api/health` returns 401 |
| Background scheduler/worker loops stay alive | ✅ 13 agents supervised, 13 alive, 0 stalled, 0 restarts; task queue 116/116 with 0 failures |
| Free routing rotates across account buckets | ✅ and this is the proof the per-account balancer works: `oracct_15c46a8a` 358 requests against `oracct_d5f750b6` 352 + 6 = **358**. Two keys on one account, counted as one bucket, dead even with the other |
| Chromium/browser QA can launch in the container | ⚠️ not yet exercised on Railway |
| Runtime Git workspace operations still work | ⚠️ not yet exercised on Railway |

Request budget and spend carried over intact: `cap 2000`, `configuredCap 2000`, `observedAccounts 2`, spend $0.66 against the $2/day ceiling.

### Build provenance on Railway

`/health` reported `sha: "unknown"`, which defeats the first step of release
verification. The first fix assumed Railway injects `RAILWAY_GIT_COMMIT_SHA`
into the container and made `getBuildInfo()` fall back to it. **That assumption
was wrong**, and the fix deployed on 7a023d2 without changing anything: the
service environment carries eleven `RAILWAY_*` variables — `RAILWAY_ENVIRONMENT`,
`RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_NAME`, `RAILWAY_PUBLIC_DOMAIN` and the
rest — and none of them is a git SHA. Railway does not expose the git variables
to this service, so the fallback reads a name that is not there.

The mechanism that does work was already in the Dockerfile:

```dockerfile
ARG APEX_BUILD_SHA=unknown
ENV APEX_BUILD_SHA=$APEX_BUILD_SHA
```

Railway passes a service variable into a Dockerfile build as a build arg, so
setting `APEX_BUILD_SHA` on the service reaches both the build and the runtime.
It is set to the reference `${{RAILWAY_GIT_COMMIT_SHA}}` — Railway resolves
built-in references even where the variable is not listed in the environment.

It was set with deploys skipped, so it took effect on the next deploy rather
than restarting the workforce to prove a point. **That deploy has happened and
it works.** Merging #158 as `47c7d2f` triggered a Railway build, and `/health`
answered 72 seconds after the restart:

```
main HEAD   47c7d2f
/health     build.sha 47c7d2f09afd28dd0a6c83649ae57e247bc209c9
```

So the `${{...}}` reference resolves even though `RAILWAY_GIT_COMMIT_SHA` does
not appear in the service's environment listing — Railway resolves built-in
references at build time regardless. Release verification step one, "confirm
the exact Git SHA that is live", now works on Railway.

`build.builtAt` is still `null`: the matching fallback reads
`RAILWAY_DEPLOYMENT_CREATED_AT`, which does not resolve the same way. The SHA
is what release verification needs, so this is left as a known gap rather than
chased with another guess.

The `RAILWAY_GIT_COMMIT_SHA` fallback in `getBuildInfo()` is kept. It is inert
here, correct where a host does provide that variable, and the explicit
`APEX_BUILD_SHA` outranks it in either case.

### Vector recall is broken, and was before the cutover

Deploy logs show this every 30 seconds to two minutes:

```
Local embedding pipeline unavailable: Error loading shared library
ld-linux-x86-64.so.2: No such file or directory
(needed by .../onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so.1.14.0)
Vector recall failed, falling back to keyword search
```

The runtime stage is `node:22-alpine` (musl), while `@xenova/transformers`
pulls `onnxruntime-node`, whose prebuilt binary is linked against glibc and
needs a loader Alpine does not ship. Both the Alpine runtime and that
dependency arrived in the same commit (`71b8633`, 2026-08-28), so semantic
memory recall has never worked in this image — Cloud Run included. This is not
a cutover regression; Railway's logs are simply the first place it was read.

It degrades rather than fails: `memory.ts` catches it and falls back to keyword
search, so agents keep working with worse recall. Fixing it is a deliberate
choice between adding glibc compatibility to the Alpine runtime, moving the
runtime stage to `node:22-slim` to match the builder, or dropping the local
embedding pipeline in favour of a hosted one — each changes the production
image, so none should be done incidentally.

### Outstanding after the forced cutover

1. **Lead-research credentials were not carried over.** Cloud Run supplied `BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`, `GOOGLE_PLACES_API_KEY`, `YELP_API_KEY` and `TAVILY_API_KEY`; the Railway service has none of them. Lead contact enrichment and lead research degrade accordingly. These are the categories Phase 1 called "search/research integrations", and they matter most for outbound sales work.
2. **`OPENROUTER_API_KEY_4` bought no capacity.** It is wired, but it is a second key on `oracct_d5f750b6`, an account APEX already holds through `OPENROUTER_FREE_API_KEY` — so `uniqueAccounts` is still 2, `sharedQuota` is still true, and the cap stays clamped at 2,000/day. A third *account* is what raises it to 3,000.
3. **The Cloud Run deploy still fires on every green CI run.** It cannot succeed while billing is off, so each merge produces a failed deploy. Setting the `APEX_DEPLOY_ENABLED` repository variable to anything other than `production`/`all` makes the gate skip cleanly and exit 0 — no workflow edit required, and the rollback path stays intact.
4. **Railway deploys without waiting for CI.** The service has `checkSuites: false`, so a push to `main` reaches production whether or not CI passes. The Cloud Run pipeline gated on `workflow_run.conclusion == 'success'`; that gate no longer exists anywhere.
5. **One replica, no redundancy** (`ams`, `numReplicas: 1`). Cloud Run ran `minScale=1, maxScale=1` too, so this is not a regression — but it remains a single point of failure.

## Decision

Prepare **Railway as the first replacement for Google Cloud Run**. Do not use Vercel as the primary APEX backend.

APEX is a long-running autonomous service with WebSockets, background workers, durable task orchestration, browser/Chromium tooling, runtime Git operations, and an existing container image. Railway can run that container continuously. Vercel is a strong optional target for the dashboard later, but moving the backend to serverless functions would require a larger redesign and would risk breaking WebSockets and long-lived worker execution.

## Phase 0 — portability now

Keep the existing Dockerfile as the deployment artifact. The application already binds `process.env.PORT` and exposes `/health`; durable application state remains in external Postgres/Supabase rather than the container filesystem. Treat `.local` as disposable scratch space only.

Add Railway configuration that builds the existing Dockerfile, runs the existing API server command, uses `/health` for readiness, and restarts on failure. Do not create a second database during migration.

## Phase 1 — Railway staging

Create a private Railway APEX project and deploy a staging service from `patriotnewsactivism/Apex`. Copy runtime configuration by variable **name**, not by exporting secrets into source control. Required categories include database/admin credentials, all qualifying OpenRouter free-account keys, search/research integrations, and any telephony/media keys actually used by APEX.

Staging acceptance checks:

- `/health` returns healthy and reports the expected build SHA.
- API authentication remains enforced.
- WebSocket authentication and lifecycle guards pass.
- Background scheduler/worker loops stay alive for at least one hour without restart churn.
- Database reads/writes hit the existing production data store only when explicitly testing production-connected staging; otherwise use a safe staging database.
- Free-only OpenRouter routing reports zero paid automatic routes and rotates across configured account buckets.
- Chromium/browser QA can launch in the Railway container.
- Runtime Git workspace operations still work with `git` installed in the image.

## Phase 2 — parallel production rehearsal

Run Railway with production-equivalent configuration but keep public traffic pointed at Cloud Run. Compare health, task completion, WebSocket behavior, scheduler cadence, request-budget telemetry, and error rate. Do not run duplicate outbound campaigns or duplicate schedulers against the same production database unless one side is explicitly placed in standby mode.

## Phase 3 — cutover

Freeze new deploys to Cloud Run, verify Railway is on the intended commit, switch the public API/dashboard origin or DNS to Railway, and monitor health/task throughput. Keep Cloud Run available only as a short rollback target if it still exists.

## Phase 4 — optional frontend split

After the backend is stable on Railway, the static React/Vite dashboard may be moved to Vercel if desired. If split, configure the dashboard API/WebSocket base URL explicitly and re-run CORS, cookie/auth, WebSocket-ticket, and mobile-layout tests. There is no requirement to split; the lowest-risk configuration is initially one Railway service serving both API and built dashboard.

## No-money constraints

Do not assume Railway, Vercel, or any other host is permanently free. Before the actual cutover, verify the account's current credits/free allowance and set hard usage/billing limits where the provider supports them. The migration work in this branch is portability preparation; it does not authorize incurring hosting charges.

## Rollback

A cutover is reversible while the old service exists: restore the previous DNS/API origin, stop Railway schedulers to avoid duplicate work, and verify the database was not forked or migrated. Because APEX state is external, rollback should not depend on copying container-local files.