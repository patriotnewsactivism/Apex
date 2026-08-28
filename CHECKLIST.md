# Apex Implementation Checklist

> **⚠️ 2026-08-28 — CURRENT INFRASTRUCTURE NOTE (read before acting on anything below).**
> Deployment/hosting references inside this planning document may be historical.
> **APEX production runs on the existing Google Cloud Run service behind
> `https://apex.donmatthews.live`.** AWS Lightsail/CodeBuild and Railway are
> retired APEX hosting paths. Vercel and other platforms may still be client
> deployment targets, but they are not the APEX control-plane host. Current
> authority is `AGENTS.md`, `README.md`, `docs/ARCHITECTURE_DECISIONS.md`, and
> `docs/PRODUCTION_OPERATIONS.md`.

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
- [x] 2026-07-20 learning verification hardening: `/api/learning/analyze` now uses the documented PatternDetector minimum sample size of 5, not the previous manual-route override of 3; `apply_strategy_recommendation` remains approval-gated and now refuses to apply recommendations unless their DB status is already `approved`.
- [ ] 2026-07-20 live learning smoke test pending: this sandbox has no `DATABASE_URL`, no `/tmp/apex_db_url.txt`, and no `APEX_ADMIN_PASSWORD`, so I could not identify/trigger production task executions or call the protected live `/api/learning/analyze` route. Exact live sample size verified from this sandbox: 0. Generated live insight IDs verified from this sandbox: none. Required follow-up with live secrets: confirm >=5 similar real `task_outcomes` rows for one role/error cohort, call `/api/learning/analyze`, record the returned `patterns[].sampleSize`, new `learning_insights.id` values, and new pending `strategy_recommendations.id` values here.

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
env var confirmed on Apex's live service (Railway retired 2026-08-16 — see
AGENTS.md; re-verify this gap against the current host once documented), so
`create_feature_branch`/`create_pull_request` tools will fail if invoked.

## Update — 2026-07-20: Predictive intelligence smoke-test and guardrail review
Known input selected for this pass: recent `task_outcomes` rows from the same 7-day window used by `forecast_tasks` and `risk_assessment`, compared against the already-documented 2026-07-20 CI/CD incident where the live pipeline failed immediately because production dependencies omitted TypeScript before the isolated CI workspace fix. That trend should show up as task failures if those outcomes were recorded; if not, the prediction is only measuring agent task outcomes and can miss operational incidents documented elsewhere.

What was changed after review: `forecast_tasks` now returns `sampleSize`, `observedSuccessRate`, a Wilson-style `confidenceInterval`, explicit `advisoryOnly: true`, and `actionsTriggered: []` in addition to the persisted forecast value/confidence. `risk_assessment` now returns `sampleSize`, `failureRate`, `confidence`, explicit `advisoryOnly: true`, and `actionsTriggered: []` in addition to the persisted risk record. The DB insert payload remains limited to columns that actually exist in `predictive_forecasts` and `risk_assessments`.

Useful prediction example: if recent task outcomes include the CI/CD failure rows, a failure rate above 15% should produce at least `medium` risk and above 30% should produce `high` risk, which is directionally consistent with the known broken-pipeline incident. The task forecast's success percentage is useful as a simple recent reliability indicator when `sampleSize` is non-trivial.

Weak prediction example: a tiny or empty sample still produces a forecast, but confidence is intentionally low for empty data and the confidence interval spans 0-100%, so it should be treated as a data-availability warning rather than a real capacity forecast.

Potentially misleading prediction example: the model only reads `task_outcomes`; it does not currently join health metrics, pipeline runs, deployment statuses, or incident notes. A green/low-risk result can therefore be misleading after an operational incident if no corresponding failed task outcomes were recorded.

Runtime verification status: local package and workspace typecheck/build passed after the guardrail additions. A direct live API smoke test against `https://apex.donmatthews.live/api/predictive/*` could not be completed from this sandbox because `/api/auth/login` returned HTTP 403 before a bearer token could be obtained, so the predictive feature is still not fully live-verified with production data in this pass.

## Update — 2026-07-26: Phase A of the autonomy completion pass — self-direction + closed-loop learning
Context: Don asked to bring APEX to "fully autonomous, reasoning and learning"
per QWEN.md + APEX_CHARTER.md. A read-only audit first established ground
truth: the execution substrate (LLM loop, tool calls, hierarchical delegation,
cron scheduling, outcome recording) is real, but (a) nothing ORIGINATED work —
the CEO only reasoned when a human hit POST /api/goals, and the scheduler
polled an empty scheduled_jobs table on a fresh DB; and (b) learning was
"measure and report" — analysis ran only via /api/learning/analyze and never
fed back into agent behavior.

**What was built (all git-reversible, NO schema changes, NO new credentials):**
- `GoalReviewJob` (packages/background-jobs/src/handlers/index.ts) — the
  autonomous "spark". Seeded as recurring job `system-ceo-goal-review`
  (cron `*/30 * * * *`): snapshots real state (active goals, task backlog,
  degraded/critical components, recent insights) and enqueues a CEO task to
  reason about it and originate/delegate work — or consciously idle. Prompt
  bakes in restraint (no busywork) and reaffirms irreversible actions stay
  approval-gated.
- `LearningAnalysisJob` — seeded as `system-learning-analysis` (cron
  `0 */6 * * *`): runs PatternDetector→InsightGenerator→StrategyOptimizer on a
  schedule instead of only via the manual endpoint.
- `BaseAgent.buildLearningContext` (packages/core/src/base-agent.ts) — injects
  active role-relevant insights + applied strategy recommendations into every
  agent's system prompt, so detected patterns shape future reasoning. Best-
  effort, never blocks execution.
- `apply_strategy_recommendation` (packages/core/src/tool-registry.ts) — now
  persists an applied (human-approved) recommendation as a standing insight
  that feeds prompts. The "must be approved first" human gate is preserved.
- Boot seeding (packages/api-server/src/index.ts `seedDefaultJobs`) —
  idempotent via onConflictDoNothing, so an operator-disabled job stays
  disabled across reboots.

**Pre-existing breaks fixed to unblock the all-packages typecheck gate (NOT
caused by this work; git status confirms the footprint):**
- health-monitor:191/193 + the ReportGenerationJob in background-jobs:
  `await res.json()` typed `unknown` under Node undici types failed when
  checked through non-DOM-lib packages (agents/api-server). Added explicit casts.
- packages/orchestrator: dead empty package (no src/, broken tsconfig ref to
  non-existent packages/db, imported by nothing). Removed the broken reference
  + added a valid empty module. Recommend deleting this package entirely.

**Verified (2026-07-26):** `pnpm run typecheck` — all 12 packages Done, zero
errors. `pnpm run build` — clean, dashboard emits dist/index.html + JS/CSS
bundles (447KB).

**VERIFIED LIVE (2026-07-26, post-deploy):** the earlier "pending" framing was
overly pessimistic — this sandbox CAN reach the live service and DOES have
APEX_ADMIN_PASSWORD. Authenticated against https://apex.donmatthews.live and
confirmed Phase A is genuinely running, not just compiled:
- Both seeded jobs are present and active: `system-ceo-goal-review`
  (goal_review, `*/30 * * * *`, target apex-ceo-001) and
  `system-learning-analysis` (learning_analysis, `0 */6 * * *`).
- `system-ceo-goal-review` FIRED live at 2026-07-26T15:00:23Z, completed in
  735ms, output `{"taskId":"975b64fb…","assignedTo":"apex-ceo-001",
  "activeGoals":10,"unhealthyComponents":1,"openTaskBacklog":10}` — it
  snapshotted real state and enqueued a CEO task.
- That CEO task ("Autonomous goal review — 2026-07-26T15:00:23Z") was picked
  up by the CEO and reached status `done` — the full autonomous loop
  (scheduler → job → CEO task → CEO reasons → done) works end-to-end live.
- `system-learning-analysis` is seeded/active; its 6h boundary (next 18:00Z)
  had not yet passed at verification time, so 0 runs so far (expected).
- Observation (not caused by Phase A): `/api/health` overall = `critical`
  with 1 unhealthy component; the goal-review snapshot captured this, so the
  autonomous CEO loop is now positioned to delegate investigation of it.

Still charter-gated and untested: any autonomous buildmybot2 production
action (send briefing / run workforce / deploy) — those remain human-approved
by design.

**Remaining gaps to full completion (Phases B/C, blocked on Don):**
- Phase B (run buildmybot2 live): provision GITHUB_TOKEN (unblocks the
  engineering PR loop), BUILDMYBOT_VERCEL_DEPLOY_HOOK, BUILDMYBOT_CRON_SECRET.
- Phase C (recurring sales): net-new infra — live Stripe + a real outbound
  email/SMS channel — plus the charter's permanent human-approval gate on
  financial transactions and external emails. Apex can research/qualify leads
  and trigger buildmybot2's own follow-up worker today, but cannot itself send
  outreach or take payment.

## Update — 2026-07-26: Phase B wiring — autonomous loop is now buildmybot2-aware
The buildmybot2 delegation chain was already wired (COO owns buildmybot_status/
send_briefing/dispatch_engineering/health_check; Lead Developer owns
create_pull_request/buildmybot_deploy/health_check; CEO→COO→Lead Dev flow). The
missing piece was that the autonomous GoalReviewJob only saw Apex's own state.

**Built (git-reversible, no schema changes, no secrets needed to write):**
- `GoalReviewJob` (packages/background-jobs/src/handlers/index.ts) now adds a
  best-effort BuildMyBot2 telemetry leg to its snapshot — open-error count +
  worst 3, leads awaiting reply, today's shifts + flagged count — mirroring the
  proven Supabase fetch in ReportGenerationJob (missing env / unreachable
  Supabase → honest note, never a crash). The CEO prompt now instructs it to
  delegate to the COO (apex-coo-001) when buildmybot2 shows critical errors,
  flagged/escalated shifts, or stalling leads. Gated actions stay approval-gated.
- `.env.example` now documents BUILDMYBOT_VERCEL_DEPLOY_HOOK and adds a
  GITHUB_TOKEN section (the engineering tools read process.env.GITHUB_TOKEN;
  value = the GITHUB_TOKEN_4 secret).

**Verified (2026-07-26):** `pnpm run typecheck` — all 12 packages Done, zero
errors. `pnpm run build` — clean, dashboard emits dist bundles.

**NOT yet verified (honest):** live. The buildmybot2 snapshot leg needs the
deploy to settle and the next goal-review fire (every 30m) to confirm real
buildmybot2 data lands in the CEO task context; the engineering PR loop still
needs GITHUB_TOKEN provisioned on the live service to actually open PRs.

## Update — 2026-07-28: Phase C — the delegation loop is closed
Don's report: "not seeing near enough automation and reasoning; this thing
should be capable of running BuildMyBot.App on its own." A read of the running
system found the cause, and it was structural rather than a missing feature.

**Root cause — the org chart was one-way.** `BaseAgent.delegate()` wrote a child
task row and the delegating agent's own task finished immediately. Nothing in
the live system ever read `tasks.parent_task_id` back (verified by grep — the
only readers were in the not-yet-live `packages/convex-backend`). So a manager
could delegate five initiatives, report "delegated", and never learn that four
failed. Three consequences compounded from that single gap:
1. **Goals never closed.** The only writer of `goals.status` was a human hitting
   `PATCH /api/goals/:id`. Active goals accumulated forever, so the 15-minute
   CEO review re-reasoned over a growing pile of already-finished goals — and
   `delegate()`'s idempotency guard turned each re-delegation into a no-op. The
   loop looked busy and did nothing.
2. **Failures were terminal and unseen.** A task exhausting its retries went to
   `failed` and stopped. Nothing aggregated them; the same root cause could fail
   work indefinitely. (The learning system measured outcomes, but only emitted
   insights at a >=5-sample statistical threshold — it never put a specific
   actionable failure in front of a decision-maker.)
3. **Only the CEO had a heartbeat.** COO and CTO — the two agents that own
   day-to-day ops and engineering — did nothing unless the CEO happened to
   message them. Whole branches idled between reviews.

**Built (git-reversible; NO production schema changes; NO new credentials):**
- `packages/core/src/orchestration-tools.ts` — 5 new tools, all read-only or
  Apex-internal bookkeeping, so none are approval-gated: `get_delegation_status`
  (what actually happened to work I handed down), `get_task_details`,
  `list_goals` (real per-goal task rollup + a derived state), `update_goal_status`
  (the only way a goal ever closes), `escalate_to_human` (charter escalation as a
  real pending row in the dashboard's existing approval queue, not a log line).
  `update_goal_status` refuses to complete a goal that still has open tasks, and
  refuses to complete without a `result` — an anti-inflated-reporting guard.
- `DelegationFollowupJob` (`delegation_followup`, `*/5 * * * *`) — the return leg.
  Waits until EVERY sibling under a parent is terminal, then hands the delegator
  one synthesis task carrying the real results and real error text. The synthesis
  task is a ROOT task (no parentTaskId) so it can never re-trigger itself;
  children are marked `reportedToParent` via a jsonb merge on `context` (not a
  schema change) so a batch reports exactly once.
- `GoalProgressJob` (`goal_progress`, `*/30 * * * *`) — drives each active goal to
  a conclusion: decompose it (accepted but never broken down), close it out
  (work finished), or change approach (all tasks failed). Leaves in-flight goals
  alone.
- `FailureReviewJob` (`failure_review`, `15 */2 * * *`) — clusters 24h failures by
  agent + normalized error signature (UUIDs/numbers/timestamps stripped so one
  root cause is one cluster) and hands the CEO a triage task that teaches the
  capacity-vs-missing-capability-vs-defect-vs-bad-instructions distinction.
  Single one-off failures are treated as noise, not escalated.
- `BranchReviewJob` (`branch_review`) — a generic branch heartbeat, seeded for the
  COO (hourly, with live BuildMyBot2 telemetry) and CTO (every 2h). Role-specific
  focus lives in the job payload, so cadence and emphasis are tunable from the
  jobs table without a redeploy.
- `BaseAgent.executeTask` self-review — when an agent produces a no-tool-call
  "done" turn, it gets ONE critique turn (tools still attached) before that is
  accepted: did you do the work or only describe it; if you delegated, call
  get_delegation_status before claiming delivery; an empty-results answer is a
  failed search strategy, not an answer. Costs exactly one extra LLM call per
  task, bounded by `selfReviewed`; `APEX_SELF_REVIEW=0` disables it.
- `ToolContext.goalId` is now populated (it was read by `sendMessage` but never
  set), so delegated tasks inherit their goal and roll up correctly.
- `GoalReviewJob` is now idempotent — it previously inserted a fresh CEO review
  every 15 minutes regardless of whether the last one had been worked, building a
  backlog of stale snapshots whenever the CEO was busy or the LLM chain was
  briefly exhausted. All new handlers carry the same guard.
- Manager agents got the new tools + prompt sections making verification of
  delegated work mandatory before reporting (CEO, COO, CTO, Lead Developer).

**Two pre-existing bugs found and fixed while bootstrapping a clean database
(both blocked fresh-DB startup; neither was caused by this work):**
- `lib/db/src/client.ts` — `window` is a reserved Postgres keyword and was used
  unquoted in the `predictive_forecasts` DDL. The syntax error aborted `migrate()`
  part-way, so `predictive_forecasts`, `risk_assessments` and
  `integration_settings` were never created on a fresh database. It surfaced only
  as the swallowed "migration skipped or deferred" warning, and Drizzle quotes
  identifiers itself so ORM reads/writes hid the gap. Now quoted.
- `goals.project_id` was added to `schema.ts` on 2026-07-18 but never to the DDL,
  so on a fresh database EVERY goal insert failed and `submitGoal` could not
  bootstrap. Fixed with an additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
  matching the existing `next_retry_at` pattern — a no-op against the live
  database, which already has the column. Not a schema change: it makes the DDL
  match the schema already deployed.

**Verified 2026-07-28 — functionally, not just compiled.** Per the standing
discipline that compiling is necessary but not sufficient, both new scripts were
run against a REAL Postgres 16 with the REAL migrated schema, exercising the
actual handler classes and actual tool implementations against real rows:
- `scripts/verify-autonomy-loop.ts` — 40/40 checks pass. Asserts on real returned
  data, including: the follow-up job DEFERS while a sibling still runs and fires
  once all finish; the synthesis lands on the delegator (not the worker), is a
  root task, inherits the goal, and carries the real result AND error text; a
  second run does not re-report; `get_delegation_status` returns 2 done/1 failed
  with guidance to act on the failure; `update_goal_status` refuses to close a
  goal with open work and refuses to close without a result, then closes cleanly
  once work is genuinely finished; failure clustering collapses varying
  ids/numbers into one cluster; every handler is idempotent on re-run; the
  escalation lands as a pending approval row with urgency+category.
- `scripts/verify-autonomy-scheduler.ts` — 9/9 checks pass. All five new cron
  expressions parse to sane future runs, and the real `JobScheduler` dispatched
  and completed all four new job types (catching the "No handler registered"
  failure mode, with a bogus-job control proving the assertion is meaningful).
- `pnpm run typecheck` — clean for all 9 server-side packages and `tsc --build`.

One behavior worth calling out, found during verification and kept deliberately:
a goal cannot be closed while its delegation-results review is still unworked.
The manager must actually process the outcomes before the goal can be reported
complete. That is the closed loop doing its job, not a bug.

**NOT verified (honest):** nothing here has been deployed or run live. The two
pre-existing typecheck failures — `packages/convex-backend` (subagent-written
`toolRegistry.ts`, codegen never run, documented as UNVERIFIED in apexplan.md)
and `packages/dashboard` (imports `@workspace/convex-backend/api`, which does not
build) — were confirmed to fail identically on a clean tree and are untouched by
this work. They mean `pnpm run build` cannot currently pass end-to-end, so the
dashboard bundle must be built from a tree where the Convex migration is either
finished or reverted before this deploys.

**Still charter-gated / still blocked on Don (unchanged):** GITHUB_TOKEN on the
live service (the engineering PR loop cannot open PRs without it — the new
failure triage will now surface this as a missing-capability escalation rather
than silently retrying), BUILDMYBOT_VERCEL_DEPLOY_HOOK, BUILDMYBOT_CRON_SECRET,
and Phase C recurring sales (live Stripe + a real outbound email/SMS channel,
both permanently human-approval-gated for financial transactions and external
sends).

## Update — 2026-07-28 (later): silent false completions — root cause of "it stopped accomplishing tasks"
A live log excerpt from a real goal ("whats up with tubescribe not working?")
showed the delegation chain working exactly as designed — CEO → CTO → Lead Dev →
DevOps, four agents, twelve seconds — and then producing NOTHING, with the task
recorded as `done`. Two distinct bugs, both now fixed:

**1. Text-encoded tool calls were treated as task completion (the serious one).**
The DevOps agent emitted its tool call as plain text in the message body:

    <function.runInSandbox [{"language": "python", "code": "...", "timeoutMs": 10000}]</function

The provider returned `toolCalls: []`, so `executeTask` read that as "the agent
is finished", called `taskQueue.complete()`, and stored the pseudo-call text as
the task's RESULT. Nothing executed. The task was marked done. This is the worst
failure mode an autonomous system can have, because a false success propagates
upward: the delegating manager reads a `done` child, reports the initiative
delivered, and (post-Phase-C) the goal closes on work that never happened.

Cause is the model, not the framework: smaller/open models — precisely the ones
the fallback chain drops to when the primary provider is exhausted (gpt-oss,
qwen, glm, gemini-via-OpenRouter) — do not reliably use the structured
tool-calling API. So this gets WORSE exactly when providers are degraded, which
is when it is hardest to notice.

Fixed in `packages/core/src/malformed-tool-calls.ts` + the `executeTask` loop:
detect six known text-encoded call syntaxes, push one concrete correction, and
if the model repeats it, FAIL the task honestly rather than record a lie. The
detector deliberately does NOT parse-and-execute what it finds — a model that
cannot use the tool API correctly is evidence something is wrong with the
provider, and guessing intent then executing it (including approval-gated tools
like `runInSandbox`) is how an autonomous system takes an unsanctioned action.

False positives were treated as the equal risk, since one would fail a task that
actually succeeded. Two defenses: every pattern requires structural call syntax
(never a bare tool name in prose), and the captured name must be a tool the
agent actually has. Verified against the real CEO output from this same log
("**Delegation Complete** — I used sendMessage to delegate to the CTO…"), which
is correctly NOT flagged.

**2. Task failures logged no reason.** `AgentLogger.error(msg, err)` puts the
Error in the log row's `data` column, but the dashboard's Log Stream renders
`message` — so every failure appeared as a bare `Task failed: <title>`. In the
same excerpt, Lead Developer failed three seconds after delegating and the
stream gave no cause at all, making live triage impossible. The reason is now in
the message.

**Verified 2026-07-28:** `scripts/verify-malformed-tool-calls.ts` — 14/14,
including the exact `<function.runInSandbox [...]` line captured live, all six
syntaxes, and six false-positive cases drawn from real agent prose. Both earlier
suites re-run green (`verify-autonomy-loop.ts` 40/40, `verify-autonomy-scheduler.ts`
9/9). Typecheck clean across core/agents/api-server/background-jobs.

**NOT verified:** not deployed. And this does not explain the ERROR states on
COO/CTO/LEAD_DEV/LEAD_RESEARCH — that still needs
`scripts/triage-stalled-agents.mjs` run with live credentials. The two findings
are related in cause (a degraded provider chain produces both silent false
completions and hard failures) but they are separate bugs.
