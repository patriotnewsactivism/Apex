# APEX Architecture Decisions

This file records durable architecture decisions that should not change accidentally during ordinary feature work, refactors, or incident response.

A decision may be superseded, but it must be superseded explicitly: update the implementation, this file, `AGENTS.md`, and any affected operational documentation in the same change set.

## ADR-001 — APEX production host is Google Cloud Run

**Status:** Accepted  
**Last confirmed:** 2026-08-28

APEX itself runs on the existing Google Cloud Run service behind:

`https://apex.donmatthews.live`

AWS Lightsail/CodeBuild and Railway are retired APEX hosting paths. Vercel, Railway, Render, and other platforms may still be valid deployment targets for client projects that APEX manages, but they are not the APEX control-plane host.

### Consequences

- Do not restore AWS Lightsail or CodeBuild as an APEX production fallback.
- Do not move APEX to another host as an incidental fix for a deployment issue.
- Deployment and production documentation must describe Google Cloud Run.
- Historical references may remain only when clearly labeled historical.

## ADR-002 — Production releases update the existing Cloud Run service only

**Status:** Accepted  
**Last confirmed:** 2026-08-28

Ordinary APEX releases must update the exact existing Cloud Run service. The release path uses `gcloud run services update --image ...` after first describing the configured service.

It intentionally does not use `gcloud run deploy` as a fallback.

### Rationale

The existing service contains configuration that should not be reconstructed or guessed from the repository, including:

- environment variables;
- Secret Manager references;
- runtime service account;
- scaling settings;
- CPU/memory configuration;
- ingress;
- custom-domain mapping;
- other Google-managed service metadata.

### Consequences

If the exact configured service cannot be found or accessed, deployment stops. APEX must not create a substitute service or guess a different project, region, or service name.

## ADR-003 — Source-to-production provenance is commit-SHA based

**Status:** Accepted  
**Last confirmed:** 2026-08-28

`cloudbuild.apex.yaml` builds and pushes an immutable image derived from the exact reviewed Git commit. `APEX_BUILD_SHA` and build time are baked into the image.

Production is considered released only when the public health endpoint reports the expected SHA.

### Consequences

- A successful build is not proof of deployment.
- A Ready Cloud Run revision is not proof that production traffic serves the intended code.
- Runtime environment overrides must not fake `APEX_BUILD_SHA`.
- Release tooling and CI must preserve deterministic provenance checks.

## ADR-004 — OpenRouter is the production LLM gateway; model adaptation is evidence-governed

**Status:** Accepted  
**Last confirmed:** 2026-08-30

Production APEX inference routes through OpenRouter. `packages/core/src/llm-client.ts` is the request-path implementation authority, `packages/core/src/model-routing.ts` owns the operator-selectable policy contract, `packages/core/src/model-intelligence.ts` owns evidence-based ranking, and `packages/core/src/model-execution-context.ts` plus the instrumented BaseAgent bind durable task identity into concurrent LLM calls.

The reviewed no-configuration fallback is:

1. MiniMax M3 Free for high-capability long-horizon agent work, coding, tools, and multimodal input;
2. NVIDIA Nemotron 3 Ultra Free for reasoning, planning, orchestration, and coding fallback.

An authenticated operator may instead persist an ordered OpenRouter roster in `APEX_OPENROUTER_MODEL_POLICY`. The roster may contain 1–500 valid OpenRouter model IDs—large enough for the current hundreds-model catalog—and optional role-specific first choices. A role-specific model must already belong to the selected global roster.

The policy also contains a routing mode (`manual`, `advisor`, or `adaptive`), an optimization objective (`quality`, `balanced`, `budget`, or `speed`), a completed-task evidence threshold, an optional controlled-learning trial rate, and an optional smart complexity-escalation flag. Policies saved before these fields existed remain valid and default to `manual`, with trials and complexity escalation off.

### Operator authority and adaptive boundary

- **Manual** preserves the exact saved operator order.
- **Advisor** preserves the exact saved order while surfacing learned recommendations.
- **Adaptive** may reorder only models already selected by the operator and only after enough completed-task evidence exists.
- Under-sampled models retain their operator-defined slots.
- At least two models must be evidence-qualified before adaptive ranking can change an order.
- An explicit role-specific model is a hard operator pin and remains first even when another model has a higher learned score.
- Model Intelligence must never add an unselected model or broaden the roster implicitly.

When a valid custom policy exists, APEX sends the resulting role-specific ordered roster to OpenRouter using the native `models` fallback parameter. APEX makes one paced gateway attempt rather than replaying the same roster through the three legacy logical rungs. OpenRouter may fall through the ordered models, and APEX records the concrete model returned by OpenRouter.

### Evidence and attribution model

Model prices are not architectural constants. The operator console reads the live OpenRouter `/api/v1/models` catalog and may compute a transparent static value-efficiency heuristic from current price, context, and capability metadata. That score is a cold-start comparison aid, not an intelligence benchmark.

The separate learned ranking uses actual APEX operational evidence. Generation metadata is recorded without prompt/completion content and joined by durable task ID to the existing `task_outcomes` records. Evidence may include:

- concrete served model and ordered requested route roster;
- selected route candidate safely attributable for learning;
- attribution basis and attribution coverage;
- observed latency;
- prompt/completion/cached/reasoning token counts;
- OpenRouter-reported generation cost when available;
- generation reliability/tool-call behavior;
- completed-task success, quality, satisfaction, and complexity;
- privacy-minimized OpenRouter router-audit metadata when returned.

Concurrent task attribution uses Node `AsyncLocalStorage`. The production instrumented BaseAgent injects the current task-local execution context into the existing normal LLM `complete()` calls, so one multi-concurrency agent cannot leak task identity into another generation.

APEX keeps the concrete served model separate from the operator-selected route candidate it is allowed to learn from. Exact concrete matches are attributable. A request containing exactly one selected alias/router/model is attributable to that sole route candidate. A multi-candidate alias/router fallback whose concrete response does not exactly identify a requested candidate remains **unattributed**. Ambiguous attribution is excluded rather than guessed, and the operator-facing intelligence report exposes the resulting attribution coverage.

A completed task outcome is credited once to the dominant **attributable selected route candidate** for that task rather than once per LLM iteration. This prevents repeated reasoning turns from inflating successful-task samples, avoids crediting every transient fallback with the same outcome, and prevents ambiguous alias traffic from contaminating a selected candidate's record.

Adaptive ranking is not an inference dependency. If telemetry/outcome reads fail or evidence is insufficient, APEX preserves the operator-defined order. Telemetry writes are best-effort and must never convert a successful generation into a task failure.

The learned observed score is objective-specific and combines completed-task outcome quality, generation reliability, actual generation cost, and latency. Its precise scoring/evidence contract is documented in `docs/MODEL_INTELLIGENCE.md` and protected by deterministic CI.

### Controlled learning and complexity escalation

Controlled learning trials are optional and default off. They are limited to Adaptive mode, selected candidates, low-complexity work, deterministic task-based sampling, and a hard maximum trial rate of 25%. A hard role pin disables trials for that role. Trial selection targets the least-sampled under-threshold selected candidate rather than random exploration.

Smart complexity escalation is optional and default off. When enabled, high-complexity work shifts to the Quality objective, while routine neutral Balanced work may shift to Budget. Explicit routine Quality/Budget/Speed preferences are preserved, missing complexity does not change the objective, role pins remain authoritative, and evidence thresholds still govern automatic model movement.

The API/UI must expose the effective objective when complexity escalation changes it.

### Consequences

- OpenRouter remains the production inference gateway even when the selected roster contains models from OpenAI, Anthropic, Google, DeepSeek, Qwen, or another model family available through OpenRouter.
- Do not silently restore the retired direct Gemini/Groq/Cohere/Poolside/Qwen/Kilo/Mistral production provider chain outside OpenRouter.
- The reviewed MiniMax M3 Free → Nemotron 3 Ultra Free chain remains the fail-safe when no valid custom policy is present.
- OpenRouter gateway pacing, retry-after behavior, circuit breakers, token reservation, malformed-tool-call rejection, non-completion detection, and actual served-model diagnostics remain production controls.
- Multiple keys from one OpenRouter account are credential redundancy, not separate account quotas.
- Free model variants are permitted in an operator-selected roster, but free-tier availability/rate limits do not weaken failure handling or permit fabricated completion.
- A model that lacks reliable tool calling may be displayed/selectable for cost comparison, but the operator console must flag that limitation; APEX's tool-call and completion guards remain authoritative.
- Model telemetry must not persist prompt text, completion text, tool-result content, secrets, or API keys.
- OpenRouter router-audit metadata must be sanitized to bounded routing identity/status fields before persistence; free-form summaries/pipelines are not Model Intelligence evidence.
- Learned routing does not authorize bypassing approvals, tool permissions, spend caps, or other governance controls.
- Changes to the routing/evidence contract require deterministic routing/model-intelligence tests and documentation updates.

The full durable decision is recorded in `docs/ADR-012_MODEL_INTELLIGENCE.md`.

## ADR-005 — Reliability controls are permanent production controls

**Status:** Accepted  
**Last confirmed:** 2026-08-28

The following controls are not demo throttles and must not be removed simply to increase throughput:

- scheduled-task deduplication;
- provider pacing/backpressure;
- circuit breakers and retry-after handling;
- token reservation/pacing;
- malformed-tool-call detection;
- non-completion detection;
- branch/review guards;
- deploy provenance verification.

### Consequences

Performance work must improve throughput without converting repeated work, provider exhaustion, or unverified side effects into false success.

## ADR-006 — Admin authentication fails closed

**Status:** Accepted  
**Last confirmed:** 2026-08-28

`APEX_ADMIN_PASSWORD` and `APEX_ADMIN_TOKEN` are deployment secrets. There is no hardcoded source-code fallback.

### Consequences

If admin authentication secrets are missing, login must fail closed rather than activate a committed credential. Public health may remain available for operational diagnosis.

## ADR-007 — Runtime database access is not management-plane authority

**Status:** Accepted  
**Last confirmed:** 2026-08-28

Application access through `DATABASE_URL`, a service-role credential, connector token, or similar runtime secret does not automatically authorize project administration, schema changes, destructive SQL, migrations, auth-policy changes, credential rotation, or provider-management operations.

### Consequences

Production database/Supabase management actions require:

- exact target-project verification;
- a credential intended for that target and operation;
- explicit approval for schema/destructive/management changes;
- a recovery/rollback plan where applicable;
- result verification against the intended environment.

Do not reuse another application's management credential because it happens to authenticate.

## ADR-008 — Convex remains experimental, not production authority

**Status:** Accepted  
**Last confirmed:** 2026-08-28

`packages/convex-backend` and the associated CI/CD worker are an unfinished/experimental path. Production autonomy does not move to Convex merely because its typecheck passes.

`APEX_CONVEX_AUTONOMY_ENABLED=false` is the normal production posture unless a reviewed migration explicitly changes the architecture.

## ADR-009 — Documentation has an explicit precedence order

**Status:** Accepted  
**Last confirmed:** 2026-08-28

When documentation conflicts, use this order:

1. direct live production evidence and current source;
2. `AGENTS.md`;
3. this architecture decision log and `docs/PRODUCTION_OPERATIONS.md`;
4. `README.md` and `docs/deploy-provenance.md`;
5. `CHECKLIST.md` / `ROADMAP.md`;
6. historical plans and dated notes.

### Consequences

Discovering a stale current-state statement creates documentation work. Do not knowingly leave contradictory active instructions behind.

## ADR-010 — Infrastructure identifiers are configuration, not guesses

**Status:** Accepted  
**Last confirmed:** 2026-08-28

The exact Google Cloud project ID, Cloud Run region, service name, secret bindings, production database target, and current live SHA must come from trusted configuration or direct platform evidence.

### Consequences

- Do not copy identifiers from another project.
- Do not infer a service name from a domain or repository name.
- Do not hardcode guessed identifiers merely to make automation proceed.
- Missing target information is a failed precondition that should be reported explicitly.

## ADR-011 — Browser-independent autonomy requires a durable Cloud Run execution source

**Status:** Accepted  
**Last confirmed:** 2026-08-30

The dashboard/browser, an HTTP request, a JavaScript timer, and the lifetime of one Cloud Run HTTP instance are not authoritative sources of autonomous execution.

Durable work identity, scheduling state, claims, retries, approvals, and completion evidence belong in Postgres. Production must also have a verified Google Cloud Run execution primitive that provides CPU/execution opportunities independently of an open browser session.

The repository provides a dedicated autonomous runtime at:

`pnpm --filter @workspace/api-server run start:worker`

That runtime:

- probes the authoritative Postgres database before accepting work;
- fails closed if durable state is unavailable;
- starts the same governed workforce and scheduler used by the control plane;
- does not run database migrations or management-plane operations;
- keeps task/job ownership in Postgres rather than process memory;
- shuts down claim loops on `SIGTERM`/`SIGINT` and leaves unfinished durable work recoverable.

### Cloud Run topology rule

This ADR defines the execution requirement but does **not** guess or silently create a GCP resource.

Before production activation, inspect the exact existing Cloud Run configuration from trusted platform evidence. The production topology must then be one deliberately reviewed option that actually satisfies the requirement, for example:

- the existing HTTP service intentionally configured with a minimum live instance and instance-based CPU allocation, if that is verified to be the chosen architecture; or
- a Cloud Run Worker Pool running the same immutable APEX image with the dedicated `start:worker` command, if an additional worker resource is explicitly approved and provisioned; or
- another reviewed Cloud Run-native design that provides equivalent durable wake/execution semantics.

Cloud Scheduler or Cloud Run Jobs may be part of a design, but merely waking an HTTP endpoint is not sufficient if queued agent work can stop again as soon as request-scoped CPU is removed.

### Consequences

- In-process polling timers are latency optimizations, not correctness mechanisms.
- Closing the dashboard must not stop autonomous progress.
- A production release cannot be called autonomously complete until a no-browser acceptance test proves future work wakes and executes.
- Multi-instance task/job claims must remain safe because more than one worker may run.
- A worker process must never run production schema migrations merely because it possesses `DATABASE_URL`.
- Any new Cloud Run Worker Pool, Job, Scheduler, service scaling change, or instance-CPU change requires exact target verification, explicit infrastructure review/approval where required, rollback planning, and production verification.
- Do not create a replacement HTTP Cloud Run service to satisfy this ADR.

### Acceptance evidence

At minimum, production evidence must show:

1. a future-due scheduled job persisted in Postgres;
2. the dashboard/browser closed;
3. the durable Cloud Run execution source wakes/processes the job;
4. resulting child tasks are durably claimed and executed;
5. a worker replacement/restart does not lose the occurrence or duplicate a side effect;
6. `/health` reports the expected immutable build SHA and a healthy task-queue verdict after the scenario.

Operational procedure is documented in `docs/DURABLE_AUTONOMY_OPERATIONS.md`.

## ADR-012 — Model Intelligence learning authority is operator-bounded and fail-safe

**Status:** Accepted  
**Last confirmed:** 2026-08-30

The durable Model Intelligence authority, attribution rules, privacy boundary, controlled-learning constraints, complexity escalation rules, and verification requirements are defined in `docs/ADR-012_MODEL_INTELLIGENCE.md`.

ADR-012 refines ADR-004's model-adaptation contract; it does not change OpenRouter's role as the production LLM gateway or expand APEX's authority over the operator-selected roster.

### Consequences

- Ambiguous model/alias attribution is excluded rather than guessed.
- Concrete served-model identity remains separate from selected-route learning identity.
- Learning trials and complexity escalation are opt-in and bounded.
- Role pins and evidence thresholds remain stronger than adaptation.
- Model-learning telemetry is operational metadata, not prompt/content storage.
- If Model Intelligence cannot establish safe evidence, production routing falls back to the saved operator order.

## ADR-013 — Durable artifacts, sandbox executor, and cron governance are separate GCP-bounded resources

**Status:** Accepted  
**Last confirmed:** 2026-09-06

APEX's container filesystem is ephemeral, so finished work needed a durable home, and heavy builds needed isolation beyond the in-process 10-second `runInSandbox`. This change set adds three bounded capabilities, each scoped to the existing GCP project/region and none of them a change of the control-plane host:

1. **GCS artifact store** (`APEX_ARTIFACT_BUCKET`) — durable deliverables (documents, builds, renders) with object names `projects/<projectId>/<taskId>/<file>`; the `artifacts` table is the audit row; `tasks.result_artifacts` carries result links. Every operation fails closed when the bucket env var is unset.
2. **Cloud Run Jobs sandbox executor** (`APEX_EXECUTOR_JOB`) — heavy `runtime='job'` tasks are claimed by id and executed in a separate Cloud Run Job container (same immutable SHA image, ≤55 min wall clock), with GCS workspace sync (Phase 3) before/after and artifact push. Dispatch uses `gcloud run jobs execute` via `execFile` (the repo's existing CLI pattern). This is a new GCP resource, not the control-plane service — ADR-001/ADR-002 are unchanged.
3. **Cron governance** — dynamic (agent-created) `scheduled_jobs` are bounded: total ceiling (`APEX_MAX_DYNAMIC_JOBS`, default 25), per-workstream cap 3, frequency floor 15 minutes enforced at insert (`schedule_task`) and hourly by the `cron_governor` job. `work_generation` (every 10 min) is the bounded cron-creating-cron: it plans concrete deduplicated tasks from open goals, accepted opportunities, and due workstreams.

Autonomy-mode approval policy (`projects.autoapproveTools`) allows a bounded class of tools (push/PR on APEX-created repos, registered-hook deploys, executor dispatch, artifact publication) to skip human approval only inside an autonomy-mode project. The hard-gated set (`deploy_to_environment`, `rollback_deployment`, `make_outbound_call`, `runShell`, hook/repo registration, connector sends) is never auto-approvable (enforced by `scripts/verify-approval-policy.ts`).

### Consequences

- Finished work survives instance recycle (bucket + workspace sync + executor).
- Heavy work executes with minutes-scale budgets and real isolation without touching the control-plane service or its approval paths.
- Cron growth is governed by ceilings/floors with deterministic guards in CI; the governor only pauses, never creates.
- New GCP resources require real operator configuration (bucket name, job name); unset means fail-closed tool errors / no-op dispatch, never invented values.
- Deploy hooks are registrable webhooks (Vercel-style) for hosted client deliverables; hook URLs are secret-ref style (`env:VAR_NAME`) and never logged. APEX's own hosting remains Cloud Run only.

## ADR-014 — Task execution is checkpointed and resumable; approval waits yield instead of blocking

**Status:** Accepted
**Last confirmed:** 2026-09-08

Before this decision, `BaseAgent.executeTask` treated one execution attempt as
indivisible: all progress lived in a local, in-memory conversation array, and
the only two outcomes were a completed/failed task or the 10-minute hard
wall-clock timeout firing and discarding every bit of intermediate progress
into a `blocked` quarantine that required manual operator unblock. Separately,
`requestHumanApproval` polled in-process for up to five minutes waiting for a
human decision — holding a concurrency slot and racing that same hard timeout
the entire time, and auto-rejecting anything nobody clicked within five
minutes. Both were fundamentally incompatible with the goal of continuing
useful work while the operator is offline for hours, not minutes.

### Decision

1. **Checkpoint/resume.** A soft deadline — `APEX_SOFT_TIMEOUT_RATIO` (default
   0.7) of the hard timeout returned by `resolveHardTimeoutMs()` — is checked
   once per iteration, only between tool-call batches, never mid tool-call.
   When crossed, `executeTask` stops starting new LLM/tool work, builds a
   `TaskCheckpoint` (`packages/core/src/task-checkpoint.ts`) containing the
   real, budget-capped resumable conversation history plus real
   completed-steps/findings/decisions/unresolved-blockers — never a fabricated
   summary — and calls the new guarded `TaskQueue.checkpointAndResume()`,
   which atomically persists the checkpoint into `tasks.context` and returns
   the row to `pending` in one ownership-checked UPDATE
   (`liveOwnershipPredicate()`, the same guard `resume()`/`markInProgress()`
   already used). A resumed execution restores that exact history rather than
   starting a fresh conversation. Every checkpoint is additionally logged to
   the append-only `task_checkpoints` audit table. The 10-minute (55-minute
   for sandbox-executor `runtime='job'` tasks) hard timeout remains an
   emergency-only backstop for a truly wedged await; it should rarely fire for
   ordinary long-running work now that the soft deadline slices it first.
2. **Approval yield.** `requestHumanApproval` (the instrumented, production
   `BaseAgent` in `instrumented-base-agent.ts`) no longer waits in-process. It
   persists the pending approval, marks the task `awaiting_approval`, and
   throws `ApprovalYieldSignal` — a dedicated signal `executeTask`'s outer
   catch recognizes and returns cleanly from (neither success nor failure),
   the same way it already special-cased an LLM capacity pause. `POST
   /api/approvals/:id/approve|reject` now requeues the task the instant a
   human decides (fast path); the existing durable recovery sweep in
   `instrumented-base-agent.ts` is an unconditional backstop (no stale-live-
   waiter cutoff is needed anymore — there is no live waiter to outlive). The
   old 5-minute auto-reject timeout is replaced by a durable,
   operator-configurable auto-reject window (`APEX_APPROVAL_AUTO_REJECT_HOURS`,
   default 24h; 0 disables it) that sets the SAME plain `rejected` status a
   human clicking Reject would, so it flows through the existing one-shot
   compare-and-set consumption in `consumeRecoveredContinuation` rather than a
   separate code path. This is auto-**reject** only — it can never
   auto-approve, preserving the fail-closed default.
3. **Heavy-work classifier is advisory only.** `work-classifier.ts` detects
   test-suite/build/render/static-analysis/browser-automation/data-processing
   signals in task text and injects a nudge recommending the existing
   `run_executor_job` sandbox tool, both at delegation time (appended to the
   task description) and at execution time (only when the executing agent
   actually holds that tool and the task is not already executor-bound). It
   never sets `context.runtime` itself: doing so would silently reassign the
   task to the fixed `apex-executor-001` identity and its own tool set
   (exactly what `run_executor_job` does deliberately today), discarding
   whatever role-specific tools/persona the task's actual assignee has.
4. **Shared runtime bootstrap.** The dedicated `start:worker` runtime
   (ADR-011) previously built its workforce and scheduler directly and
   silently skipped everything the HTTP control plane did around them:
   `loadSettingsIntoEnv`, token-ledger hydration, lease-expiry recovery,
   default job seeding, `CampaignRunner`, and the sandbox-executor dispatch
   loop. `packages/api-server/src/runtime-bootstrap.ts` is now the single
   routine both `index.ts` and `worker.ts` call for every piece of
   runtime-critical initialization; only migrations (HTTP-only, per ADR-011)
   and HTTP-specific concerns (Express app, routes, the browser health-poll
   loop, WebSocket, dashboard static serving) remain outside it.
5. **Durable worker heartbeat.** `worker-heartbeat.ts` adds a
   `worker_heartbeats` table every runtime (HTTP or standalone worker)
   upserts a row to on a 15-second interval — worker instance id, build SHA,
   started/last-heartbeat timestamps, agent/alive-agent counts, current/last
   task, scheduler heartbeat, last error, status. `/health` reads it as a
   field distinct from the existing process-local `workforce` liveness block:
   a healthy HTTP listener must never be read as proof that a separately
   deployed autonomous worker process is alive, which was previously an
   explicitly documented, unresolved gap (see `agent-supervisor.ts`'s
   "KNOWN LIMITATION" comment, now closed).
6. **Task economy.** `execution-budget.ts` adds deterministic (no extra LLM
   call) repetition detection — three identical `(tool, args)` calls outside
   the polling/decision tool exemptions force a one-time intervention message
   — and a budget nudge ("what concrete artifact moves this forward") once a
   task has burned most of its iteration budget on pure investigation with no
   decision-category tool call yet. Both fire at most once per task,
   mirroring the existing malformed-tool-call/non-completion guard pattern.
7. **Structured outcome taxonomy.** `execution-outcome.ts` gives
   `task_hard_timeout` / `soft_yield` / `approval_yield` /
   `task_ownership_loss` / `rate_limit` / `circuit_breaker` /
   `provider_timeout` a shared vocabulary and one structured JSON log-line
   shape (`apex.task_outcome`, `apex.tool_call`), instead of the free-text/
   substring-matched error strings this previously relied on exclusively.
   Existing detection functions (`isHardTaskTimeout`, `isLLMIntentionalPause`,
   etc.) remain the source of truth; this only labels their result
   consistently.
8. **Autonomy dashboard.** `GET /api/autonomy` answers "is APEX actually doing
   useful unattended work": healthy/total worker heartbeats, active agents,
   pending/in-progress/blocked task counts and oldest pending task, durable
   checkpoints-created/resumed counts, executor job breakdown, retry backlog,
   pending approvals, 1h/24h throughput, goal counts, and
   duplicate-side-effect-prevention events (wired to three real guard events —
   ownership-loss refusal, unique-index delegation dedupe, lost
   compare-and-set race on approval consumption — never fabricated).

### Consequences

- A checkpoint's resumable state lives on `tasks.context.checkpoint`; the
  `task_checkpoints` table is an append-only audit/dashboard log, not the
  resumable state itself, and must not be treated as such.
- An executor-sandbox task (`context.runtime='job'`) that soft-yields has its
  `dispatchedAt`/`dispatchAttempts` markers cleared as part of the same
  guarded write, or the dispatch loop's `dispatchedAt IS NULL` predicate would
  never re-fire it — this reset is load-bearing, not incidental.
- No new duplicate side effects: a checkpoint can only land on a clean
  iteration boundary (never mid tool-call), `checkpointAndResume` uses the
  same ownership predicate as every other non-terminal transition, and the
  approval-yield path never executes a gated tool without first re-verifying
  and one-shot-consuming the human decision (unchanged from ADR-013).
- The soft-deadline/approval-yield mechanisms are additive: they do not
  relax, bypass, or replace any existing approval gate, hard-gated tool set,
  autonomy-mode policy, or the hard-timeout quarantine's manual-unblock
  requirement.
- Both entrypoints (`index.ts`, `worker.ts`) must continue to call
  `bootstrapApexRuntime()` for any future runtime-critical initialization;
  adding a subsystem to only one of them silently reintroduces the divergence
  this decision closed.
- Deterministic guards: `scripts/verify-checkpoint-resume.ts`,
  `verify-soft-deadline-yield.ts`, `verify-heavy-work-routing.ts`,
  `verify-task-repetition-guard.ts`, `verify-durable-worker-heartbeat.ts`,
  `verify-autonomy-dashboard.ts`, `verify-crash-recovery-integration.ts`, plus
  updates to `verify-approval-state-integrity.ts`,
  `verify-agent-loop-supervision.ts`, `verify-durable-worker-runtime.ts`, and
  `verify-executor-dispatch.ts` for the refactored bootstrap locations.
- **Not yet production-verified.** This decision's implementation has passed
  full production typecheck and every deterministic guard in a sandboxed
  environment with no live database or Cloud Run access. It has NOT been
  deployed, and the checkpoint/resume and approval-yield mechanisms have not
  yet been exercised against real production traffic or a real multi-instance
  Cloud Run topology. Treat this ADR as describing reviewed, tested source —
  not a completed release — until a deploy following
  `docs/PRODUCTION_OPERATIONS.md` records the verification evidence that
  standard requires.

## How to change an architecture decision

A proposed change should include:

1. the reason current architecture is insufficient;
2. expected benefits and measurable success criteria;
3. migration plan;
4. security/cost/operational impact;
5. rollback plan;
6. code changes;
7. CI/test changes;
8. production verification plan;
9. documentation changes.

Once accepted, mark the old ADR **Superseded**, point to the replacement decision, and update all canonical docs so two active instructions do not coexist.
