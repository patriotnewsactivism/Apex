# Apex Completion Roadmap

Captured 2026-07-19 from Don's full analysis prompt. This is the source of
truth for build order going forward — a 90-120 day plan across 6 subsystems.
Each phase below is its own multi-file effort (new package, DB tables, tool
registry entries, API routes, dashboard widgets, tests) — NOT a single-session
task. Build one deliverable at a time, verify (typecheck/build/test) before
moving to the next, per standing "vibe code to completion" discipline.

## Phase 1 — Production-Grade Foundation (build first, in this order)
1. **Reliability, Monitoring & Observability**
   - `apex-health-check` tool (auto-approve): DB connectivity/schema integrity,
     tool registry health, LLM connectivity per provider, memory/vector search
     validation, dashboard serving status, WebSocket liveness.
   - `packages/observability/`: MetricsCollector, AlertManager (thresholds:
     error rate >5%, task backlog >50, approval backlog >10), DashboardRenderer
     (`/api/observability/metrics`, `/health-lite`).
   - Auto-restart/resilience: agent crash watchdogs, DB retry+backoff, LLM
     timeout+fallback (partially exists in llm-client.ts), tool exec timeouts.
   - Tools: `get_metrics_view`, `health_check` (both requiresApproval: false).
   - Tests in `packages/observability/test/`.
   - Deliverable: health check passes, `/api/observability/metrics` returns
     real data, dashboard shows live agent/task/error/approval counts.

2. **Background Execution & Scheduling**
   - `scheduled_jobs` table (id, name unique, scheduled_at, recurrence cron,
     enabled, job_type, payload json, created_at).
   - `packages/scheduler/`: JobScheduler (polls + fires + respects recurrence),
     JobQueue (priority ad-hoc), BackgroundExecutor (timeouts, resumable
     checkpoints), CronHelpers.
   - Tools: `schedule_task` (approval: true), `list_scheduled_tasks` (false),
     `cancel_scheduled_task` (true).
   - Governance: max 100 concurrent background tasks/agent, auto-retry
     failures up to 3x, audit log every schedule create/cancel.
   - Route `/api/scheduler/status` + dashboard scheduled/running jobs view.
   - Tests in `packages/scheduler/test/`.
   - Deliverable: CEO/CTO/COO can schedule recurring tasks (e.g. daily
     briefings) that fire accurately without blocking normal agent loops.

3. **CI/CD and Code Quality Automation**
   - Tools: `run_tests`, `run_lint`, `build_project`, `git_status` (all
     approval: false); `create_branch`, `push_to_remote`, `trigger_deployment`
     (all approval: true).
   - `packages/cicd/`: TestRunner, LinterRunner, BuildOrchestrator,
     GitOrchestrator, DeployOrchestrator.
   - Quality gates: block push if tests fail, block deploy if build fails,
     lint warnings advisory only.
   - Route `/api/cicd/status` + dashboard pipeline status, per-repo context.
   - Tests in `packages/cicd/test/`.
   - Deliverable: Apex can run tests/lint, enforce gates, create branch/push
     with approval, trigger deploys via documented APIs.

## Phase 2 — Autonomous Intelligence & Learning (only after Phase 1 ships)
4. **Learning & Feedback Integration** — `task_outcomes`, `strategy_revisions`,
   `feedback_signals` tables; `packages/learning/` (FeedbackCollector,
   OutcomeAnalyzer, StrategyOptimizer — advisory only, approval required to
   apply); tools `record_outcome`, `analyze_performance`,
   `suggest_strategy_improvement` (all approval: false, since they're
   observational/advisory not destructive).
5. **Predictive Intelligence & Decision Support** — `packages/predictive/`
   (Forecaster, ScenarioRunner, RiskDetector); tools `forecast_tasks`,
   `risk_assessment`; routes `/api/predictive/tasks-forecast`,
   `/api/predictive/risks`; all forecasts advisory with confidence intervals.

## Phase 3 — Multi-Application Orchestration (only after Phase 2 ships)
6. **Multi-Repository Orchestration Layer** — `applications`,
   `application_tasks` tables; `packages/multiapp/` (ApplicationManager,
   OrchestrationEngine, KnowledgeBridge — read-only by default); tools
   `register_application` (approval: true), `app_health_check` (false),
   `delegate_to_application` (approval: true), `shared_insights` (false);
   routes `/api/applications`, `/api/applications/:id/health`,
   `/api/applications/shared-insights`. Target repos: buildmybot2, ARIA,
   autonomous-coder, casebuddy-ai-law-partner, repo-romance-46.

## Success metrics (from Don's spec, for reference during build)
Uptime >99.9%, task completion >95%, avg response <2min, error rate <2%,
30+ consecutive autonomous days, forecast accuracy within 20%, risk detection
lead time >6hrs, cross-app insight sharing >10/month.

## Recommended next concrete step
Smallest, safest, self-contained first slice of Phase 1.1: just the
`apex-health-check` / `health_check` tool (single new tool-registry entry,
no new package needed yet) — a real, testable, auto-approved diagnostic that
CEO/CTO can call immediately. Ship that alone, verify it, THEN build the
`packages/observability/` MetricsCollector/AlertManager/dashboard around it.
Do not attempt multiple Phase 1 prompts in one pass.
