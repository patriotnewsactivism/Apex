# APEX — Autonomous AI Workforce

APEX is a persistent, hierarchical multi-agent operating system for running engineering and business work with real tools, approvals, memory, scheduling, health monitoring, and measurable follow-through.

This repository is the source for the APEX control plane and dashboard.

## Production: Google Cloud Run

**APEX itself runs on Google Cloud Run.**

Production URL: `https://apex.donmatthews.live`

AWS Lightsail/CodeBuild and Railway are retired APEX hosting paths. Vercel, Railway, Render, and other platforms may still appear in connectors or client-project tooling because APEX can manage software deployed elsewhere; they are not the host for the APEX control plane.

Do not redirect APEX production to another platform to solve a deployment problem. Do not recreate the retired AWS deployment path.

The production image is built by Google Cloud Build using `cloudbuild.apex.yaml`, then the **existing** Cloud Run service is updated to the immutable image. The deploy path intentionally uses `gcloud run services update` rather than creating a service, so existing Secret Manager references, environment variables, runtime service account, scaling, ingress, CPU/memory settings, and domain mapping are preserved.

A release is not complete until `https://apex.donmatthews.live/health` reports the exact expected `build.sha` and a healthy task queue.

See:

- `AGENTS.md` — canonical repository instructions for coding agents and contributors.
- `docs/PRODUCTION_OPERATIONS.md` — production deploy, verification, rollback, and incident runbook.
- `docs/deploy-provenance.md` — exact source-to-image-to-runtime provenance contract.
- `docs/ARCHITECTURE_DECISIONS.md` — durable architecture decisions that must not silently drift.
- `SECURITY.md` — secrets, authentication, change-control, and vulnerability rules.

## Intelligence stack

`packages/core/src/llm-client.ts` is the production source of truth for LLM routing.

APEX currently routes production inference through OpenRouter using the reviewed high-capability free-agent chain:

1. MiniMax M3 Free — primary long-horizon, coding, tool-use, and multimodal model
2. NVIDIA Nemotron 3 Ultra Free — reasoning, planning, orchestration, and coding fallback

Required credential: `OPENROUTER_API_KEY`.

`OPENROUTER_API_KEY_2` is optional credential redundancy and `OPENROUTER_API_KEY_3` is an optional separately named paid-fallback credential. Two keys on the same OpenRouter account do not create separate account balances or independent account-wide quota; the paid fallback uses the canonical `OPENROUTER_API_KEY` when it is funded.

The old Gemini/Groq/Cohere/Poolside/Qwen/Kilo/Mistral free-first production chain is retired unless an explicit architecture decision changes that policy.

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
- existing-service-only Cloud Run releases;
- cron governance (dynamic-job ceiling, frequency floor, governor pauses — never creates);
- a hard-gated approval set that no autonomy mode can ever auto-approve;
- fail-closed artifact/workspace tools when the bucket is unconfigured.

Do not remove safety controls merely to increase throughput.

## Durable execution

APEX can execute and ship deliverables durably even though the container filesystem is ephemeral:

- finished work (documents, builds, renders) goes to the GCS bucket named by `APEX_ARTIFACT_BUCKET` via `store_artifact`, with audit rows in the `artifacts` table and result links on tasks;
- durable project workspaces (`init_workspace` / `sync_workspace` / `push_workspace`) sync trees to `projects/<projectId>/workspace/<worktree>/` with checksum manifests;
- heavy tasks run in a separate Cloud Run Jobs sandbox (`run_executor_job`, dispatched when `APEX_EXECUTOR_JOB` is configured), and a deterministic classifier nudges agents toward it for test-suite/build/render/static-analysis/browser-automation/data-processing work instead of blocking a normal execution slot;
- code deliverables ship to new GitHub repos per workstream; hosted deliverables deploy through registered deploy hooks (`deploy_via_hook`);
- a managed `work_generation` cron plans deduplicated batches of work from goals, accepted opportunities, and workstreams; `cron_governor` keeps dynamic crons within ceilings and the 15-minute floor;
- a long task checkpoints and resumes across execution slices instead of losing progress at the 10-minute hard timeout, and a gated approval yields the execution cleanly (no live in-process wait) rather than blocking a concurrency slot while a human decides — see `docs/ARCHITECTURE_DECISIONS.md` (ADR-014);
- both the HTTP control plane and the dedicated `start:worker` runtime share one bootstrap routine, and every runtime reports a durable heartbeat so `/health` can tell a healthy web server apart from a healthy autonomous worker;
- `GET /api/autonomy` (admin-auth) reports whether APEX is actually doing useful unattended work: worker health, checkpoint/yield activity, executor jobs, retry backlog, approvals, and throughput.

See `docs/ARCHITECTURE_DECISIONS.md` (ADR-013, ADR-014) and `docs/PRODUCTION_OPERATIONS.md`.

## Repository layout

```text
packages/core/             agent runtime, LLM client, tools, memory, task queue
packages/agents/           production workforce definitions
packages/api-server/       REST/WebSocket control plane and health endpoint
packages/dashboard/        operator dashboard
packages/background-jobs/  scheduling and recurring work
packages/executor/         Cloud Run Jobs sandbox executor (heavy builds/renders)
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

## Production release gate

Before production deployment:

1. Start from current `main` with a clean tree.
2. Require green production CI.
3. Confirm the exact commit intended for release.
4. Use the configured Google Cloud project, region, and **existing** Cloud Run service. Never guess these identifiers and never create a substitute service.
5. Build an immutable image from the exact commit.
6. Update the existing Cloud Run service to that image.
7. Wait for the new revision to become Ready.
8. Verify `/health.build.sha` equals the released commit and `taskQueue.verdict` is healthy.
9. Smoke-test the changed production path.
10. Record anything that remains unverified.

A successful build is not a successful deployment. A Ready revision is not a successful deployment until production traffic is serving the intended SHA.

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
