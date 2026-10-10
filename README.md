# APEX — Autonomous AI Workforce

APEX is a persistent, hierarchical multi-agent operating system for running engineering and business work with real tools, approvals, memory, scheduling, health monitoring, and measurable follow-through.

This repository is the source for the APEX control plane and dashboard.

## Production: Railway

**APEX itself runs on Railway** — project `APEX`, service `apex-backend`.

Production URL: `https://apex.donmatthews.live`

Railway builds the repository `Dockerfile` (see `railway.toml`), health-checks `/health`, restarts on failure, and deploys itself from `main`. There is no deploy workflow in front of it, so **a push to `main` reaches production directly**.

Google Cloud Run is a retired APEX hosting path: billing is disabled on project `apex-503709`, so it serves nothing. AWS Lightsail/CodeBuild is retired and must not be restored. The React dashboard also has a Vercel project (`don-matthews/apex`) that posts the GitHub `Vercel` status from a Vite-only `vercel.json` build (`pnpm --filter @workspace/dashboard run build`). Vercel, Render, and other platforms may appear in connectors or client-project tooling because APEX can manage software deployed elsewhere. None of them hosts the APEX control plane, and the Vercel GitHub status is not a Railway deploy gate.

Do not redirect APEX production to another platform without an explicit operator instruction. The old Cloud Run GitHub deploy workflow has been removed. `cloudbuild.apex.yaml` and the Cloud Run deployer remain only as an explicitly gated migration-back path behind `APEX_DEPLOY_ENABLED`; reactivating that path while GCP billing is disabled cannot deploy anything.

A release is not complete until `https://apex.donmatthews.live/health` reports the exact expected `build.sha` and authenticated `GET /api/health/detail` reports a healthy task queue.

See:

- `docs/APEX_MASTER_OPERATING_MANUAL.md` — consolidated current system inventory, controls, capability map, and bug-eradication baseline for engineers/Copilot.
- `AGENTS.md` — canonical repository instructions for coding agents and contributors.
- `docs/PRODUCTION_OPERATIONS.md` — production deploy, verification, rollback, and incident runbook.
- `docs/deploy-provenance.md` — exact source-to-image-to-runtime provenance contract.
- `docs/ARCHITECTURE_DECISIONS.md` — durable architecture decisions that must not silently drift.
- `SECURITY.md` — secrets, authentication, change-control, and vulnerability rules.
- `docs/CARTESIA_SALES_TOOLS.md` — optional Cartesia sales-agent tools, APEX call-event ingestion, calendar/SMS configuration, and phone transfer setup.

## Intelligence stack

`packages/core/src/llm-client.ts` is the production source of truth for LLM routing.

APEX runs a free-first chain, with one *unrestricted* paid continuity model last (ADR-020, 2026-10-05):

1. Nex N2.5 Mini Free (`nex-agi/nex-n2.5-mini:free`) — primary
2. Nex N2.5 Pro Free (`nex-agi/nex-n2.5-pro:free`)
3. NVIDIA Nemotron 3 Super Free
4. NVIDIA Nemotron 3.5 Lightning Free
5. OpenRouter Free Router (`openrouter/free`, tool requirements preserved)
6. NVIDIA Nemotron 3 Ultra Free
7. direct Groq GPT-OSS 120B BYOK when enabled
8. direct Gemini 3.8 Flash BYOK when enabled
9. DeepSeek V4 Flash 0731 (`deepseek/deepseek-v4-flash-0731`) — paid, unrestricted continuity, last resort, on OpenRouter (`OPENROUTER_API_KEY_4`). Apex no longer calls the Nous Portal provider.

Qwen (QwenCloud, metered) is the LAST automatic route: a daily-allowance free chain (OpenRouter free, Groq, Gemini) runs first and Qwen is used only once every free pool is spent (operator decision 2026-10-10, which supersedes ADR-017's Qwen-first order). The live Qwen credential is pay-as-you-go; the operator prefers the Token Plan balance when it exists.

The operator-persisted OpenRouter model roster remains free-only. The paid routes run only when `APEX_PAID_FALLBACK_ENABLED=true` and at least one of their keys is set (Settings → Paid Continuity, or the platform environment); unset or `false` removes both and APEX parks the workforce when free/BYOK capacity is spent rather than spending further. Every free and BYOK provider is unaffected — do not unset `OPENROUTER_API_KEY_4` to stop paid spend, because it is also a free-pool account. APEX does not apply its spend, token, request, emergency-cap, or pacing governors to the paid routes. A free-model 429 on the funded OpenRouter account blocks only that account's free routing, not its paid route. Upstream OpenRouter/Nous billing, provider limits, request timeouts, backoff/cooldowns, authentication, tool authorization, and human approvals still apply to every route.

The paid routes also receive the full available conversation history rather than APEX's smaller free-route history trim, allowing the runtime to use the model's large upstream context window.

Qualifying free credentials include `OPENROUTER_FREE_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_API_KEY_2`, `OPENROUTER_API_KEY_3`, and `OPENROUTER_API_KEY_4`. Multiple keys on one OpenRouter account do not create separate free quota. Authenticated `GET /api/health/detail` `providerCredits.uniqueAccounts` is the account-level check. See `docs/FREE_ONLY_MODEL_POLICY.md` for the free-roster policy and FlashX continuity exception.

## Workforce

The production organization is a 13-agent hierarchy centered on APEX CEO, CTO, COO, engineering specialists, business specialists, and an independent QA role.

APEX is not a chatbot wrapper. Tasks are expected to progress through delegation, tools, validation, learning, and measurable completion. Announcing an intended action is not completion.

## Core safeguards

Production behavior deliberately keeps several fail-closed controls:

- approval gates for production deploys/rollbacks and other irreversible effects;
- task deduplication for scheduled delegation;
- provider pacing, backpressure, retry-after handling, and circuit breakers;
- token reservation/pacing to prevent concurrent oversubscription;
- malformed-tool-call and non-completion guards;
- exact build-SHA verification after deployment;
- admin authentication with no hardcoded credential fallback;
- existing-service-only Cloud Run rollback path (not the live host);
- cron governance (dynamic-job ceiling, frequency floor, governor pauses — never creates);
- a hard-gated approval set that no autonomy mode can ever auto-approve;
- fail-closed artifact/workspace tools when the bucket is unconfigured.

Do not remove safety controls merely to increase throughput.

## Durable execution

APEX can execute and ship deliverables durably even though the container filesystem is ephemeral:

- finished work goes to `APEX_ARTIFACT_BUCKET` (GCS) or `APEX_ARTIFACT_DIR` (Railway volume); tools fail closed if both are unset;
- durable project workspaces (`init_workspace` / `sync_workspace` / `push_workspace`) sync trees to `projects/<projectId>/workspace/<worktree>/` with checksum manifests;
- heavy tasks dispatch to Cloud Run Jobs when `APEX_EXECUTOR_JOB` is set; on Railway they default to `APEX_EXECUTOR_MODE=inprocess` so the worker loop runs them;
- code deliverables ship to new GitHub repos per workstream; hosted deliverables deploy through registered deploy hooks (`deploy_via_hook`);
- a managed `work_generation` cron plans deduplicated batches of work from goals, accepted opportunities, and workstreams; `cron_governor` keeps dynamic crons within ceilings and the 15-minute floor;
- a long task checkpoints and resumes across execution slices instead of losing progress at the 10-minute hard timeout, and a gated approval yields the execution cleanly (no live in-process wait) rather than blocking a concurrency slot while a human decides — see `docs/ARCHITECTURE_DECISIONS.md` (ADR-014);
- both the HTTP control plane and the dedicated `start:worker` runtime share one bootstrap routine, and every runtime reports a durable heartbeat so authenticated `GET /api/health/detail` can tell a healthy web server apart from a healthy autonomous worker;
- `GET /api/autonomy` (admin-auth) reports whether APEX is actually doing useful unattended work: worker health, checkpoint/yield activity, executor jobs, retry backlog, approvals, and throughput.

See `docs/ARCHITECTURE_DECISIONS.md` (ADR-013, ADR-014) and `docs/PRODUCTION_OPERATIONS.md`.

## Repository layout

```text
packages/core/             agent runtime, LLM client, tools, memory, task queue
packages/agents/           production workforce definitions
packages/api-server/       REST/WebSocket control plane and health endpoint
packages/dashboard/        operator dashboard
packages/background-jobs/  scheduling and recurring work
packages/executor/         heavy-task executor (Cloud Run Jobs or in-process on Railway)
packages/health-monitor/   component health and alerting
packages/learning-system/  outcomes, insights, and strategy optimization
packages/cicd-automation/  build/release/rollback automation
packages/convex-backend/   experimental migration; not production authority
lib/db/                    Drizzle/Postgres database layer
scripts/                   deterministic regression/operational checks
cloudbuild.apex.yaml       immutable Google Cloud Build image definition
```

## Local development

Requirements:

- Node.js 22
- pnpm 11.19.0
- a valid `DATABASE_URL`
- required local secrets supplied through environment variables, never committed

Install and validate:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck:production
pnpm run build
```

Run API and dashboard together:

```bash
pnpm run dev
```

Production CI also runs deterministic guards for provider routing/backpressure, token-budget pauses, deploy provenance, malformed tool calls, non-completion, and branch/review behavior.

If autonomous writes are blocked, follow the exact provenance rejection and
[provenance recovery instructions](docs/deploy-provenance.md#diagnosing-blocked-autonomous-tools).
Health and the mutation gate share the known build-SHA/Railway-commit resolver;
the Docker `unknown` placeholder does not override Railway's deployed commit.
LLM health combines configured keys with local routing capacity, including
budget, pacing and cooldown state, without making a live inference call.

## Production release gate

Before production deployment:

1. Start from current `main` with a clean tree.
2. Require green production CI.
3. Confirm the exact commit intended for release.
4. Push/merge that exact reviewed commit to `main`; Railway is the production deployment authority and its GitHub trigger is configured to wait for CI.
5. Confirm Railway service `apex-backend` reports a successful deployment for that commit (GitHub status `APEX - apex-backend`).
6. Verify public `GET /health` reports the released commit in `build.sha`, then verify authenticated `GET /api/health/detail` reports a healthy `taskQueue.verdict`.
7. Smoke-test the changed production path.
8. Record anything that remains unverified.

A successful build or merge is not a successful deployment. Production is released only when Railway reports success and the live health endpoint is serving the intended SHA.

## Secrets and database management

Secret values never belong in source, issues, PR descriptions, logs, screenshots, or documentation. Use deployment environment variables and Google Secret Manager references.

Runtime database access through `DATABASE_URL` is separate from management-plane permission. Do not run Supabase management operations, schema changes, or migrations against a production project merely because a runtime database credential exists. Production data-plane or management-plane changes require explicit, project-specific authorization and verification of the target.

## Documentation precedence

When documents disagree, use this order:

1. live production evidence and current source;
2. `AGENTS.md`;
3. `docs/ARCHITECTURE_DECISIONS.md` and `docs/PRODUCTION_OPERATIONS.md`;
4. this README and `docs/deploy-provenance.md`;
5. `CHECKLIST.md` / `ROADMAP.md`;
6. historical plans and dated notes.

Fix stale documentation in the same work item that discovers it. Historical notes may remain for context, but they must be clearly labeled historical and must never override current production instructions.

## Project status discipline

Only mark work complete when the implementation exists and the relevant verification has actually passed. For production changes, that includes live verification after deployment. If a result is unknown, say it is unknown; do not infer success from a build, commit, queued task, or agent narrative.

APEX should optimize for durable correctness, recoverability, auditability, and useful autonomous throughput—not impressive-looking activity.

### Turn Economy foundation

See [Turn Economy](docs/TURN_ECONOMY.md) for optional background work bundles,
batch campaign snapshots, explicit tasks without LLM calls, shared-account quota
checks and process-scoped productivity metrics. Bundling is disabled by default;
producers must explicitly accept the shared task/result contract before opting in.
