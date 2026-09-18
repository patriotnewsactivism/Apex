# APEX — Autonomous AI Workforce

APEX is a persistent, hierarchical multi-agent operating system for running engineering and business work with real tools, approvals, memory, scheduling, health monitoring, and measurable follow-through.

This repository is the source for the APEX control plane and dashboard.

## Production: Railway

**APEX itself runs on Railway** — project `APEX`, service `apex-backend`.

Production URL: `https://apex.donmatthews.live`

Railway builds the repository `Dockerfile` (see `railway.toml`), health-checks `/health`, restarts on failure, and deploys itself from `main`. There is no deploy workflow in front of it, so **a push to `main` reaches production directly**.

Google Cloud Run is a retired APEX hosting path: billing is disabled on project `apex-503709`, so it serves nothing. AWS Lightsail/CodeBuild is retired and must not be restored. The React dashboard also has a Vercel project; Vercel, Render, and other platforms may appear in connectors or client-project tooling because APEX can manage software deployed elsewhere. None of them hosts the APEX control plane.

Do not redirect APEX production to another platform without an explicit operator instruction. `.github/workflows/deploy.yml` and `cloudbuild.apex.yaml` still describe the Cloud Run path — kept deliberately as the rollback route — and are gated behind the `APEX_DEPLOY_ENABLED` repository variable. Re-enabling them while GCP billing is disabled produces a failed deploy on every merge, not a deployment.

A release is not complete until `https://apex.donmatthews.live/health` reports the exact expected `build.sha` and a healthy task queue.

See:

- `AGENTS.md` — canonical repository instructions for coding agents and contributors.
- `docs/PRODUCTION_OPERATIONS.md` — production deploy, verification, rollback, and incident runbook.
- `docs/deploy-provenance.md` — exact source-to-image-to-runtime provenance contract.
- `docs/ARCHITECTURE_DECISIONS.md` — durable architecture decisions that must not silently drift.
- `SECURITY.md` — secrets, authentication, change-control, and vulnerability rules.

## Intelligence stack

`packages/core/src/llm-client.ts` is the production source of truth for LLM routing.

APEX currently routes production inference through OpenRouter using the zero-cost free-agent chain:

1. Nex N2.5 Mini Free (`nex-agi/nex-n2.5-mini:free`) — primary
2. Nex N2.5 Pro Free (`nex-agi/nex-n2.5-pro:free`)
3. NVIDIA Nemotron 3 Super Free
4. NVIDIA Nemotron 3.5 Lightning Free
5. OpenRouter Free Router (`openrouter/free`, tool requirements preserved)
6. NVIDIA Nemotron 3 Ultra Free (last resort)

If every free account/route is exhausted, APEX pauses. There is no automatic paid fallback.

Qualifying credentials: `OPENROUTER_FREE_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_API_KEY_2`, and optional `OPENROUTER_API_KEY_4`. `OPENROUTER_API_KEY_3` is burned and is not used. Three independent OpenRouter accounts are load-balanced by key fingerprint. Two keys on the same account do not create separate quota — `/health` `providerCredits.uniqueAccounts` is the check. Optional `OPENROUTER_MGMT_KEY*` values inventory those accounts; they cannot infer. See `docs/FREE_ONLY_MODEL_POLICY.md`.

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
