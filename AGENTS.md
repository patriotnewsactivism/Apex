# Repository Guidelines — APEX
_Last verified against current source, production health, and CI: 2026-08-28._

This is the canonical instruction file for AI coding tools working in this
repository. Keep it synchronized with live source and production evidence.
Do not recreate per-tool copies that can drift.

## Current production runtime

APEX itself runs on **Google Cloud Run** behind the production domain:

`https://apex.donmatthews.live`

The previous AWS Lightsail/CodeBuild deployment path is retired and must not be
restored. Railway and Vercel may still appear as deployment targets for client
projects APEX manages; neither is the APEX control-plane host.

A production release is complete only after all of these are true:

1. the intended reviewed commit is on `main`;
2. CI is green;
3. Google Cloud Build builds the exact clean commit with an immutable SHA tag;
4. the **existing** Cloud Run service is updated to that image;
5. Cloud Run reports the new revision Ready;
6. `https://apex.donmatthews.live/health` reports the expected `build.sha` and
   `taskQueue.verdict: "ok"`;
7. the changed feature is smoke-tested through its real production path.

The deployment implementation is `packages/cicd-automation/src/cloud-run-deployer.ts`.
`deploy_to_environment` and rollback remain approval-gated. Deployment requires
explicit `APEX_DEPLOY_ENABLED` consent plus the exact existing Google project,
region, and service identifiers. The deployer uses `gcloud run services update`,
not `gcloud run deploy`, specifically so it cannot silently create a duplicate
service and so existing environment variables, Secret Manager refs, runtime
service account, scaling, ingress, custom-domain mapping, and resource settings
remain intact.

Required deploy configuration:

- `APEX_DEPLOY_ENABLED=production` (or `all`)
- `APEX_GCP_PROJECT_ID`
- `APEX_CLOUD_RUN_REGION`
- `APEX_CLOUD_RUN_SERVICE`
- authenticated `gcloud` identity (human login or Google Workload Identity;
  never commit service-account JSON keys)

See `docs/deploy-provenance.md` and `cloudbuild.apex.yaml`.

## What APEX is

APEX is a persistent hierarchical autonomous workforce, not a request/response
chatbot.

```text
APEX CEO
├── CTO -> Lead Developer -> Frontend / Backend / DevOps / QA
└── COO -> Lead Researcher / Sales / Marketing / Customer Success
QA Director -- independent quality/oversight role
```

The production workforce is 13 agents. Generic specialist classes may exist in
source but are not part of the instantiated production organization unless the
workforce definition changes explicitly.

## Stack and conventions

- Package manager: **pnpm** workspace. Do not introduce npm/bun lockfiles.
- TypeScript strict mode; ESM via `tsx`. Use `import`, not CommonJS `require()`.
- Container runtime: Docker on Google Cloud Run.
- Database access: Postgres/Supabase through Drizzle ORM and `DATABASE_URL`.
- Schema bootstrap/migration logic is idempotent at startup through the DB layer.
- The old SQLite runtime and retired Railway Postgres are not production stores
  and must not be revived.
- `packages/convex-backend` remains experimental. Production Convex autonomy is
  disabled unless `APEX_CONVEX_AUTONOMY_ENABLED=true` is an intentional,
  reviewed architecture change.

## LLM intelligence policy — OpenRouter production

`packages/core/src/llm-client.ts` is the source of truth. Every production APEX
unit routes through OpenRouter. Do not restore the previous Gemini/Groq/Cohere/
Poolside/Qwen/Kilo/Mistral free-first chain unless the operator explicitly
changes policy again.

Current logical provider order:

1. `openrouter-deepseek-flash`
   - primary production route;
   - DeepSeek V4 Flash latest alias as pinned in source.
2. `openrouter-deepseek-flash-0731`
   - fixed-version Flash fallback.
3. `openrouter-deepseek-pro`
   - heavier DeepSeek V4 Pro fallback for difficult work/capacity recovery.

All use the OpenAI-compatible OpenRouter endpoint:

`https://openrouter.ai/api/v1`

Credential env vars:

- `OPENROUTER_API_KEY`
- `OPENROUTER_API_KEY_2` (optional credential redundancy)

Two API keys belonging to the same OpenRouter account do **not** create separate
account balances or independent account-wide quota. Treat them as credential
redundancy only.

OpenRouter requests include APEX attribution headers and retain provider pacing,
retry-after handling, transient cooldowns, circuit breakers, context trimming,
token reservations, and actual serving-provider diagnostics.

### Routing behavior

- Preserve the exact reviewed provider/model order in live source.
- Preserve structured tool calling. A response that merely narrates a tool call
  is not successful execution.
- Record actual serving provider/model and real provider failures.
- Preserve tool-call/result message pairing while trimming context.
- Provider exhaustion is a capacity pause, not an agent failure, when a
  machine-readable resume time exists.
- Do not silently route to unrelated legacy providers because an OpenRouter
  model is temporarily unavailable.

`scripts/verify-provider-routing.ts` and
`scripts/verify-provider-backpressure.ts` are deterministic guards and must stay
aligned with the production OpenRouter stack.

## Production concurrency and spend controls

Current production defaults in `.env.example` are designed for a real workforce,
not the temporary demo throttle:

- `APEX_MAX_CONCURRENT_LLM_CALLS=6`
- `APEX_LEAD_RESEARCH_CONCURRENCY=3`
- `APEX_MAX_OUTPUT_TOKENS=4096`
- leadership roles may use larger role-specific output ceilings
- `APEX_TOKEN_CAP_TOTAL=0` means no APEX-wide daily ceiling unless the operator
  deliberately sets one
- `APEX_TOKEN_PACING_ENABLED=true`
- `APEX_TOKEN_PACING_BURST_TOKENS=50000`

The scheduled-task dedupe and provider backpressure fixes are permanent safety
controls, not demo throttles. Do not remove them to increase throughput.

Token capacity is not the same thing as a spending allowance. OpenRouter account
billing controls remain authoritative. If explicit APEX token caps are added,
they must be treated as hard operational limits and paced/reserved atomically so
concurrent workers cannot oversubscribe them.

`GET /api/tokens` is the operational usage view. Public `/health` exposes only
aggregate non-secret capacity state.

## Deployment safety

APEX production deployment must be **existing-service-only**.

`cloudbuild.apex.yaml` builds an immutable `:<sha>` image and bakes
`APEX_BUILD_SHA` / `APEX_BUILD_TIME` into the image. The deployment path first
describes the configured Cloud Run service and refuses to continue if it cannot
find that exact target. It then uses `gcloud run services update --image ...`.

Never:

- create a new Cloud Run service as a fallback when the configured one is not
  found;
- replace all service environment variables during an image update;
- expose Secret Manager values in logs;
- fake `APEX_BUILD_SHA` as a runtime override simply to make health verification
  pass;
- report a release successful before `/health.build.sha` matches the requested
  commit;
- revive the removed AWS Lightsail/CodeBuild path.

Rollback routes traffic to the prior Cloud Run revision and verifies `/health`.

## Approval and security rules

- All `/api/*` routes except `/api/auth/login` and `/health` remain behind
  `requireAdminAuth`.
- Secrets are referenced by environment-variable name only in logs, reports,
  commits, and PR descriptions. Never log secret values.
- Human approval is per tool. Do not create a global bypass.
- Production deploy/rollback, protected remote writes, outbound calls,
  externally sent communications, financial actions, and other irreversible
  effects remain approval-gated unless governance is explicitly changed.
- `runShell` remains approval-gated. Safe local/feature-branch work may remain
  automatic where current policy allows it.
- Escalations are notifications, not approvals.
- Normal engineering work lands through feature branches/PRs; emergency direct
  production fixes must still be validated by deterministic CI and live health.

## Autonomous work integrity

- A task is not complete because an agent says what it intends to do. The
  non-completion guard must continue catching announced-but-not-taken tool work.
- Scheduled delegation must remain deduplicated so multiple scheduler passes do
  not create the same live LLM task repeatedly.
- Provider-capacity pauses must release leases and defer work without consuming
  ordinary task retry budgets.
- Managers must follow delegated work through to a measurable result rather than
  treating delegation itself as completion.
- Repeated current failures are engineering defects until evidence shows they
  are transient/recovered.

## Verification sequence

For any real code fix or feature:

1. Start from current `origin/main`.
2. Run production typecheck.
3. Run deterministic guards relevant to the change; LLM changes require routing
   and backpressure guards.
4. Build the dashboard and verify real output.
5. Require green CI before ordinary merge/release.
6. For production behavior, build an immutable Cloud Run image from the exact
   reviewed SHA and update the existing service.
7. Verify `https://apex.donmatthews.live/health` reports that SHA and a healthy
   queue.
8. Smoke-test the actual changed feature against production.
9. Record what was verified and what remains unverified.

A successful build is not a successful deployment. A Ready Cloud Run revision
is not a successful deployment until the expected commit is answering the
production health endpoint.

## Context-budget rules

`packages/core/src/context-budget.ts` bounds iterative task history. Tool results
can become expensive because history is re-sent on each model iteration.

Do not optimize context by deleting arbitrary messages. Assistant `tool_calls`
and matching `tool` messages must remain structurally paired. Preserve the
system prompt, original task, and recent turns.

## Other source-of-truth documents

- `BUSINESS_PROFILE.md` — BuildMyBot product/pricing/ICP ground truth.
- `APEX_CHARTER.md` — mission/governance; stale infrastructure/model notes do
  not override this file or live source.
- `APEX_INTEGRATION.md` — BuildMyBot workforce integration behavior.
- `PLAN.md`, `ROADMAP.md`, `CHECKLIST.md` — living status/planning documents.
- `docs/deploy-provenance.md` — production release/provenance contract.
- `cloudbuild.apex.yaml` — immutable Google Cloud Build image definition.

When documentation conflicts with current runtime evidence, state the conflict,
prefer the most direct evidence, then update the stale documentation so the
contradiction does not survive the task.
