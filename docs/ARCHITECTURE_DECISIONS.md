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

## ADR-004 — OpenRouter is the production LLM gateway

**Status:** Accepted  
**Last confirmed:** 2026-08-30

Production APEX inference routes through OpenRouter. `packages/core/src/llm-client.ts` remains the request-path implementation authority and `packages/core/src/model-routing.ts` owns the operator-selectable model policy contract.

The reviewed no-configuration fallback remains:

1. DeepSeek V4 Flash latest alias;
2. DeepSeek V4 Flash 0731 fallback;
3. DeepSeek V4 Pro 0813 fallback.

An authenticated operator may instead persist an ordered OpenRouter roster in `APEX_OPENROUTER_MODEL_POLICY`. The policy may contain 1–500 valid OpenRouter model IDs—intentionally large enough for the current hundreds-model catalog—and optional role-specific first choices. A role-specific model must already belong to the selected global roster.

When a valid custom policy exists, APEX sends the role-specific ordered roster to OpenRouter using the native `models` fallback parameter. APEX makes one paced gateway attempt rather than replaying the same roster through the three legacy logical rungs. OpenRouter may then fall through the ordered models according to its documented model-fallback behavior, and APEX records the actual model returned by OpenRouter.

Model prices are not architectural constants. The operator console reads the live OpenRouter `/api/v1/models` catalog and presents current token pricing and capabilities. APEX may compute a transparent value-efficiency heuristic for comparison, but that score must be labeled as an APEX heuristic and must not be represented as an intelligence benchmark or provider-supplied quality score.

### Consequences

- OpenRouter remains the production inference gateway even when the selected roster contains models from OpenAI, Anthropic, Google, DeepSeek, Qwen, or another model family available through OpenRouter.
- Do not silently restore the retired direct Gemini/Groq/Cohere/Poolside/Qwen/Kilo/Mistral production provider chain outside OpenRouter.
- The reviewed DeepSeek V4 chain remains the fail-safe when no valid custom policy is present.
- OpenRouter gateway pacing, retry-after behavior, circuit breakers, token reservation, malformed-tool-call rejection, non-completion detection, and actual served-model diagnostics remain production controls.
- Multiple keys from one OpenRouter account are credential redundancy, not separate account quotas.
- Free model variants are permitted in an operator-selected roster, but free-tier availability/rate limits do not weaken failure handling or permit fabricated completion.
- A model that lacks reliable tool calling may be displayed/selectable for cost comparison, but the operator console must flag that limitation; APEX's tool-call and completion guards remain authoritative.
- Policy changes are persisted and apply to subsequent LLM requests; they do not authorize bypassing approvals, tool permissions, spend caps, or other constitutional safeguards.
- Changes to the routing-policy contract require deterministic routing tests and documentation updates.

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
