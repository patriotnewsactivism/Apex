# APEX Runtime Contract

**Snapshot date:** 2026-08-23

This is a convenience reference for the `apex-autopilot` skill. It is not the canonical source of truth. Re-read the repository's current `AGENTS.md` and live runtime before acting.

## Verified architecture snapshot

- Repository: `patriotnewsactivism/Apex`
- APEX is a persistent hierarchical 13-agent workforce.
- Production hosting: AWS Lightsail container service `apex-service`.
- Build path: AWS CodeBuild project `apex-lightsail-build` produces/pushes the runtime image.
- A push/merge to `main` alone does not prove a live deployment.
- `/health` exposes the build commit (`build.sha`), uptime, and task-queue liveness and can return 503 for repeated dequeue failures.
- Database: Postgres/Supabase through `DATABASE_URL` using Drizzle.
- Package manager: `pnpm`; ESM/TypeScript.
- The current provider chain and token caps are implementation details that change; inspect `packages/core/src/llm-client.ts`, token-ledger code, and `/api/tokens` rather than hard-coding historical provider assumptions.
- Approval is per tool. Production deployment/rollback, protected git writes, outbound calls, and other high-impact actions remain gated.
- Escalations and approvals are distinct concepts. An escalation is not consent.

## Production deployment truth test

For a claimed production release, require all applicable proof:

1. Intended commit identified.
2. CodeBuild succeeded for the intended source.
3. Lightsail created/activated the intended deployment.
4. Live `/health` returns the intended `build.sha`.
5. The changed behavior passes a live smoke test.

Without steps 4-5, report "deployment not yet proven live."

## Current risk patterns to remember

### Stale-image false debugging

A source fix can exist while production still runs an older image. Always compare `build.sha` early.

### Provider-capacity false diagnosis

"All providers failed" can be caused by missing keys, provider cooldowns, per-provider caps, total workspace caps, auth/payment/rate-limit errors, or routing/tool-compatibility behavior. Inspect the roster and token diagnostics first.

### Approval backlog noise

Repeated escalations can obscure genuinely gated approvals. Filter by approval kind and surface distinct blockers.

### Dead-code confusion

Do not assume every specialist definition is instantiated in the real workforce. Verify the actual orchestrator/agent construction path before delegating or reporting agent counts.

## Canonical files to inspect first

- `AGENTS.md`
- `packages/core/src/llm-client.ts`
- `packages/core/src/token-ledger.ts`
- `packages/core/src/tool-registry.ts`
- `packages/api-server/src/routes/health.ts`
- `packages/api-server/src/routes/agents.ts`
- `packages/api-server/src/routes/approvals.ts`
- `packages/cicd-automation/src/lightsail-deployer.ts`
- `docs/deploy-provenance.md`

Add other files only as the specific incident requires.
