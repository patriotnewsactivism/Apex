# APEX Unified Architecture

_Based on the verified findings in `docs/APEX_SYSTEM_AUDIT.md`. This document describes the architecture that actually exists, plus the specific, narrow changes recommended to make the three repositories coherent — it is not a rewrite proposal. Where a real product decision is required and this audit could not make it safely, that is stated explicitly under "Open decisions" rather than guessed._

## Component boundaries and responsibilities

The original three-way "control plane / event stream / agent reasoning" split does not match what the code actually does (see audit §21). The real, evidence-based split is:

### Apex — business/agent operating system (control plane + agent runtime, combined)

Apex is both the control plane *and* the agent-reasoning/execution layer for one operator's business/portfolio automation. It owns:

- the durable goal → task → approval data model and its state machine;
- the 13-agent workforce (planning, delegation, tool use, memory);
- the tool registry and per-tool approval policy;
- the scheduler and durable background-job execution;
- CI/CD automation for deploying **itself**;
- health, learning, and predictive subsystems;
- shallow, read-mostly connectors to sibling products (BuildMyBot, CaseBuddy, TubeScribe) that live in their own repositories and are treated as external systems, not code Apex owns.

This is a single deployable service (Cloud Run) with one Postgres database. There is no case in the evidence for splitting "agent reasoning" out into a separate service — the audit found no architectural strain from keeping them together, and Apex-Agent (which tried to be a separate, earlier version of exactly this) is the confirmed-abandoned proof that duplicating this layer doesn't help.

### Apex-Stream — monitoring, evidence, and comment-triage platform (independent product)

A separate, independently valuable product: multi-source anomaly detection (RSS/API feeds, web pages, live streams), tamper-evident evidence capture, and YouTube comment triage, fronted by its own orchestrator, workflow engine, and dashboard. It should **not** be absorbed into Apex. Its differences from Apex are load-bearing, not incidental:

- a compliance-grade, independently-auditable evidence chain (hash-chained audit log, write-once evidence with legal-hold-style retention) that must remain verifiable on its own, without depending on Apex's availability or database;
- a genuinely different security model (Cognito RBAC with deny-wins semantics vs. Apex's single-admin-token model);
- a different, currently AWS-coupled, infrastructure footprint (SQS/EventBridge/S3/DynamoDB/Cognito) mid-migration to Cloud Run-native equivalents — see "Open decisions" below.

### Apex-Agent — deprecated

Not a component in the target architecture. See "Apex-Agent disposition" below.

## Dependency direction

```
                      ┌────────────────────────┐
                      │        Apex             │
                      │  (business/agent OS)     │
                      │                          │
                      │  api-server ── dashboard │
                      │      │                    │
                      │  packages/agents           │
                      │      │                     │
                      │  packages/core (tools,     │
                      │   memory, LLM router,      │
                      │   task queue)               │
                      │      │                      │
                      │  background-jobs (scheduler,│
                      │   campaign runner)           │
                      │      │                        │
                      │  Postgres (single DB)          │
                      └──────────┬──────────────────┘
                                 │  optional, HTTP-only,
                                 │  no shared DB/auth
                                 │  (see "Recommended
                                 │   integration contract")
                      ┌──────────▼──────────────────┐
                      │      Apex-Stream              │
                      │  (monitoring/evidence)         │
                      │                                │
                      │  services/orchestrator          │
                      │      │                           │
                      │  packages/agent-runtime           │
                      │   (Aria/Atlas/Sentinel/            │
                      │    Archivist/Warden)                 │
                      │      │                                │
                      │  AWS SQS/EventBridge/S3/DynamoDB/       │
                      │  Cognito (migrating to GCP-native)       │
                      │      │                                    │
                      │  Postgres (separate DB, separate instance) │
                      └────────────────────────────────────────────┘

Apex-Agent: no arrows in or out. Retained as read-only history only.
```

Neither system imports the other's code, shares a database, or shares an auth boundary today. That is the correct target state, not a gap to close by merging — the gap to close is the thin, explicit integration contract described below, which both systems currently lack.

## Request / event / workflow / task / agent lifecycle

**Apex's goal lifecycle** (as implemented, adapted from the general `CREATED → PLANNING → RUNNING → COMPLETED/FAILED` model the audit's originating brief suggested): a goal is created via `POST /api/goals` or the CEO chat interface, decomposed by the CEO agent into `tasks` rows (self-referencing `parentTaskId` for sub-delegation), each claimed by exactly one agent's `TaskQueue` via a guarded `UPDATE ... WHERE status='pending'` (an in-database lease, not row locking), executed through the tool registry with per-tool approval gating, and closed only when a `result` string is recorded — a goal cannot be marked complete while children are open (enforced by `update_goal_status`, verified by `scripts/verify-autonomy-loop.ts`). Failure follows exponential backoff capped at `maxRetries`; a task that exceeds its hard wall-clock timeout is quarantined (`status: 'blocked'`) rather than retried, to prevent a detached-but-still-running promise from double-executing.

**Apex's approval lifecycle**: `requiresApproval` tools insert an `approvals` row, mark the task `awaiting_approval`, and poll for up to 5 minutes; a timeout is recorded as a rejection, never left ambiguous. This already matches the goal/task lifecycle the originating brief asked for closely enough that this audit recommends adopting Apex's existing state names as canonical rather than introducing a second vocabulary.

**Apex-Stream's task lifecycle**: the orchestrator's `Dispatcher` enqueues an `AgentTask` (explicit `expiresAt`, `maxAttempts`, `priority`, `traceId`) onto the target agent's SQS queue; the agent's shared `Agent` base class long-polls, claims, executes `handle()`, and reports back through `effects.ts`. On cancellation, tasks are deliberately **not** purged — they age out via `expiresAt`, because purging a queue destroys unrelated in-flight work indiscriminately.

**Apex-Stream's workflow lifecycle**: `packages/workflow-engine` runs a breadth-first walk from a single trigger node, honoring per-execution node/time/cost budgets, with all side effects (`fetchSources`, `dispatchAgentTask`, `archive`, `notify`) injected via a `WorkflowEffects` interface so a `dryRun` can prove "what would happen" with zero real side effects — a genuinely good pattern the audit found no reason to change.

## Data ownership

Each system owns its own Postgres database. Apex owns goals/tasks/approvals/agents/memories/logs/campaigns/health/learning/CI-CD state. Apex-Stream owns sources/observations/anomalies/evidence/audit_log/workflows/comments — entirely disjoint schemas, no shared tables, no cross-database foreign keys, and this audit recommends keeping it that way: Apex-Stream's evidence chain needs to be verifiable independent of Apex's uptime.

## Recommended integration contract (Apex ↔ Apex-Stream)

The one concrete, low-risk integration opportunity found: letting an Apex goal consume an Apex-Stream finding (e.g., "draft outreach based on this anomaly," "have the CEO agent review this flagged comment queue"). Recommended shape, none of which exists yet:

1. **Direction**: Apex-Stream → Apex only, one-way, via webhook. Apex-Stream already has an event bus (EventBridge) that could fan out a filtered subset of `anomaly.detected`/`comment.flagged` events to an HTTPS endpoint Apex exposes (a new, narrow, authenticated route — e.g. `POST /api/ingest/apex-stream-event`). This avoids Apex needing any AWS SDK dependency or direct access to Apex-Stream's infrastructure.
2. **Auth**: a shared, rotatable HMAC secret (signed payload) or a scoped API key — not Apex-Stream's Cognito tokens and not Apex's admin token, since those are single-tenant secrets not meant to cross a service boundary. This is a new secret to provision, not a reuse of an existing one (consistent with both repos' own security rules against credential reuse across systems).
3. **What Apex does with it**: create a `goals` row with a structured `context` payload carrying the Apex-Stream event, tagged so it's traceable back to the originating `anomaly`/`comment` ID — never a blind LLM summary that loses the source reference.
4. **What this deliberately does not do**: give Apex any write access to Apex-Stream's evidence store, bypass Apex-Stream's own approval workflow for posting replies, or make Apex's uptime a dependency for Apex-Stream's core monitoring/evidence functions.

This audit did not implement this contract — it did not exist before and inventing the exact route/payload shape without a concrete first use case (which finding types should actually generate which kind of goal) would be speculative. It's scoped precisely enough here that implementing it is a single, bounded follow-up task once a first use case is picked.

## Apex-Agent disposition

**Recommendation: archive, don't delete, and mark unambiguously deprecated.** Concretely (tracked in `docs/APEX_IMPLEMENTATION_PROGRESS.md`):

- Add a deprecation notice at the top of Apex-Agent's `README.md` stating plainly that the project is not maintained, was never successfully running in production, and that current development happens in `Apex`.
- Do not delete the repository or its history — it has real design ideas worth referencing and deleting a operator's own project history without being asked is not this audit's call to make.
- Do not port any more of its code into Apex; where the ideas were good (hierarchical agents, per-tool approval, importance-weighted memory), Apex has already independently re-implemented them more completely.

## Failure handling (as implemented — this is the reference pattern, not a proposal)

Apex already implements essentially the full "detected, isolated, logged, retried, recoverable, escalated, never silently corrupting state" model the originating brief asked for: provider-failure classification distinguishes transient from persistent failures with jittered per-task backoff; capacity/budget pauses are tracked separately from failures and don't consume retry budget; a non-completion guard specifically catches an agent narrating success without having done the tool call; a malformed-tool-call guard catches models emitting prose instead of structured calls; stale task/job claims are recovered every 5 minutes; agent-loop crashes restart with bounded jittered backoff and surface as "abandoned" after 5 restarts rather than retrying forever. **Recommendation: use this as the reference implementation for any future durable-execution work in either repository rather than building a second version of it.**

## Observability

Apex: `/health` (build SHA, task-queue verdict, workforce liveness, LLM capacity state), `/api/tokens` (spend), structured logs. Apex-Stream: `/health` (DB reachability only — the README itself is careful to say this doesn't prove the agent fleet is healthy), `/api/audit/verify` (recomputes the entire hash chain on demand), per-agent heartbeats. **Recommendation, not implemented in this audit**: if the Apex↔Apex-Stream integration above is built, Apex's own `/health` or a new `/api/status` should surface "last Apex-Stream event received at X" so an operator can tell the integration itself is alive, distinct from either system's own health.

## Deployment model

Both live systems deploy to Google Cloud Run via Google Cloud Build, existing-service-only, SHA-verified post-deploy — the same pattern, arrived at independently. See `docs/APEX_OPERATIONS.md` for exact commands. Apex-Stream's biggest deployment gap is structural, not procedural: only the orchestrator has any deploy path at all today; the five monitoring agents cannot be deployed by anything in the repository's CI until that's built (see Open decisions).

## Open decisions (not made unilaterally by this audit)

These require a product/infrastructure decision this audit is not positioned to make alone — each affects compliance-relevant behavior (evidence custody) or requires live cloud access this session does not have:

1. **Apex-Stream dispatch/eventing**: replace AWS SQS+EventBridge with a GCP-native equivalent (Cloud Tasks + Pub/Sub is the natural fit) or keep AWS for this subsystem specifically and accept a two-cloud footprint. Either is defensible; neither is free.
2. **Apex-Stream auth**: replace AWS Cognito (including the account-provisioning workflow) with a GCP-native identity provider (Identity Platform / Firebase Auth) or a self-hosted equivalent. This is the highest-blast-radius of the three, since it's also the account-provisioning path.
3. **Apex-Stream evidence storage**: replace S3 Object Lock + KMS with GCS Bucket Lock + Cloud KMS, or keep S3 specifically for the evidence vault (cross-cloud storage is a legitimate compliance pattern some organizations prefer for exactly this reason — a second, independently-controlled cloud for the tamper-evidence guarantee). This decision should be made by whoever owns the compliance/legal requirements the evidence chain serves, not inferred from code.
4. **Apex-Stream agent memory**: DynamoDB → Firestore/Spanner, or keep DynamoDB. Lowest blast radius of the four AWS subsystems (it's the one the repo's own docs didn't even disclose as still-AWS).
5. **The experimental Convex path in Apex** (`packages/convex-backend`, `packages/cicd-worker`): finish the migration, or formally kill it. Right now it is maintenance burden with no production benefit and had already drifted behind the live Postgres schema at audit time.
6. **Apex-Stream's five-agent deploy path**: build real CI to build/push all five agent images and decide their Cloud Run topology (a Worker Pool per agent? Cloud Run Jobs? one of each?) — a genuine infrastructure design task, not a documentation fix.

Each of these is written up precisely enough in `docs/APEX_SYSTEM_AUDIT.md` and this document that picking one and executing it is the natural next engineering project; this audit intentionally stopped short of guessing the answer on the operator's behalf.
