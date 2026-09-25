# APEX Runtime Contract

**Snapshot date:** 2026-09-24 (hosting correction; live state still requires direct verification)

This is a convenience reference for the `apex-autopilot` skill. It is not the canonical source of truth. Re-read the repository's current `AGENTS.md`, `docs/ARCHITECTURE_DECISIONS.md`, and live runtime before acting.

## Verified architecture snapshot

- Repository: `patriotnewsactivism/Apex`.
- APEX is a persistent hierarchical 13-agent workforce.
- Production hosting: **Railway** project `APEX`, service `apex-backend`, behind `https://apex.donmatthews.live` (ADR-015).
- Production image build: Railway builds the repository `Dockerfile` per `railway.toml`.
- Production release: `main` is gated by GitHub Actions `production-checks` plus Railway Wait for CI; verify the exact live SHA after Railway reports success.
- A push/merge to `main` alone does not prove a live deployment.
- `/health` exposes the build commit (`build.sha`), uptime, task-queue liveness, and aggregate LLM-capacity state; repeated dequeue failures can make health fail.
- Database: Postgres through `DATABASE_URL` using Drizzle. A runtime DB credential is not blanket Supabase/project-management authorization.
- Package manager: pnpm; runtime/tooling target Node.js 22; ESM/TypeScript.
- Production inference routes through OpenRouter. Inspect `packages/core/src/llm-client.ts` rather than relying on a historical provider snapshot.
- Approval is per tool. Production deployment/rollback, protected git writes, schema/destructive database changes, outbound calls/messages, financial effects, and other high-impact actions remain gated.
- Escalations and approvals are distinct concepts. An escalation is not consent.
- AWS Lightsail/CodeBuild is retired. Google Cloud Run is a retired, billing-disabled migration-back path only; it is not the ordinary production release path.

## Production deployment truth test

For a claimed production release, require all applicable proof:

1. Intended reviewed commit identified.
2. CI is green for the intended release state.
3. GitHub Actions `production-checks` is green and Railway Wait for CI accepts the commit.
4. Railway reports a successful deployment of `apex-backend` for the intended commit.
5. Public `https://apex.donmatthews.live/health` returns the intended `build.sha` and healthy queue state.
6. The changed behavior passes a live smoke test.

Without steps 5-6, report **deployment not yet proven live**.

## Existing-service-only rule

The exact Railway project and service must come from trusted production configuration or direct Railway evidence. Never infer them from the domain/repository name and never substitute a different target because access is missing.

Ordinary releases use Railway `apex-backend`. The retained Cloud Run deployer is an emergency migration-back mechanism only and remains gated by `APEX_DEPLOY_ENABLED`; do not use it as the normal release path or as evidence that Railway production changed.

## Current risk patterns to remember

### Stale-image false debugging

A source fix can exist while production still runs an older image. Compare public `/health.build.sha` early.

### Provider-capacity false diagnosis

"All providers failed" can be caused by missing credentials, provider cooldowns, token/spend limits, auth/payment/rate-limit errors, model availability, or tool-compatibility behavior. Inspect the current OpenRouter roster, token diagnostics, and actual provider errors before changing routing.

### Approval backlog noise

Repeated escalations can obscure genuinely gated approvals. Filter by approval kind and surface distinct blockers.

### Dead-code confusion

Do not assume every specialist definition is instantiated in the real workforce. Verify the actual orchestrator/agent-construction path before delegating or reporting agent counts.

### Infrastructure-memory drift

Old repository history may describe Railway as retired, or mention Lightsail, CodeBuild, prior model chains, and abandoned migrations. Historical evidence is useful for diagnosis but does not override current `AGENTS.md`, architecture decisions, current source, or direct production evidence.

## Canonical files to inspect first

- `AGENTS.md`
- `README.md`
- `docs/ARCHITECTURE_DECISIONS.md`
- `docs/PRODUCTION_OPERATIONS.md`
- `docs/deploy-provenance.md`
- `packages/core/src/llm-client.ts`
- `packages/core/src/token-ledger.ts`
- `packages/core/src/tool-registry.ts`
- `packages/api-server/src/routes/health.ts`
- `packages/api-server/src/routes/agents.ts`
- `packages/api-server/src/routes/approvals.ts`
- `railway.toml`
- `Dockerfile`
- `packages/cicd-automation/src/cloud-run-deployer.ts` (retired migration-back path only)

Add other files only as the specific incident requires.
