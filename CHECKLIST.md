# Apex Implementation Checklist

Master tracking checklist for the roadmap in `ROADMAP.md`. Only check an item
when it is actually built AND verified (typecheck/build/test + deployed) —
per standing discipline, do not mark ahead of real, confirmed work.

## Phase 1: Foundation (Week 1-2) — CRITICAL

### Health Monitoring System
- [ ] Create health_metrics table schema
- [ ] Create component_health table schema
- [x] Implement HealthMonitor class -- shipped in packages/health-monitor/ (2ab5eb3/126a292), decoupled from @workspace/core via dependency injection (no cyclic workspace dep)
- [x] Implement database health check — now HealthMonitor.checkDatabase(), tool is a thin wrapper
- [x] Implement LLM providers check — now HealthMonitor.checkLLMProviders() (injected getConfiguredProviders), config presence only, not live connectivity
- [x] Implement memory system check — HealthMonitor.checkMemorySystem(), read-only reachability ping against memories table (deliberately not a real embedding-based recall(), which would cost a real API call every check)
- [x] Implement tool registry check — now HealthMonitor.checkToolRegistry() (injected getRegisteredToolCount)
- [~] Implement WebSocket check — HealthMonitor.checkWebSocket() exists and takes an injectable checker; honestly reports 'degraded: no checker injected' until the api-server process wires in a real one via /api/health routes (not yet built)
- [ ] Create AlertManager class
- [ ] Define alert rules (thresholds already specced in ROADMAP.md: error rate >5%, task backlog >50, approval backlog >10 — not yet wired to an actual AlertManager)
- [ ] Implement alert evaluation logic
- [x] Create health tools — `health_check` shipped, now backed by HealthMonitor (546ae3d -> 2ab5eb3/126a292, requiresApproval:false, wired into ApexCEO); `get_system_status` and `get_active_alerts` NOT built
- [ ] Add health API routes (/api/health, /api/health/components, /api/health/alerts)
- [ ] Update dashboard with health indicators
- [ ] Start health monitoring in main server (60s background polling loop)
- [ ] Write health monitoring tests
- [ ] Test component failure detection
- [ ] Test alert triggering
- [ ] Test external health endpoint
- [ ] Verify dashboard health display

### Background Job System
- [ ] Create scheduled_jobs table schema
- [ ] Create job_execution_log table schema
- [ ] Implement CronParser class
- [ ] Implement JobScheduler class
- [ ] Implement JobExecutor class
- [ ] Create TaskDelegationJob handler
- [ ] Create HealthCheckJob handler
- [ ] Create ReportGenerationJob handler
- [ ] Create MaintenanceJob handler
- [ ] Add job management tools (schedule_task, list_scheduled_tasks, cancel_scheduled_task)
- [ ] Create job API routes (/api/jobs)
- [ ] Integrate scheduler in main server
- [ ] Implement graceful shutdown
- [ ] Write background job tests
- [ ] Test cron expression parsing
- [ ] Test job scheduling and execution
- [ ] Test job retry logic
- [ ] Test concurrent job handling
- [ ] Verify scheduler persistence across restarts

**Phase 1 Complete Sign-off:** NOT SIGNED OFF — health_check tool is the only
shipped fragment; HealthMonitor/AlertManager modules, all DB tables, all
routes, dashboard, background scheduler, and all tests remain unbuilt.

## Phase 2: Intelligence (Week 3-4) — HIGH PRIORITY
Learning & Adaptation System — NOT STARTED. All items unchecked (schemas,
OutcomeAnalyzer, PatternDetector, InsightGenerator, StrategyOptimizer, base-
agent integration, tools, workflows, dashboard, tests).

**Phase 2 Complete Sign-off:** NOT SIGNED OFF — not started, per dependency
order (Phase 1 must ship first).

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

## Honest status note (2026-07-19, session end, update 2)
Additional real progress: `packages/health-monitor/` shipped with a genuine
HealthMonitor class (checkDatabase, checkLLMProviders, checkMemorySystem,
checkToolRegistry, checkTaskBacklog, checkWebSocket, runAll) -- the
`health_check` tool is now a thin wrapper around it, not duplicated logic.
Caught and fixed two real bugs in the process: (1) a genuine TS type error
in the earlier dispatchSwarm concurrency commit that `typecheck:libs` had
silently hidden (it only checks lib/db, not any packages/* -- corrected
process: always run `pnpm run typecheck`, the full command, going forward);
(2) a Docker build failure because the Dockerfile explicitly lists every
package's COPY paths and doesn't auto-discover new packages/* directories --
fixed by adding packages/health-monitor to both build stages. Confirmed
live on Railway at commit 126a292. Still nothing built: health_metrics/
component_health DB tables, AlertManager, /api/health routes, dashboard
widgets, 60s background polling loop, or any tests -- those remain the
next real slices, in that order.
