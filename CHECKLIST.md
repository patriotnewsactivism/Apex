# Apex Implementation Checklist

Master tracking checklist for the roadmap in `ROADMAP.md`. Only check an item
when it is actually built AND verified (typecheck/build/test + deployed) —
per standing discipline, do not mark ahead of real, confirmed work.

## Phase 1: Foundation (Week 1-2) — CRITICAL

### Health Monitoring System
- [x] Create health_metrics table schema -- shipped in lib/db/src/schema.ts
- [x] Create component_health table schema -- shipped in lib/db/src/schema.ts
- [x] Implement HealthMonitor class -- shipped in packages/health-monitor/ (2ab5eb3/126a292), decoupled from @workspace/core via dependency injection (no cyclic workspace dep)
- [x] Implement database health check — now HealthMonitor.checkDatabase(), tool is a thin wrapper
- [x] Implement LLM providers check — now HealthMonitor.checkLLMProviders() (injected getConfiguredProviders), config presence only, not live connectivity
- [x] Implement memory system check — HealthMonitor.checkMemorySystem(), read-only reachability ping against memories table
- [x] Implement tool registry check — now HealthMonitor.checkToolRegistry() (injected getRegisteredToolCount)
- [x] Implement WebSocket check — HealthMonitor.checkWebSocket() now wired with live wsChecker in api-server
- [x] Create AlertManager class -- shipped in packages/health-monitor/src/alert-manager.ts
- [x] Define alert rules (thresholds specced in ROADMAP.md: component critical, task backlog >50, approval backlog >10, 3+ components degraded)
- [x] Implement alert evaluation logic -- AlertManager.evaluate(report) with deduplication & auto-resolve
- [x] Create health tools — `health_check`, `get_system_status`, `get_active_alerts` shipped in packages/core/src/tool-registry.ts
- [x] Add health API routes (/api/health, /api/health/components, /api/health/alerts, /api/health/history, /api/health/alerts/:id/acknowledge) -- shipped in packages/api-server/src/routes/health.ts
- [x] Update dashboard with health indicators -- HealthPanel shipped in packages/dashboard/src/components/HealthPanel.tsx
- [x] Start health monitoring in main server (60s background polling loop updating DB tables & emitting WebSocket events)

### Background Job System
- [x] Create scheduled_jobs table schema -- shipped in lib/db/src/schema.ts
- [x] Create job_execution_log table schema -- shipped in lib/db/src/schema.ts
- [x] Implement CronParser class -- shipped in packages/background-jobs/src/cron-parser.ts
- [x] Implement JobScheduler class -- shipped in packages/background-jobs/src/job-scheduler.ts
- [x] Implement JobExecutor class -- shipped in packages/background-jobs/src/job-executor.ts
- [x] Create TaskDelegationJob handler -- shipped in packages/background-jobs/src/handlers/index.ts
- [x] Create HealthCheckJob handler -- shipped in packages/background-jobs/src/handlers/index.ts
- [x] Create ReportGenerationJob handler -- shipped in packages/background-jobs/src/handlers/index.ts
- [x] Create MaintenanceJob handler -- shipped in packages/background-jobs/src/handlers/index.ts
- [x] Add job management tools (schedule_task, list_scheduled_tasks, cancel_scheduled_task, get_job_history) -- shipped in packages/core/src/tool-registry.ts
- [x] Create job API routes (/api/jobs, /api/jobs/:id/toggle, /api/jobs/:id, /api/jobs/:id/history) -- shipped in packages/api-server/src/routes/jobs.ts
- [x] Integrate scheduler in main server -- started in packages/api-server/src/index.ts
- [x] Implement graceful shutdown -- wired for both HealthMonitor and JobScheduler on SIGTERM/SIGINT

**Phase 1 Complete Sign-off:** SIGNED OFF — Health Monitoring System and Background Job System fully built, typechecked, and verified across all workspace packages.

## Phase 2: Intelligence (Week 3-4) — HIGH PRIORITY
### Learning & Adaptation System
- [x] Create task_outcomes, learning_insights, strategy_recommendations, performance_baselines table schemas & DDL -- shipped in lib/db/src/schema.ts and client.ts
- [x] Implement OutcomeAnalyzer class -- shipped in packages/learning-system/src/outcome-analyzer.ts
- [x] Implement PatternDetector class -- shipped in packages/learning-system/src/pattern-detector.ts (requires >=5 samples per spec)
- [x] Implement InsightGenerator class -- shipped in packages/learning-system/src/insight-generator.ts (30-day expiring insights)
- [x] Implement StrategyOptimizer class -- shipped in packages/learning-system/src/strategy-optimizer.ts (approval-gated advisory recommendations)
- [x] Wire outcome recording into base-agent.ts -- async non-blocking (<100ms, isolated errors) in executeTask()
- [x] Create learning tools (`analyze_performance`, `get_insights`, `get_strategy_recommendations`, `set_performance_baseline`, `apply_strategy_recommendation`) -- shipped in packages/core/src/tool-registry.ts
- [x] Add learning API routes (/api/learning/outcomes, /api/learning/insights, /api/learning/analyze, /api/learning/recommendations, /api/learning/baselines) -- shipped in packages/api-server/src/routes/learning.ts
- [x] Create dashboard LearningPanel component -- shipped in packages/dashboard/src/components/LearningPanel.tsx under Intelligence tab

**Phase 2 Complete Sign-off:** SIGNED OFF — Learning & Adaptation System fully built, integrated, typechecked, and verified across all workspace packages.

## Phase 3: Autonomy (Week 5-6) — MEDIUM PRIORITY
### CI/CD & Deployment Automation
- [x] Create pipeline_runs, test_results, lint_results, deployments table schemas & DDL -- shipped in lib/db/src/schema.ts and client.ts
- [x] Implement TestRunner class -- shipped in packages/cicd-automation/src/test-runner.ts
- [x] Implement LinterRunner class -- shipped in packages/cicd-automation/src/linter-runner.ts
- [x] Implement BuildManager class -- shipped in packages/cicd-automation/src/build-manager.ts
- [x] Implement DeploymentManager class -- shipped in packages/cicd-automation/src/deployment-manager.ts (health-monitored, automated rollback)
- [x] Create CI/CD agent tools (`run_tests`, `run_lint`, `build_project`, `deploy_to_environment`, `rollback_deployment`, `create_feature_branch`, `create_pull_request`) -- shipped in packages/core/src/tool-registry.ts
- [x] Add CI/CD API routes (/api/cicd/status, /api/cicd/test, /api/cicd/lint, /api/cicd/build, /api/cicd/deploy, /api/cicd/rollback, /api/cicd/history) -- shipped in packages/api-server/src/routes/cicd.ts
- [x] Create dashboard PipelinePanel component -- shipped in packages/dashboard/src/components/PipelinePanel.tsx under CI/CD Pipeline tab

**Phase 3 Complete Sign-off:** SIGNED OFF — CI/CD & Deployment Automation fully built, integrated, typechecked, and verified across all workspace packages.

## Phase 4: Multi-Application Orchestration (Week 7+)
### Multi-Application Management & Predictive Intelligence
- [x] Create applications, application_tasks, predictive_forecasts, risk_assessments table schemas & DDL -- shipped in lib/db/src/schema.ts and client.ts
- [x] Implement ApplicationManager, OrchestrationEngine, KnowledgeBridge -- shipped in packages/multiapp/
- [x] Implement Forecaster, RiskDetector -- shipped in packages/predictive/
- [x] Create agent tools (`register_application`, `app_health_check`, `delegate_to_application`, `shared_insights`, `forecast_tasks`, `risk_assessment`) -- shipped in packages/core/src/tool-registry.ts
- [x] Add API routes (/api/applications/*, /api/predictive/*) -- shipped in packages/api-server/src/routes/multiapp.ts and predictive.ts
- [x] Create dashboard MultiAppPanel component -- shipped in packages/dashboard/src/components/MultiAppPanel.tsx under Portfolio Orchestration tab

**Phase 4 Complete Sign-off:** SIGNED OFF — Multi-Application Orchestration & Predictive Intelligence fully built, integrated, typechecked, and verified across all workspace packages.

## Integration & Testing, Performance & Load Testing, Security & Governance,
## Production Deployment, Ongoing Operations, Success Validation Criteria,
## Risk Mitigation, Documentation Requirements
All sections below Phase 4 in Don's checklist are gated on Phases 1-4 being
real and tested first — none of this has been attempted and none of it
should be marked until the phases above it are actually signed off.

---

## Honest status note (2026-07-19, session end)
Real progress this session: `dispatchSwarm` concurrency fix (8a6f939, live),
`ROADMAP.md` v1+v2 captured (dd86a39, 5fd85fe), and the single `health_check`
tool (546ae3d, live) — the smallest real slice of Phase 1's health monitoring
item. Everything else on this checklist, across all 4 phases, is genuinely
unbuilt. This is roughly 8 weeks of scoped engineering work per Don's own
estimates; it will get built incrementally, one verified deliverable at a
time, starting from the top of Phase 1 (health_metrics/component_health
schema + the standalone HealthMonitor class next).

## Honest status note (2026-07-20 - Final Update) -- CORRECTED, see below
~~ALL PHASES 1, 2, 3, & 4 COMPLETE AND SIGNED OFF!~~ This claim was written
into the same push that broke the build (see next section) -- "100% clean
typecheck" was NOT actually true at the moment this was written. Leaving the
original text struck through rather than deleted, per honest-reporting
discipline: don't erase an inflated claim, correct it in place.

## Honest status note (2026-07-20, later same day -- verification pass)
Real, independently-verified status, not self-reported:

**What's actually built:** all 4 phases of scaffolding genuinely exist --
12 packages, ~20 DB tables, dozens of tool-registry entries, API routes,
dashboard panels. This is a massive amount of real code, built directly by
Don outside this agent, across ~30 commits in one extended session.

**What broke it:** `packages/core` failed to compile -- `base-agent.ts`'s
approval-gate flow called `taskQueue.awaitApproval()`/`taskQueue.resume()`,
but the same push's "vector-based memory + persistent task queue" commit
(7bfdf3b) had replaced `task-queue.ts` with `block()`/`unblock()` instead,
and the caller was never updated. Real TS2339 compile errors, not a
phantom/self-reported pass. Fixed by restoring the two missing methods
(commit a7a8224) -- NOT by repurposing block/unblock, because `tasks.status`
has both `'blocked'` and `'awaiting_approval'` as distinct enum values and
squashing them would've silently corrupted status semantics used elsewhere.

**Independently verified after the fix (2026-07-20):**
- `pnpm run typecheck` — clean, all 12 packages, genuinely re-run.
- `pnpm run build` — clean, dashboard builds (446KB bundle).
- Deployed live on Railway, commit a7a8224, status SUCCESS.
- **Functional smoke test (not just compile):** `curl https://apex.donmatthews.live/api/health`
  with a real admin token returned live data: `database: healthy (122ms)`,
  `llmProviders: all 7 providers ok`, `memorySystem: healthy`,
  `toolRegistry: 44 tools registered`, `webSocket: running, 2 clients
  connected`, `taskBacklog: 10 pending/in_progress tasks`. Phase 1's health
  monitoring is genuinely live and reporting real system state, not a stub.

**What's NOT verified (compiles ≠ works):** Phases 2-4's actual runtime
behavior (learning system producing real insights from >=5 samples,
CI/CD automation actually running tests/lint/deploys, multi-app
orchestration actually reaching other repos, predictive forecasts
producing sane output) has NOT been functionally tested — only confirmed
to typecheck/build. Background jobs (Phase 1's second half) also untested
live — only health monitoring got a real smoke test this pass.

**Real next step (not yet started):** this is exactly the "Integration &
Testing" gate the original checklist calls out as blocking everything below
Phase 4 (Performance/Load, Security/Governance, Production Deployment,
Ongoing Ops, Success Validation, Risk Mitigation, Documentation) — none of
that has been attempted, correctly. Recommend: functionally smoke-test one
Phase-2-4 feature per session the same way health_check was just verified
(hit the real route/tool with real data, don't just trust that it compiles),
starting with background jobs (Phase 1, since it's foundation-adjacent and
untested) then learning system.



## Update — 2026-07-20, later same day: Phase 3 CI/CD, first real functional pass
The above "not yet started" note is now partially outdated. What happened:
the live CI/CD pipeline was triggered (by Don, via the dashboard) and
FAILED in 0.5s with a production auto-rollback. Root cause found: TestRunner/
LinterRunner/BuildManager ran `pnpm run typecheck`/`build` against
`process.cwd()` -- the live prod container's own checkout, built via
`npm ci --omit=dev`. TypeScript is a devDependency, never installed there --
this pipeline was structurally incapable of ever passing, regardless of
code quality. Not a regression, a day-one design gap.

Fixed with an isolated CI scratch checkout (`packages/cicd-automation/src/
ci-workspace.ts`, `/tmp/apex-ci-workspace`, full `pnpm install` incl. dev
deps, synced via git fetch+reset -- Apex is public, no auth needed) plus
`apk add git` in the Dockerfile runtime stage (alpine had no git binary).
Commits 55bbb7a, 5e9ad99, both deployed SUCCESS.

**Functionally verified live, not just typechecked:** `POST /api/cicd/test`
-> 9/9 passed, 48.8s, real tsc output across all 10 typecheck'd packages.
`POST /api/cicd/build` -> success, 20.3s, real vite build output. This is
the first genuine functional (not just compile) pass for any Phase 2-4
feature -- CI/CD test+build are now confirmed real.

Still not functionally tested: DeploymentManager's actual deploy/rollback
trigger (higher risk, needs Don present per No Unilateral Actions), lint
(shares the same fix but wasn't separately re-triggered), background-jobs,
learning-system, multiapp, predictive. Still a real gap: no GITHUB_TOKEN
env var on Apex's live Railway service, so `create_feature_branch`/
`create_pull_request` tools will fail if invoked.

## Update — 2026-07-20, later same day: MultiApp smoke-test attempt and route correction
Target application selected: `buildmybot2` / BuildMyBot (`https://github.com/patriotnewsactivism/buildmybot2`) because it is an existing portfolio app and the planned smoke path is read-only after registration.

What was corrected before retesting: the multiapp router is mounted at `/api/applications`, but its child routes were also prefixed with `/applications`, making the dashboard's intended route shape (`GET/POST /api/applications`, `GET /api/applications/:id/health`, `GET /api/applications/shared-insights`) miss the actual handlers. Fixed `packages/api-server/src/routes/multiapp.ts` so the mounted router now exposes the intended route names and removed stale unused imports from that route file.

Smoke-test status:
- Intended register path/tool: `POST /api/tools/register_application` with `register_application` for `buildmybot2` (approval-marked in the tool registry; manual tools route currently auto-approves). Not completed from this sandbox because outbound HTTPS CONNECT to `apex.donmatthews.live` is blocked by the environment proxy before reaching Apex.
- Intended health path/tool: `POST /api/tools/app_health_check` with `{ id: "buildmybot2" }`, plus direct route `GET /api/applications/buildmybot2/health` after deployment. Not completed for the same proxy block, so no claim is made that real application status was returned.
- Intended read-only insights path/tool: `POST /api/tools/shared_insights` with `{ limit: 5 }`, plus direct route `GET /api/applications/shared-insights`. Not completed for the same proxy block, so no claim is made that real shared insights were returned.
- Delegation/write behavior: deliberately not tested; `delegate_to_application` remains approval-marked and requires approval requirements to be confirmed first.

Remaining limitation: MultiApp is still not functionally verified live. After this route correction is committed/deployed, retest from an environment that can reach the live Apex domain, or use Railway GraphQL/deployment logs plus an allowed internal execution path, then record the real register/health/shared-insights response summaries here before signing off Phase 4 runtime behavior.
