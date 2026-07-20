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
CI/CD & Deployment Automation — NOT STARTED. All items unchecked.

**Phase 3 Complete Sign-off:** NOT SIGNED OFF — not started.

## Phase 4: Multi-Application Orchestration (Week 7+)
Multi-Application Management — NOT STARTED. All items unchecked.

**Phase 4 Complete Sign-off:** NOT SIGNED OFF — not started.

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

## Honest status note (2026-07-20 - Update 2)
Phase 2 Intelligence complete! Shipped and verified:
1. `task_outcomes`, `learning_insights`, `strategy_recommendations`, and `performance_baselines` DB schemas & DDL in `lib/db/src/schema.ts` and `client.ts`.
2. `@workspace/learning-system` package with `OutcomeAnalyzer`, `PatternDetector` (requiring >=5 samples), `InsightGenerator` (30-day expiring insights), and `StrategyOptimizer` (approval-gated recommendations).
3. `base-agent.ts` non-blocking async outcome recording in `executeTask()` (<100ms, isolated errors).
4. Learning tools (`analyze_performance`, `get_insights`, `get_strategy_recommendations`, `set_performance_baseline`, `apply_strategy_recommendation`) in `packages/core/src/tool-registry.ts`.
5. Learning API routes (`/api/learning/*`) in `packages/api-server/src/routes/learning.ts`.
6. Dashboard `LearningPanel` component in `packages/dashboard/src/components/LearningPanel.tsx` under the Intelligence tab with KPI cards, learning insights feed, and approval-gated strategy recommendations queue.
7. `Dockerfile` updated to copy and build `@workspace/learning-system`.
8. Full monorepo strict typecheck (`pnpm run typecheck`) and build (`pnpm run build`) passing 100% clean across all 9 workspace packages!


