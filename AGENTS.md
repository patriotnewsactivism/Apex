# Repository Guidelines — APEX
_Last verified against current source, production health, and CI: 2026-08-30._

This is the canonical instruction file for AI coding tools and contributors working in this repository. Keep it synchronized with current source and live production evidence. Do not create per-tool instruction copies that can drift.

## Truth hierarchy

When sources disagree, use this order:

1. direct live production evidence and current source code;
2. this `AGENTS.md` file;
3. `docs/ARCHITECTURE_DECISIONS.md` and `docs/PRODUCTION_OPERATIONS.md`;
4. `README.md` and `docs/deploy-provenance.md`;
5. `CHECKLIST.md` and `ROADMAP.md`;
6. historical plans, dated notes, screenshots, and old deployment files.

Never guess a project ID, service name, region, secret name/value, database target, live SHA, or deployment state. If the exact value cannot be established from a trusted source, stop and report what is missing.

If stale documentation is discovered while doing real work, fix it in the same work item when practical. Historical material may remain for context only when it is clearly labeled historical and cannot be mistaken for current instructions.

## Current production runtime

APEX itself runs on **Google Cloud Run** behind:

`https://apex.donmatthews.live`

The former AWS Lightsail/CodeBuild deployment path is retired and must not be restored. Railway is also retired as an APEX host. Vercel, Railway, Render, and other platforms may still appear as deployment targets for client projects APEX manages; none of them is the APEX control-plane host.

A production release is complete only after all of these are true:

1. the intended reviewed commit is on `main`;
2. CI is green for that code state;
3. Google Cloud Build builds the exact clean commit with an immutable SHA tag;
4. the **existing** configured Cloud Run service is updated to that image;
5. the new revision becomes Ready;
6. `https://apex.donmatthews.live/health` reports the expected `build.sha` and a healthy `taskQueue.verdict`;
7. the changed feature is smoke-tested through its real production path.

The deployment implementation is `packages/cicd-automation/src/cloud-run-deployer.ts`.

`deploy_to_environment` and rollback remain approval-gated. Deployment requires explicit `APEX_DEPLOY_ENABLED` consent plus the exact existing Google project, region, and service identifiers. The deployer uses `gcloud run services update`, not `gcloud run deploy`, so it cannot silently create a duplicate service and so existing environment variables, Secret Manager refs, runtime service account, scaling, ingress, domain mapping, CPU/memory, and related service configuration remain intact.

Required deploy configuration:

- `APEX_DEPLOY_ENABLED=production` (or `all`)
- `APEX_GCP_PROJECT_ID`
- `APEX_CLOUD_RUN_REGION`
- `APEX_CLOUD_RUN_SERVICE`
- authenticated `gcloud` identity, using a human login or Google Workload Identity rather than committed service-account JSON keys

The exact project/region/service values are intentionally not guessed or invented in repository documentation. Use the existing production configuration.

See `docs/PRODUCTION_OPERATIONS.md`, `docs/deploy-provenance.md`, and `cloudbuild.apex.yaml`.

## What APEX is

APEX is a persistent hierarchical autonomous workforce, not a request/response chatbot.

```text
APEX CEO
├── CTO -> Lead Developer -> Frontend / Backend / DevOps / QA
└── COO -> Lead Researcher / Sales / Marketing / Customer Success
QA Director -- independent quality/oversight role
```

The production workforce is 13 agents. Generic specialist classes may exist in source but are not part of the instantiated production organization unless the workforce definition changes explicitly.

Tasks are expected to progress through real delegation, tools, verification, learning, and measurable completion. Announcing intended work is not completion.

## Stack and conventions

- Package manager: **pnpm 11.19.0** workspace. Do not introduce npm/yarn/bun lockfiles.
- Runtime/tooling target: Node.js 22.
- TypeScript strict mode; ESM via `tsx`. Use `import`, not CommonJS `require()` in production TypeScript.
- Container runtime: Docker on Google Cloud Run.
- Database access: Postgres through Drizzle ORM and `DATABASE_URL`; deployments may use Supabase-hosted Postgres, but runtime database access is not blanket management-plane authorization.
- Schema bootstrap/migration logic must remain idempotent and reviewable.
- The old SQLite runtime and retired Railway Postgres are not production stores and must not be revived.
- `packages/convex-backend` remains experimental. Production Convex autonomy is disabled unless `APEX_CONVEX_AUTONOMY_ENABLED=true` is an intentional, reviewed architecture change.

## Database and management-plane boundary

Treat data-plane access and management-plane access as different permissions.

A runtime `DATABASE_URL`, service-role credential, connector token, or other application credential does **not** authorize autonomous project administration, schema changes, migrations, destructive SQL, credential rotation, or provider-management actions.

Before any production database or Supabase management action:

1. identify the exact APEX project/target;
2. verify the credential belongs to that target and is intended for that operation;
3. obtain explicit approval for schema/destructive/management changes;
4. capture a reversible migration or rollback plan where applicable;
5. verify the result against the intended environment.

Do not reuse credentials from another application or project. Do not infer that similarly named projects are interchangeable.

## LLM intelligence policy — OpenRouter production

`packages/core/src/llm-client.ts` is the request-path source of truth. `packages/core/src/model-routing.ts` defines the operator policy contract, `packages/core/src/model-intelligence.ts` owns evidence-based ranking, and `packages/core/src/model-execution-context.ts` plus `packages/core/src/instrumented-base-agent.ts` provide concurrency-safe task attribution to normal LLM calls. Every production APEX unit routes through OpenRouter. Models from OpenAI, Anthropic, Google, DeepSeek, Qwen, or other families are permitted when selected **through OpenRouter**; do not restore the retired direct Gemini/Groq/Cohere/Poolside/Qwen/Kilo/Mistral provider chain.

With no valid operator policy, the reviewed fallback remains:

1. `~deepseek/deepseek-v4-flash-latest`
2. `deepseek/deepseek-v4-flash-0731`
3. `deepseek/deepseek-v4-pro-0813`

The authenticated Settings → OpenRouter Model Control panel may persist `APEX_OPENROUTER_MODEL_POLICY` with:

- 1–500 selected OpenRouter model IDs in global priority order, intentionally large enough for the current hundreds-model catalog;
- optional role-specific first choices, restricted to models already in that roster;
- a routing mode: `manual`, `advisor`, or `adaptive`;
- an optimization objective: `quality`, `balanced`, `budget`, or `speed`;
- a minimum completed-task sample threshold before learned routing may move a model;
- an optional controlled-learning trial rate from 0 to 25%;
- an optional smart complexity-escalation flag.

Saved policies from before the intelligence layer remain backward-compatible and parse as `manual`, with learning trials off and complexity escalation off, preserving their prior behavior.

### Routing modes and operator authority

- **Manual** — use the exact operator-defined order. Evidence is collected but never changes routing.
- **Advisor** — use the exact operator-defined order and show evidence-backed recommendations for operator review.
- **Adaptive** — evidence-qualified models may reorder **only inside the selected roster**. Under-sampled models retain their operator-defined slots. At least two models must be evidence-qualified before learned ranking can change an order.
- An explicit role-specific first choice is a hard operator pin. It stays first in adaptive mode even when another model has a higher learned score.
- Model Intelligence must never introduce an unselected model or silently broaden the operator-approved roster.

Controlled learning trials are opt-in and exist only to close cold-start evidence gaps. They are allowed only in Adaptive mode, only on tasks whose pre-run complexity is `<= 0.5`, never for a role with a hard model pin, and are deterministically sampled by task ID. Trial traffic is hard-capped at 25% and targets the least-sampled selected model below the evidence threshold. Do not turn this into unrestricted random model experimentation.

Smart complexity escalation is also opt-in. When enabled, a task at complexity `>= 0.70` uses the `quality` objective; routine work at `<= 0.35` shifts a neutral `balanced` base objective to `budget`; middle-complexity work keeps the base objective. Explicit routine `quality`, `budget`, or `speed` preferences are preserved, missing complexity never changes the objective, and role pins still win. The API/UI must expose the effective objective when it differs from the saved base objective.

Neither learning trials nor complexity escalation can make an under-sampled model evidence-qualified. Normal sample thresholds still govern automatic learned promotion.

When a valid custom policy exists, APEX sends the ordered roster to OpenRouter using its native `models` fallback parameter. APEX uses one paced OpenRouter gateway attempt for that roster and records the concrete model returned in OpenRouter's response rather than assuming the first requested model served the generation.

### Static catalog score versus learned evidence

The Settings catalog pulls current model metadata from `https://openrouter.ai/api/v1/models`. Do not hard-code current prices into runtime policy. The dashboard may compute a transparent APEX value-efficiency score from live price, context, and agent-capability metadata, but it must label that score as a **static heuristic**, not an intelligence benchmark.

The separate **Observed Model Intelligence** ranking is based on APEX's own work. Per-generation telemetry is joined by durable task ID to existing `task_outcomes` records. It may use:

- concrete model OpenRouter actually served;
- selected route candidate safely attributable for learning, with explicit attribution basis;
- attribution coverage and count of successful ambiguous calls excluded from scoring;
- observed request latency;
- prompt/completion/cached/reasoning token counts;
- OpenRouter-reported generation cost when available;
- generation success/failure and tool-call behavior;
- completed-task success, quality, satisfaction, and post-run complexity;
- privacy-minimized OpenRouter router-audit identity/status metadata when returned.

Keep concrete served-model identity separate from selected-route learning identity. Credit an exact concrete match exactly. When exactly one selected model/alias/router was requested, that sole selected route may receive route-level evidence even if OpenRouter reports a different concrete model. If multiple selected aliases/routers were sent and the concrete response does not exactly identify one requested candidate, mark the observation **unattributed** and exclude it from scoring. Never guess an alias mapping to make evidence fit the roster.

A completed task outcome is credited once to the dominant **attributable selected route candidate** for that task, not once per LLM iteration. This prevents an iterative task from becoming multiple fake successful samples, avoids crediting every transient fallback with the same task outcome, and keeps ambiguous alias traffic from poisoning rankings.

Telemetry is operational metadata only. It must **not** persist prompt text, completion text, tool-result content, secrets, API keys, OpenRouter free-form summaries, or pipeline payloads. Router metadata must be sanitized to bounded routing identity/status fields before persistence. Task identity flows through concurrent work using `AsyncLocalStorage`; the instrumented BaseAgent must continue injecting that current task-local context into the normal LLM `complete()` path so parallel tasks on the same agent cannot cross-contaminate model attribution.

Adaptive routing must fail safe: if telemetry/outcome data is unavailable or insufficient, preserve the operator-defined order. Learning is not allowed to become a new inference-availability dependency. Telemetry writes are best-effort and must never convert a successful LLM response into a failed task.

The operator-facing intelligence view must surface attribution coverage rather than hiding ambiguous exclusions.

See `docs/MODEL_INTELLIGENCE.md` and `docs/ADR-012_MODEL_INTELLIGENCE.md` for the scoring, attribution, privacy, and adaptation contract.

Credential environment variables:

- `OPENROUTER_API_KEY`
- `OPENROUTER_API_KEY_2` — optional credential redundancy

Two API keys belonging to the same OpenRouter account do **not** create separate account balances or independent account-wide quota. Treat them as credential redundancy only.

OpenRouter requests retain provider pacing, retry-after handling, transient cooldowns, circuit breakers, context trimming, token reservations, structured tool calls, and serving-provider diagnostics.

### Routing behavior

- If `APEX_OPENROUTER_MODEL_POLICY` is absent or invalid, fall back to the exact reviewed DeepSeek V4 chain.
- Operator-selected free model variants are allowed; free availability or rate limits never justify false completion or bypass backpressure.
- Flag models without reliable tool calling in the operator UI. Selecting such a model does not disable malformed-tool-call/non-completion guards.
- Preserve structured tool calling. A response that merely narrates a tool call is not successful execution.
- Record the model OpenRouter actually served, not merely the requested first choice, and keep it separate from the route candidate used for learning attribution.
- Ambiguous multi-alias/multi-router attribution must remain unattributed unless direct evidence identifies the selected candidate. Do not infer it from provider/model name similarity.
- Router audit metadata is optional observability, not a new inference dependency; its absence (including cache-hit paths) is not a generation failure.
- Preserve tool-call/result message pairing while trimming context.
- Provider exhaustion is a capacity pause, not an agent failure, when a machine-readable resume time exists.
- Do not silently route to unrelated direct legacy providers because an OpenRouter model is temporarily unavailable.
- A routing-policy change does not bypass approval requirements, tool authorization, token/spend caps, or other safety controls.

`scripts/verify-provider-routing.ts`, `scripts/verify-provider-backpressure.ts`, `scripts/verify-model-routing-policy.ts`, and `scripts/verify-model-intelligence.ts` are deterministic guards and must stay aligned with the production OpenRouter stack.

## Production concurrency and spend controls

Current production defaults in `.env.example` are intended for a real workforce, not the temporary demo throttle:

- `APEX_MAX_CONCURRENT_LLM_CALLS=6`
- `APEX_LEAD_RESEARCH_CONCURRENCY=3`
- `APEX_MAX_OUTPUT_TOKENS=4096`
- leadership roles may use larger role-specific output ceilings
- `APEX_TOKEN_CAP_TOTAL=0` means no APEX-wide daily ceiling unless deliberately configured
- `APEX_TOKEN_PACING_ENABLED=true`
- `APEX_TOKEN_PACING_BURST_TOKENS=50000`

The scheduled-task dedupe and provider backpressure fixes are permanent reliability controls, not demo throttles. Do not remove them merely to increase throughput.

Token capacity is not the same as a spending allowance. OpenRouter account billing controls remain authoritative. If explicit APEX token caps are added, treat them as hard operational limits and reserve/pace atomically so concurrent workers cannot oversubscribe them.

`GET /api/tokens` is the operational usage view. Public `/health` exposes only aggregate non-secret capacity state.

## Deployment safety

APEX production deployment is **existing-service-only**.

`cloudbuild.apex.yaml` builds an immutable `:<sha>` image and bakes `APEX_BUILD_SHA` / `APEX_BUILD_TIME` into the image. The deployment path first describes the configured Cloud Run service and refuses to continue if it cannot find that exact target. It then uses `gcloud run services update --image ...`.

Never:

- create a new Cloud Run service as a fallback when the configured service cannot be found;
- substitute a different Google Cloud project/region/service because access to the intended target is missing;
- replace all service environment variables during an image update;
- expose Secret Manager values in logs;
- fake `APEX_BUILD_SHA` as a runtime override merely to make health verification pass;
- report a release successful before `/health.build.sha` matches the requested commit;
- revive the removed AWS Lightsail/CodeBuild production path;
- claim a deploy occurred when only a build or commit occurred.

Rollback routes production traffic to the prior Cloud Run revision and verifies `/health`.

## Approval and security rules

- All `/api/*` routes except `/api/auth/login` and `/health` remain behind `requireAdminAuth`.
- `APEX_ADMIN_PASSWORD` and `APEX_ADMIN_TOKEN` are deployment secrets; there is no source-code fallback.
- Secrets are referenced by environment-variable name only in logs, reports, commits, issues, PR descriptions, and documentation. Never log or commit secret values.
- Human approval is per tool. Do not create a global bypass.
- Production deploy/rollback, protected remote writes, outbound calls, externally sent communications, financial actions, schema/destructive database operations, and other irreversible effects remain approval-gated unless governance is explicitly changed.
- `runShell` remains approval-gated. Safe local or feature-branch work may remain automatic where current policy allows it.
- Escalations are notifications, not approvals.
- Normal engineering work lands through feature branches/PRs; emergency direct production fixes must still be validated by deterministic CI and live health.

See `SECURITY.md` for the repository-wide security contract.

## Autonomous work integrity

- A task is not complete because an agent says what it intends to do. The non-completion guard must continue catching announced-but-not-taken tool work.
- Scheduled delegation must remain deduplicated so multiple scheduler passes do not create the same live LLM task repeatedly.
- Provider-capacity pauses must release leases and defer work without consuming ordinary task retry budgets.
- Managers must follow delegated work through to a measurable result rather than treating delegation itself as completion.
- Repeated current failures are engineering defects until evidence shows they are transient/recovered.
- Never manufacture metrics, status, deploy evidence, test results, or external side effects.

## Verification sequence

For any real code fix or feature:

1. Start from current `origin/main`.
2. Run `pnpm install --frozen-lockfile` when dependencies are involved or the environment is fresh.
3. Run `pnpm run typecheck:production`.
4. Run deterministic guards relevant to the change; LLM changes require routing/backpressure/model-intelligence guards, deployment changes require the provenance guard.
5. Build the dashboard and verify real output.
6. Require green CI before ordinary merge/release.
7. For production behavior, build an immutable Cloud Run image from the exact reviewed SHA and update the existing service.
8. Verify `https://apex.donmatthews.live/health` reports that SHA and a healthy queue.
9. Smoke-test the actual changed feature against production.
10. Record what was verified and what remains unverified.

A successful build is not a successful deployment. A Ready Cloud Run revision is not a successful deployment until the expected commit is answering the production health endpoint.

## CI contract

`.github/workflows/ci.yml` is the ordinary production gate. Keep it deterministic and secret-free where possible.

Production CI currently includes:

- frozen pnpm install;
- production TypeScript checks;
- provider routing guard;
- provider backpressure guard;
- budget-pause guard;
- Cloud Run deploy-provenance guard;
- malformed-tool-call guard;
- non-completion guard;
- branch/review guard;
- opportunity-engine guard;
- durable-autonomy/task-claim guard;
- approval-state-integrity guard;
- hard-timeout quarantine guard;
- durable-worker-runtime guard;
- OpenRouter model-routing-policy guard;
- evidence-driven model-intelligence guard;
- dashboard build.

Experimental Convex checks must not silently become production authority merely because they pass.

## Context-budget rules

`packages/core/src/context-budget.ts` bounds iterative task history. Tool results can become expensive because history is re-sent on each model iteration.

Do not optimize context by deleting arbitrary messages. Assistant `tool_calls` and matching `tool` messages must remain structurally paired. Preserve the system prompt, original task, and recent turns.

## Documentation maintenance

Documentation is part of the production system. Keep it truthful.

When a change affects hosting, model routing, secrets, auth, database targets, approval policy, CI, release procedure, workforce composition, or major architecture:

1. update the relevant source code;
2. update `AGENTS.md` if the canonical operating rule changed;
3. update `README.md` if contributor/operator expectations changed;
4. add or amend an entry in `docs/ARCHITECTURE_DECISIONS.md` for durable architecture decisions;
5. update `docs/PRODUCTION_OPERATIONS.md` / `docs/deploy-provenance.md` for release/operations changes;
6. update `CHECKLIST.md` / `ROADMAP.md` only with evidence-backed status;
7. clearly mark old statements historical instead of leaving contradictory “current” instructions.

Do not let a completed code migration leave documentation on the old architecture.

## Other source-of-truth documents

- `README.md` — contributor/operator orientation and current production summary.
- `SECURITY.md` — secrets, auth, vulnerability, and high-risk change rules.
- `docs/ARCHITECTURE_DECISIONS.md` — durable decisions and retired architecture.
- `docs/PRODUCTION_OPERATIONS.md` — production runbook.
- `docs/deploy-provenance.md` — source/image/runtime provenance contract.
- `docs/MODEL_INTELLIGENCE.md` — model telemetry, attribution, evidence thresholds, controlled learning, complexity escalation, adaptive-routing, and scoring contract.
- `docs/ADR-012_MODEL_INTELLIGENCE.md` — durable Model Intelligence learning-authority and privacy decision.
- `BUSINESS_PROFILE.md` — dated BuildMyBot business/ICP snapshot; verify current pricing, features, payment state, and deployment before acting.
- `APEX_CHARTER.md` — mission/governance; dated infrastructure/model notes are historical unless promoted into current canonical docs.
- `packages/core/src/buildmybot-connector.ts` — current BuildMyBot connector implementation; verify live BuildMyBot state separately.
- `ROADMAP.md`, `CHECKLIST.md` — living planning/status documents, subordinate to current source and canonical runtime docs.
- `cloudbuild.apex.yaml` — immutable Google Cloud Build image definition.

When documentation conflicts with current runtime evidence, state the conflict, prefer the most direct evidence, and update the stale documentation so the contradiction does not survive the task.

## Base44 sandbox dev environment

`docker-compose.base44.yml` runs the repo warm for the Base44 preview (dev only — production still goes through Cloud Build/Cloud Run per the provenance contract):

- Two services: `db` (postgres:16-alpine) and `app` (node:22-slim). Only host port 3000 is public.
- Single-origin wiring: the `app` container runs `pnpm run dev` (concurrently `tsx watch` API on :5000 + Vite dashboard on :3000). The Vite dev server proxies `/api` and `/ws` to `localhost:5000` inside the container — do not "fix" the proxy target to a service name; both processes share the container on purpose.
- `pnpm install --frozen-lockfile` runs on every container start; the pnpm store is a named volume so it is fast after the first boot.
- DB bootstrap is the idempotent DDL in `lib/db/src/client.ts` (`migrate()`), which `main()` catches and warns on if the DB is down — the server still boots without Postgres, it just has no data.
- `APEX_ADMIN_TOKEN` is the only secret required at boot: `api-server/src/middleware/auth.ts` calls `requireEnv` at module load and the server crashes without it. Placeholders live in `.env.base44-defaults` (FIRST env_file); real values come from the platform-managed `/run/base44/app.env` (LAST env_file, always wins).
- Vite config sets `server.allowedHosts: true` because the preview hostname changes when the sandbox is recreated.
- Verify the stack: `docker compose -f docker-compose.base44.yml ps` (db healthy, app up), then `curl -sf -H "Host: x.example.com" http://localhost:3000/` for the dashboard and `curl -X POST .../api/auth/login` for the API through the proxy.