# APEX Full-Execution Autonomy: Durable Workspace, Sandbox Executor, and Autonomous Scheduling

## Goal

Let the user hand APEX a real piece of work ("build X", "write Y document") and have APEX plan, execute, and ship it unattended — producing durable documents, modules, applications, and websites — then keep finding and executing more work 24/7 through a self-growing cron/task machine. Today APEX delegates a lot but cannot durably execute or store finished work: the container filesystem is ephemeral, there is no object store, no real sandbox, and cron growth is deliberately capped and narrow.

## Decisions (user-confirmed)

1. **Budget**: Free-first OpenRouter chain (MiniMax M3 Free → Nemotron 3 Ultra Free), **no hard spend caps**. Rate-limit pauses are normal backpressure. Existing pacing/token reservation stays on.
2. **Deliverable homes**: Code → **new GitHub repos per workstream** (branch/PR flow). Documents/non-code artifacts → **GCS bucket**. APEX can also push to hosting platforms via **registrable deploy hooks**.
3. **Governance**: optional **per-project autonomy mode**. Inside it, APEX may auto-approve a bounded class (push/PR on APEX-created repos, deploy via registered hooks). **Hard-human gates forever**: `deploy_to_environment` (APEX prod Cloud Run), `rollback_deployment`, `make_outbound_call`, secret/billing actions, `runShell` (unless the new sandbox model is used).

## Current-State Facts (verified 2026-09-06)

- Durable scheduler exists: `scheduled_jobs` + `JobScheduler` (60 s poll, cron via `background-jobs/cron-parser.ts`), 14 handlers, seeded roster in `api-server/src/index.ts:66-311`, one catch-up run after downtime.
- `schedule_task` tool restricts agent-created jobs to 4 job types (`tool-registry.ts:1269`).
- Self-scheduling exists but bounded: `WorkforcePlannerJob` (hourly, per-project cap), CEO schedule tools, `PromptSelfImproveJob`.
- Tools: `writeFile` (ephemeral `/app` FS, auto), `runInSandbox` (temp dir, 10 s, no isolation, auto), `runShell` (gated, 30 s), CI runners (typecheck/lint/build in isolated checkout, auto), `push_to_remote`/`create_pull_request` (gated), `deploy_to_environment` = APEX-only Cloud Run (gated).
- **No bucket/storage code anywhere** (no `@google-cloud/storage`), no artifact tables, no upload endpoints, `TaskResult.artifacts` is dead (`types.ts:180-186`).
- Approval gate = single boolean at one choke point (`ToolRegistry.execute` `tool-registry.ts:66-75`); per-role allowlists exist; `projects.autonomyLevel` enum already exists (`schema.ts:36`).
- APEX runs on Cloud Run (ADR-001/002): existing-service-only updates, immutable SHA images, health-verified releases.

## Target Architecture

```text
User request (chat create_goal / dashboard)
        │
        ▼
work_generation cron (every 10–15 min) ── plans next batch from goals,
        │                                 opportunities, open workstreams
        ▼
tasks table (runtime: 'job' for heavy work) ──► packages/executor = Cloud Run Jobs sandbox
        │                                        1. claim task  2. sync GCS workspace
        ▼                                        3. agent loop (≤60 min)  4. push artifacts
normal agent loop (≤10 min)  ◄──┐                5. complete/fail
        │                        │
        ▼                        │
artifacts table + GCS bucket ◄──┘   [documents, builds, output, rendered sites]
        │
        ├─► GitHub repo per workstream (branch → PR), code deliverables
        └─► deploy_hooks table → Vercel-style webhooks for live sites/apps

cron_governor cron (hourly): enforce ceilings/frequency floor, prune runaway
                            dynamic crons, report health; permits crons creating
                            crons ONLY within the governed ceiling.
```

## Phases (ordered implementation tasks)

### Phase 0 — Configuration prerequisites (operator, not code)

1. Real values, never guessed (AGENTS.md): create GCS bucket in the **existing** GCP project/region (`gcloud storage buckets create gs://<name> --location=<region>`), set env vars `APEX_ARTIFACT_BUCKET`, keep Secret Manager refs (Cloud Run service update preserves them).
2. Confirm GitHub PAT with `repo` create scope (existing `GITHUB_TOKEN_4` may need widening) → `GITHUB_TOKEN_4` used by new `create_github_repo`.
3. Record exact values in `.env.example` (names only) and `docs/PRODUCTION_OPERATIONS.md`; no placeholder in code paths that fail closed.

### Phase 1 — Durable artifact store (the bucket)

1. Add `@google-cloud/storage` to `packages/core` deps (check pnpm workspace).
2. New `packages/core/src/artifact-store.ts`: `ArtifactStore` class — `upload(taskId, projectId, filename, buffer/stream, mime)`, `download(objectName)`, `list(prefix)`, object names `projects/<projectId>/<taskId>/<filename>`; bucket name from `APEX_ARTIFACT_BUCKET`; fail closed when unset and tool invoked.
3. `lib/db/src/schema.ts`: add `artifacts` table (`id`, `taskId` FK, `projectId`, `objectName`, `fileName`, `mimeType`, `sizeBytes`, `sha256`, `publicUrl` null|string, `kind` enum default `document|build|code|other`, `createdAt`); plus idempotent DDL in `lib/db/src/client.ts` beside other tables (~line 386).
4. New tools in `tool-registry.ts` (auto-approved, workspace-class):
   - `store_artifact` — upload arbitrary bytes (from path written by `writeFile`, or inline content) into the bucket; inserts `artifacts` row; returns object URL (authenticated signed URL or public read config).
   - `read_artifact` — download content back for rework.
   - `list_artifacts` — prefix/task/project listing.
   - `publish_artifact` (optional in autonomy mode only, else gated) — make artifact public and return shareable URL.
5. `packages/api-server/src/routes/artifacts.ts`: `GET /api/artifacts?project=&task=&kind=`, `GET /api/artifacts/:id/download` (admin-auth except public redir), `POST /api/artifacts` (admin upload). Register route in `index.ts`.
6. Make `TaskResult.artifacts` live: on `taskQueue.complete()` in `base-agent.ts:751` area, sync `result.artifacts` paths → `store_artifact` (best-effort, never fails the task) and persist JSON list in `tasks.result_artifacts` (new column) so results carry real links.
7. Guard: `scripts/verify-artifact-store.ts` — asserts storage client wired, table exists in schema, tools registered; add to `.github/workflows/ci.yml` and README dashboard "Artifacts" view (bucket objects + table rows).

### Phase 2 — Code deliverables and deploy hooks

1. `create_github_repo` tool (`tool-registry.ts`): creates repo `<workstream>-<slug>` under the org, initializes with README, returns clone URL; **gated** by default, auto-only under autonomy-mode project policy.
2. New table `deploy_hooks` (`schema.ts` + DDL): `id`, `projectId`, `name`, `hookUrl` (secrets ref), `platform` (vercel|railway|render|custom), `active`, `lastStatus`, `createdAt`.
3. Tools: `register_deploy_hook` (admin/gated; stores url in `integration_settings`-style secret refs, never logs value), `list_deploy_hooks`, `deploy_via_hook` (POST webhook, records `lastStatus`; gated by default, auto under autonomy mode), `get_deploy_status` (reads hook/poll status endpoint).
4. After successful deploy, `store_artifact` a `deployment.txt`/summary doc with live URL into the bucket and record in `deployments` table (`platform='hook'`).
5. Dashboard: project page shows repo URL, artifacts link list, deploy hook status.

### Phase 3 — Durable workspace (sync layer over the ephemeral FS)

1. `workspaces` concept: every project has prefix `projects/<projectId>/workspace/<worktreeName>/` in the bucket.
2. Tools in `tool-registry.ts`:
   - `init_workspace` — snapshot current tree (or `writeFile`-created tree) to prefix.
   - `sync_workspace` — pull prefix to local temp dir (checksum-diff, skip unchanged).
   - `push_workspace` — upload changed files back (checksum-diff); called by task completion auto-hook and by model mid-task.
3. `writeFile`/`readFile`/`listDir` gain optional `workspace` context param resolving to the synced dir — default remains `/app`.
4. On executor start and on task completion, auto-sync (best-effort) so no work is lost to instance recycle.
5. Guard `scripts/verify-workspace-sync.ts` (checksum round-trip determinism) + CI wiring.

### Phase 4 — Sandbox executor (Cloud Run Jobs)

Rationale: in-process `runInSandbox` caps at 10 s, no isolation, dies with the instance. Heavy builds (npm install, site render, test suites) need minutes and isolation. Cloud Run Jobs = same GCP project/region (ADR-001 compatible), ≤60 min, retry, Workload Identity.

1. New package `packages/executor`:
   - `src/main.ts` entrypoint (`start:executor` script): argv = taskId; claim via new `taskQueue.claimById(taskId)` (guarded lease like 140-209); if unclaimable exit 0 (someone else won); set `context.runtime='job'`.
   - Sync workspace (Phase 3) → run the existing `instrumented-base-agent` `executeTask()` loop with `EXECUTOR_MAX_TURNS` budget and 55-min wall clock; `runShell` policy applies only inside autonomy workstreams; push workspace + artifacts; `complete()/fail()`; exit code for job.
2. Dispatch: in `packages/core/src/task-queue.ts` add `runtime: 'job'` column/context: tasks with `runtime='job'` are not local-executed; `packages/executor/src/dispatch.ts` (or background job `executor_dispatch`, cron every 30 s) calls `gcloud run jobs execute apex-executor --args=<taskId>` via `execFile` (same pattern as `cloud-run-deployer.ts:97`); non-claimed dispatches are no-ops.
3. New tool `run_executor_job` (gated by default; auto within autonomy mode): enqueues a `runtime='job'` task and returns job id; plus `get_executor_status` (auto).
4. Cloud Run Job resource created once with exact real project/region/name (new GCP resource — document as such; NOT the control-plane service, so ADR-002 unchanged).
5. Guard `scripts/verify-executor-dispatch.ts` (claim-by-id, runtime routing, artifact push) + CI.

### Phase 5 — Autonomous scheduling machine

1. **Work generation cron**: new handled job type `work_generation` seeded every **10 min** (target `apex-coo-001`): scans open goals, `opportunities`, unfinished workstreams, and the improvement backlog; plans 1–N concrete tasks (dedup via existing `hasOpenTaskWithPrefix` + unique index) and enqueues them. Add handler in `background-jobs/src/handlers/index.ts` following `TaskDelegationJob` pattern (168-181); seed row in `api-server/src/index.ts:66-311`.
2. **Workstreams**: extend `projects` with `workstreams` jsonb or new `workstreams` table (id, project, name, goal link, repoUrl, artifactPrefix, scheduleHint, autonomyLevel). `work_generation` plans per open workstream; `create_workstream` tool (gated default, auto in autonomy mode).
3. **Expand agent-created cron types**: `schedule_task` enum (`tool-registry.ts:1269`) grows from 4 to all handled types plus `work_generation`, `executor_dispatch`, `report_generation`.
4. **Cron governance (the crons-creating-crons governor)**:
   - Ceilings: total dynamic jobs (`MAX_DYNAMIC_PROJECT_JOBS` pattern from `opportunity-jobs.ts:226-229`), per-workstream 3, frequency floor ≥15 min `nextRunAt` spacing (enforced at insert in `schedule_task`).
   - New handled job `cron_governor` (hourly): lists all `scheduled_jobs`, disables/pauses jobs breaching ceiling/floor, prunes `status='failed'` storms, writes summary memory; seeded like others.
   - Governor itself is the only path allowed to *create* dynamic crons beyond the per-project workstream jobs (bounded recursion: workstream → cron → workstream; depth capped 1 level of expansion).
5. **Autonomy-mode approval policy**:
   - Extend `projects` with `autoapproveTools: string[]` jsonb (empty default). `ToolRegistry.execute` (`tool-registry.ts:66-75`) consults new `ApprovalPolicy.evaluate(toolName, task, project)` before `requestHumanApproval`: if project.autonomyLevel==='autonomous' && tool ∈ autoapproveTools && task belongs to project → proceed; else existing gate.  Hard-gated set (see Decisions) is never auto-approvable even in list.
   - Persist hard list in `packages/core/src/approval-policy.ts` + guard script asserting no hard-gated tool appears auto-approvable.
6. **Missed-run ledger** (optional but recommended): `scheduled_jobs` gains `missedRuns` int + `catchUpMode` ('collapsed'|'none'); keeps single catch-up default, prevents double-fire after long downtime.
7. Guard `scripts/verify-autonomy-scheduler.ts` extension + new `scripts/verify-cron-governor.ts` (ceilings/floor/hard-set) + CI.

### Phase 6 — Rollout, verification, docs

1. Dev verification: `pnpm install --frozen-lockfile` → `pnpm run typecheck:production` → all determinist guards → `pnpm run build` (dashboard) → run API+worker locally against dev DB with local emulator/GCS.
2. Production: normal release path — reviewed commit on main → green CI → Cloud Build immutable SHA image → `gcloud run services update` existing service → `/health` sha + healthy `taskQueue.verdict` → smoke: submit demo task («build a static one-page site for X»), watch work_generation→task→executor→artifacts→hook deploy end-to-end; record evidence in `deploy-provenance.md`.
3. Docs: update AGENTS.md (new tools, autonomy mode, hard-gated list, bucket/workspace rules), ARCHITECTURE_DECISIONS.md (new ADR: GCS artifact store + Cloud Run Jobs executor + cron governance ceiling), PRODUCTION_OPERATIONS.md (bucket env, executor job, incident: bucket auth, job queue backlogs), README, CHECKLIST.
4. Guard scripts registered in `.github/workflows/ci.yml`; dashboard surface: Artifacts page, Workstreams view, Cron registry page (`GET /api/jobs` exists), autonomy toggle in project settings.

## Failure modes & guardrails

- **Instance recycle loses work**: executor + GCS workspace sync (Phase 3/4) make it durable; `push_workspace` runs before `complete()`.
- **Cron explosion**: governor ceilings/floors + dedup; new dynamic job creation only via governor-approved paths; circuit: if dynamic job count exceeds ceiling, governor pauses creation 1 h and escalates.
- **Bucket auth broken**: tools fail closed with clear error; health check includes bucket liveness (optional component in `health-monitor`).
- **Free-model rate limits**: existing backpressure/pacing handled; work_generation treats pauses as deferral, not failure (existing `getLLMPauseRetryAt`).
- **Executor job stuck**: job timeout (55 min) + task hard-timeout quarantine already exists (`task-queue.ts:284-297`); executor exit codes recorded in `job_execution_log`.
- **Token burnout**: pacing remains; no new caps per decision.
- **Deploy hook leaks**: hook URLs stored secret-ref style (never logged; existing rule).

## Validation plan

1. Unit-level: artifact round-trip (upload/download/list, sha match); workspace sync round-trip determinism; executor claim-by-id contention (two dispatchers, one wins); governor ceiling/floor unit tests.
2. Deterministic guards listed per phase must pass; full CI green.
3. Local E2E: seed workstream → work_generation enqueues → executor runs → bucket contains artifacts → hook fires (mock) → task completes with URL links.
4. Prod smoke per Phase 6 step 2; record unverified items.

## Out of scope / explicit non-decisions

- No host change (ADR-001 holds); Convex remains experimental; schedule-task enum expansion does not enable unseeded job types outside governance (no new route).
- No removal of `runShell` gates globally; no auto-approval of hard-gated tools ever; no removal of task dedup/backpressure controls.
- `.apex/crons.json` still out of scope (comment-only legacy).
- Real values (bucket name, task executor job name, deploy hook URLs, org name) are configuration, never guessed; plan assumes operator-supplied values in Phase 0.

## Open items for implementer

- Exact bucket name/region and Cloud Run Jobs resource name → from operator config, not code.
- Whether GitHub org token needs widening (operator check) — code uses existing `GITHUB_TOKEN_4` env seams.
- Whether executor dispatch uses `gcloud run jobs execute` CLI (existing CLI pattern) or `google-cloud-run` Node client → CLI first, client later.