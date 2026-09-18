# APEX hosting migration plan

## Current status — CUTOVER COMPLETE (2026-09-15)

**Railway is production.** Project `APEX`, service `apex-backend`, region `ams`, one replica, built from the repository `Dockerfile` per `railway.toml`, health-checked on `/health`, deploying itself from `main`. The custom domain `apex.donmatthews.live` resolves to it.

The plan below was written as preparation and was executed under pressure rather than in phases: Google Cloud Run stopped serving on 2026-09-14 when billing was disabled on project `apex-503709` — every route returned 503, and the image push was denied with "This API method requires billing to be enabled", so redeploying it was not an option either. Phases 2 and 3 (parallel rehearsal, then a planned freeze-and-switch) did not happen; the cutover was forced.

What that leaves open, and what is verified, is tracked in "Post-cutover state" below. The phase descriptions are retained as the record of intent, not as instructions.

The service reuses the existing external durable database and existing secret names. The existing Dockerfile, long-running Node API, WebSockets/background workers, Chromium tooling, runtime Git tooling, `/health`, and `PORT` support are the deployment artifact. Vercel project `don-matthews/apex` is a GitHub-status dashboard build (`vercel.json` → `@workspace/dashboard` only); do not redesign the APEX backend into Vercel serverless functions, and do not treat the GitHub `Vercel` status as a Railway gate.

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

### Vector recall: fixed by matching the runtime libc (2026-09-15)

Deploy logs show this every 30 seconds to two minutes:

```
Local embedding pipeline unavailable: Error loading shared library
ld-linux-x86-64.so.2: No such file or directory
(needed by .../onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so.1.14.0)
Vector recall failed, falling back to keyword search
```

The runtime stage was `node:22-alpine` (musl) while the builder was
`node:22-slim` (glibc). `@xenova/transformers` pulls `onnxruntime-node`, whose
prebuilt binary is glibc-linked and needs a loader Alpine does not ship. Both
the Alpine runtime and that dependency arrived in the same commit (`71b8633`,
2026-08-28), so semantic memory recall never worked in this image — Cloud Run
included. It was not a cutover regression; Railway's logs were simply the first
place anyone read it.

It degraded rather than failed, which is why it lasted: `memory.ts` catches the
error and falls back to keyword search, so agents kept working with worse recall
and nothing ever went red.

**The runtime stage is now `node:22-slim`, matching the builder.** That is the
invariant the split violated: the runtime stage runs `pnpm install` against the
same lockfile the builder resolved, so its libc has to be the one those prebuilt
native modules were built for. `apk` becomes `apt-get`, and the hand-listed
`nss`/`freetype`/`harfbuzz` packages go away because apt resolves them as
chromium's own `Depends`.

Chromium needed no code change: `tool-registry.ts` and `cicd-worker`'s
`browser.ts` already probed `/usr/bin/chromium` alongside Alpine's
`/usr/bin/chromium-browser`, so Debian's path was covered before the move.

`scripts/verify-deploy-provenance.ts` now fails if the two stages diverge again,
or if a base swap leaves the wrong package manager behind. A defect that
degrades silently needs a check that does not.

**Confirm it in production** after the deploy: the
`Local embedding pipeline unavailable` and `Vector recall failed` lines should
stop appearing in the Railway deploy logs. A first-run model download from
Hugging Face is the next thing that could fail here, and only production will
say whether it does.

### Outstanding after the forced cutover

1. **Lead-research credentials.** `BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`, and `TAVILY_API_KEY` are on Railway. `GOOGLE_PLACES_API_KEY` and `YELP_API_KEY` are still absent (not in local env either — do not invent values).
2. **`OPENROUTER_API_KEY_4` bought no capacity.** It is a second key on an account APEX already holds. A third *account* is what raises the free cap.
3. **The Cloud Run deploy still fires on every green CI run** unless `APEX_DEPLOY_ENABLED` is not `production`/`all`. Keep it off while billing is disabled.
4. **Railway Wait for CI is on** (`checkSuites=true` on the `main` GitHub trigger). A red `production-checks` run is skipped. The GitHub `Vercel` status is the dashboard static build and is not this gate.
5. **One replica** (`ams`). Websocket tickets now persist in Postgres so a second replica is no longer blocked on in-memory tickets. Scale only after a live two-process ticket round-trip is proven.
6. **Artifacts / executor.** `APEX_ARTIFACT_DIR=/data/artifacts` on volume `apex-artifacts`. Leave `APEX_EXECUTOR_JOB` unset on Railway; `APEX_EXECUTOR_MODE=inprocess` is set.

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

A Vercel GitHub integration already builds the static React/Vite dashboard (`don-matthews/apex`, `vercel.json` dashboard-only). The operator UI that serves production traffic is still the Railway service at `https://apex.donmatthews.live`. A real frontend split still requires an explicit API/WebSocket base URL plus CORS, cookie/auth, WebSocket-ticket, and mobile-layout tests. Do not treat a green GitHub `Vercel` status as proof that APEX production moved.

## No-money constraints

Do not assume Railway, Vercel, or any other host is permanently free. Before the actual cutover, verify the account's current credits/free allowance and set hard usage/billing limits where the provider supports them. The migration work in this branch is portability preparation; it does not authorize incurring hosting charges.

## Rollback

A cutover is reversible while the old service exists: restore the previous DNS/API origin, stop Railway schedulers to avoid duplicate work, and verify the database was not forked or migrated. Because APEX state is external, rollback should not depend on copying container-local files.