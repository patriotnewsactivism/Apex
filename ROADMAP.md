# Apex Completion Roadmap (v2 — supersedes v1 ordering)

Captured 2026-07-19. Don sent a refined "Direct Path Forward" that reorders
priority vs. the original analysis (Learning now comes before CI/CD;
Background Jobs merged into Phase 1 alongside Health Monitoring). This
version is authoritative for build order. Each item below is its own
multi-file effort (new package, DB tables, tool registry entries, API
routes, dashboard widgets, tests) — NOT a single-session task. Build one
deliverable at a time, verify (typecheck/build/test) before moving on, per
standing "vibe code to completion" discipline: stop immediately on failure.

## Phase 1 — Foundation (build first, in this order) — "critical, blocks everything else"

### 1. Self-Monitoring & Health System (build THIS first)
- Schema: `health_metrics` (timestamp, component, status healthy/degraded/
  critical, response_time_ms, error_message), `component_health` (per-
  component real-time status + last_check_time).
- `packages/health-monitor/`: HealthMonitor (checkDatabase, checkLLMProviders,
  checkMemorySystem, checkToolRegistry, checkWebSocket — each <5s);
  AlertManager (rules: error_rate>5%, task_backlog>50, approval_backlog>10;
  persists alerts w/ severity).
- Tools (all approval:false): `health_check`, `get_system_status`,
  `get_active_alerts`.
- Routes: `GET /api/health`, `/api/health/components`, `/api/health/alerts`,
  `POST /api/health/alerts/:id/acknowledge`.
- Dashboard: overall health indicator, per-component status, active alerts,
  historical metrics.
- Runs in main server: health checks + alert eval every 60s, live via
  WebSocket, must not block agent operations.
- Success bar: DB issues detected <2min, LLM failures trigger alerts
  immediately, `/api/health` queryable externally, tests cover all checks.
- Est. 3-5 days.

### 2. Background Job & Scheduling System
- Schema: `scheduled_jobs` (id, name, recurrence cron, scheduled_at, enabled,
  job_type, target_agent_id, payload, priority, status, retry_count, error,
  next_run_at), `job_execution_log` (job_id, execution_id, started/completed_at,
  duration_ms, status, output, error).
- `packages/background-jobs/`: CronParser (standard 5-part, wildcards/
  ranges/intervals/lists, clear errors on invalid); JobScheduler (poll every
  60s, calculateNextRun, start/stop graceful); JobExecutor (timeout+retry
  w/ backoff, logs every attempt); JobHandlers (TaskDelegationJob,
  HealthCheckJob, ReportGenerationJob, MaintenanceJob).
- Tools: `schedule_task` (approval:true), `list_scheduled_tasks` (false),
  `cancel_scheduled_task` (true), `get_job_history` (false).
- Routes: `GET/POST /api/jobs`, `POST /api/jobs/:id/toggle`,
  `DELETE /api/jobs/:id`, `GET /api/jobs/:id/history`.
- Governance: max 3 retries w/ exponential backoff, max 50 concurrent jobs,
  scheduler must survive server restarts.
- Success bar: cron + one-time scheduling both work, concurrent jobs don't
  block agents, full execution history, tests cover cron parsing/scheduling/
  retries.
- Est. 5-7 days.

## Phase 2 — Intelligence (only after Phase 1 ships)

### 3. Learning & Adaptation System
- Schema: `task_outcomes` (task_id, agent_id, role, duration_ms, success,
  quality_score, tool_executions, llm_calls, iterations, required_approvals,
  error_type, complexity, satisfaction_metric), `learning_insights`
  (insight_type pattern/improvement/warning, confidence, evidence, expires_at,
  applied), `strategy_recommendations` (recommendation_type/text,
  expected_impact, confidence, status pending/approved/rejected/applied),
  `performance_baselines` (metric_name, baseline_value, measurement_window,
  sample_size, valid_until).
- `packages/learning-system/`: OutcomeAnalyzer (analyzeTaskOutcome,
  calculateComplexity, calculateSatisfactionMetric, generateOutcomeTags,
  classifyError, recordOutcome); PatternDetector (success/failure/tool-usage/
  time patterns, tool success rate, error frequency); InsightGenerator
  (from patterns, vs. baselines, trend insights); StrategyOptimizer
  (recommendations from failure/success patterns, collaboration/delegation
  optimization — all advisory, human approval required to apply).
- Wire into `base-agent.ts` executeTask: capture outcome metrics async after
  completion, must NOT add >100ms, must not fail the task if learning system
  errors.
- Tools: `analyze_performance`, `get_insights`, `get_strategy_recommendations`
  (all approval:false — observational); `set_performance_baseline`
  (approval:true).
- Scheduled (via Phase 1's job system once it exists): weekly performance
  analysis, per-agent insight generation, baseline recalc every 30 days.
- Dashboard: performance trends, insights feed, recommendations queue,
  baseline deviation alerts.
- Success bar: outcomes auto-captured, patterns need >=5 similar outcomes to
  fire, insights expire (default 30d), recommendations need approval,
  measurable improvement over 60 days.
- Est. 7-10 days.

## Phase 3 — Autonomy (only after Phase 2 ships)

### 4. CI/CD & Deployment Automation
- `packages/cicd-automation/`: TestRunner (runTests/parseTestResults/
  generateTestReport), LinterRunner (runLint/parseLintResults/
  generateLintReport), BuildManager (buildProject/monitorBuildProgress/
  handleBuildErrors), DeploymentManager (triggerVercelDeployment,
  triggerRailwayDeployment, checkDeploymentStatus, rollbackIfNeeded).
- Tools: `run_tests`, `run_lint`, `build_project` (approval:false);
  `deploy_to_environment`, `rollback_deployment`, `create_feature_branch`,
  `create_pull_request` (approval:true).
- Governance: block deploy if tests fail; lint errors warn (blocking
  configurable); production deploys always need approval; auto-rollback if
  deploy health degrades; rate-limit deploy ops; secrets never in logs.
- Routes: `GET /api/cicd/status`, `POST /api/cicd/test`,
  `POST /api/cicd/deploy`, `GET /api/cicd/history`.
- Dashboard: pipeline status, test pass/fail+coverage, deployment health,
  pending-approval queue.
- Target repos via GITHUB_TOKEN: Apex, buildmybot2, ARIA, autonomous-coder,
  casebuddy-ai-law-partner (respect each repo's own standing rules — e.g.
  repo-romance-46 requires PR/diff, never auto-applied).
- Success bar: tests/lint/build run reliably, deploys need approval, failed
  deploys auto-rollback within 2min, full audit trail.
- Est. 5-7 days.

## Phase 4 — Scale (future, not detailed yet)
- Multi-Application Orchestration (see v1 roadmap section below for the
  original detailed spec — still valid, just resequenced to Phase 4).
- Predictive Intelligence (forecasting, scenario modeling, risk detection —
  see v1 spec below).
- Advanced workflow automation (unspecified in v2 prompt — TBD when reached).

## Success metrics (both versions agree)
Health detection <2min, task completion >95%, avg response <2min, error rate
<2%, uptime >99.9%, 30+ consecutive autonomous days, proactive detection >80%,
self-healing success >70%, learning improvements applied >5/month.

## Recommended next concrete step
Same as v1: smallest, safest, self-contained first slice is just the
`health_check` tool alone (single tool-registry entry, auto-approved,
testable in isolation, no new package needed yet). Ship that, verify it,
THEN build `packages/health-monitor/` (HealthMonitor + AlertManager) around
it. Do not attempt multiple Phase 1 items in one pass — Health Monitoring
and Background Jobs are each their own multi-day build even though v2 groups
them both into "Phase 1."

---

## Appendix: v1 detail for Phase 4 items (Multi-App Orchestration, Predictive)
Kept from the original roadmap since v2's "Direct Path" prompt didn't respec
these — still the best available detail when Phase 4 is reached.

**Multi-Repository Orchestration Layer** — `applications`, `application_tasks`
tables; `packages/multiapp/` (ApplicationManager, OrchestrationEngine,
KnowledgeBridge — read-only by default); tools `register_application`
(approval:true), `app_health_check` (false), `delegate_to_application`
(approval:true), `shared_insights` (false); routes `/api/applications`,
`/api/applications/:id/health`, `/api/applications/shared-insights`. Target
repos: buildmybot2, ARIA, autonomous-coder, casebuddy-ai-law-partner,
repo-romance-46.

**Predictive Intelligence & Decision Support** — `packages/predictive/`
(Forecaster, ScenarioRunner, RiskDetector); tools `forecast_tasks`,
`risk_assessment`; routes `/api/predictive/tasks-forecast`,
`/api/predictive/risks`; all forecasts advisory with confidence intervals.
