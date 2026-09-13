# APEX hosting migration plan

## Current status

A private empty Railway project named `APEX` already exists. **No Railway service has been deployed.** This branch is portability preparation only. Do not deploy Railway, modify Cloud Run, move DNS, create a replacement database, duplicate the production scheduler, copy secrets into source control, or incur a hosting charge without a separate explicit operator instruction after CI is green.

The eventual staging service must reuse the existing external durable database and existing secret names. The existing Dockerfile, long-running Node API, WebSockets/background workers, Chromium tooling, runtime Git tooling, `/health`, and `PORT` support are the deployment artifact. Vercel is only an optional later destination for the React dashboard; do not redesign the APEX backend into Vercel serverless functions.

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