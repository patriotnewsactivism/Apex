# Repository Guidelines — Apex
_Last verified against source/CI: 2026-08-23._

This is the single canonical instruction file for AI coding tools working in
this repository. Keep it current. Do not recreate per-tool copies that can
drift out of sync.

## Current production runtime

APEX itself runs on **AWS Lightsail container service `apex-service`**. Railway
was retired for APEX on 2026-08-16. Railway and Vercel can still appear as
client-project deployment targets or in historical documentation; neither is
the APEX production host.

The production image is built by CodeBuild project `apex-lightsail-build` and
stored in ECR. Pushing or merging to `main` does **not** prove a release is
running. A production release is complete only after all of these are true:

1. the intended commit is on `main`;
2. CodeBuild succeeds and pushes the image;
3. Lightsail creates and activates a deployment for `apex-service`;
4. the real `/health` endpoint reports the expected `build.sha` and healthy
   task-queue state;
5. the changed feature is smoke-tested through its real production path.

`deploy_to_environment` and `rollback_deployment` implement the Lightsail flow
in `packages/cicd-automation/src/lightsail-deployer.ts`. Both remain
approval-gated. `APEX_DEPLOY_ENABLED` is explicit consent to target an
environment; credentials alone are never consent to ship. Use scoped AWS IAM
credentials, never root keys.

## What APEX is

APEX is a persistent hierarchical autonomous workforce, not a request/response
serverless app.

```text
APEX CEO
├── CTO -> Lead Developer -> Frontend / Backend / DevOps / QA
└── COO -> Lead Researcher / Sales / Marketing / Customer Success
QA Director -- independent quality/oversight role
```

The production workforce is 13 agents. A generic Research/Documentation/
Operations trio exists in `packages/agents/src/specialists.ts` but is not part
of the instantiated production org unless that changes explicitly.

## Stack and conventions

- Package manager: **pnpm** workspace. Do not introduce npm/bun lockfiles.
- TypeScript strict mode; ESM via `tsx`. Use `import`, not CommonJS `require()`.
- Postgres/Supabase through Drizzle ORM and `DATABASE_URL`.
- Schema bootstrap is idempotent at startup through `lib/db/src/client.ts`.
- The old SQLite runtime and retired Railway Postgres are not production data
  stores and must not be revived.
- `packages/convex-backend` is experimental/unfinished and production Convex
  autonomy remains disabled unless `APEX_CONVEX_AUTONOMY_ENABLED=true` is an
  intentional architecture change.

## LLM intelligence policy — 2026-08-23

`packages/core/src/llm-client.ts` is the source of truth. APEX has an **exact
five-provider inference allowlist**. Do not add a sixth provider, dynamic
router, hidden rescue path, legacy paid anchor, or provider-specific side door.

### Worker and specialist units

Use this exact order:

1. **Mistral** — `mistral-medium-3-5`
2. **Google Gemini** — `gemini-3.7-flash`
3. **Cohere** — `command-a-plus-05-2026`
4. **Qwen** — `qwen3.7-max`
5. **Kilo Code** — `kilo-auto/frontier`

### Manager and executive oversight

CEO, CTO, COO, Lead Developer, Lead Researcher, and QA Director use Gemini for
primary oversight/delegation reasoning, then the same remaining stack:

1. **Google Gemini** — `gemini-3.7-flash`
2. **Mistral** — `mistral-medium-3-5`
3. **Cohere** — `command-a-plus-05-2026`
4. **Qwen** — `qwen3.7-max`
5. **Kilo Code** — `kilo-auto/frontier`

Gemini's two project keys are two credentials for one logical provider rung;
they are not two separate providers. Cohere stays behind Mistral/Gemini unless
APEX-specific evaluation data demonstrates a task/role where it is materially
better and the routing policy is deliberately revised.

### Provider configuration

Only these inference variables belong to the active LLM stack:

- `MISTRAL_API_KEY`
- `GEMINI_API_KEY`
- `GEMINI_API_KEY_2` (optional second project)
- `COHERE_API_KEY`
- `QWEN_API_KEY`
- `QWEN_BASE_URL` (required because Model Studio compatible URLs are
  workspace/region specific)
- `KILO_API_KEY`

Do not restore Groq, OpenRouter, Cerebras, SambaNova, Hugging Face, NVIDIA, or
OpenAI as inference fallback providers. Embeddings use Mistral when configured
and otherwise fall back to the local MiniLM pipeline; do not create a hidden
sixth remote model path through embeddings.

Model IDs are pinned in reviewed source. Stale `APEX_MODEL` or
`APEX_MODEL_<ROLE>` environment values must not override this allowlist.

### Routing behavior

- Preserve the exact order above; do not round-robin starting providers.
- Use per-credential cooldowns so a rate-limited Gemini project key can fall
  through to the other configured Gemini key before leaving the Gemini rung.
- Preserve structured tool calling. A provider response that merely describes
  a tool call is not successful execution.
- Preserve provider failure diagnostics and record the actual serving
  `provider/model` so the dashboard does not report the configured primary when
  a fallback served the call.
- Preserve request-history trimming without deleting tool-call/result message
  skeletons; orphaned tool results make compatible APIs reject the request.

`scripts/verify-provider-routing.ts` is the deterministic guard. It must fail if
any provider/model or manager/worker order drifts from this policy.

## Token and spend governor

`packages/core/src/token-ledger.ts` records real prompt + completion usage by UTC
day and persists it to Postgres with a local-file fallback. A container restart
must not reset the day's accounting.

Current operating target in `.env.example`:

- `APEX_TOKEN_CAP_TOTAL=40000000` — workspace runaway backstop.
- `APEX_TOKEN_CAPS=mistral:33000000` — requested Mistral daily ceiling.

The 33M figure is an APEX account/operating target, not a statement that the
usage is free. Provider billing and account limits remain authoritative. Do not
invent token caps for Gemini, Cohere, Qwen, or Kilo; add them only when the real
account limit or budget is known.

`GET /api/tokens` is the operational view of today's measured spend. If a
configured total cap is lower than the intended Mistral allowance, fix the
configuration rather than diagnosing the resulting pause as a provider outage.

Process-wide LLM concurrency defaults to 3 via
`APEX_MAX_CONCURRENT_LLM_CALLS`; change it from measured throughput/rate-limit
evidence, not intuition.

## Approval and security rules

- All `/api/*` routes except `/api/auth/login` and `/health` must remain behind
  `requireAdminAuth`.
- Secrets are referenced by environment-variable name only in logs, reports,
  commits, and PR descriptions. Never log secret values.
- Human approval is per tool. Do not create a global bypass.
- Production deployment/rollback, protected remote writes, outbound calls,
  externally sent communications, financial actions, and other irreversible
  effects remain approval-gated unless the user explicitly changes governance.
- `runShell` remains approval-gated. `writeFile`, sandbox execution, and local/
  feature-branch work can remain automatically allowed where currently safe.
- Escalations are notifications, not approvals. Do not treat an acknowledged
  escalation as authorization for a gated tool call.
- GitHub engineering work lands through feature branches/PRs, not direct pushes
  to `main`.

## Verification sequence

For any real code fix or feature, do not report success from source inspection
alone. Use this order:

1. Start from current origin/main; never assume an old checkout is current.
2. Run `pnpm run typecheck` and verify every expected production package is
   actually included.
3. Run the deterministic guards relevant to the change. LLM work must include
   `scripts/verify-provider-routing.ts` and `verify-llm-diagnostics.ts` when
   applicable.
4. Run `pnpm run build`; for the dashboard, confirm real `dist/index.html` and
   JS/CSS output rather than trusting only exit code 0.
5. Commit honestly on a feature branch and open/update a PR.
6. Require green CI before merge unless the user explicitly accepts a known
   failure.
7. If production behavior is part of the task, deploy through the approved
   Lightsail path and verify the real `/health` `build.sha`.
8. Smoke-test the actual changed feature against production.
9. Update living status documentation with what was verified and what was not.

A successful build is not a successful deployment. A successful deployment is
not a successful feature until the real behavior is verified.

## Context-budget rules

`packages/core/src/context-budget.ts` bounds what each iterative task re-sends.
Tool results can become expensive because the whole history is re-sent on every
agent iteration.

Key controls:

| Env var | Default | Effect |
| --- | ---: | --- |
| `APEX_MAX_TOOL_RESULT_CHARS` | `8000` | Truncates one tool result while preserving useful head/tail context. |
| `APEX_MAX_HISTORY_TOKENS` | `60000` | Elides old tool-result content until history fits. |

Do not optimize context by deleting arbitrary messages. Assistant `tool_calls`
and matching `tool` messages must stay structurally paired. Preserve the system
prompt, original task, and recent turns.

## Other source-of-truth documents

- `BUSINESS_PROFILE.md` — BuildMyBot product/pricing/ICP ground truth.
- `APEX_CHARTER.md` — mission/governance; historical infrastructure/model notes
  in it do not override this file or live source.
- `APEX_INTEGRATION.md` — BuildMyBot workforce integration behavior.
- `PLAN.md`, `ROADMAP.md`, `CHECKLIST.md` — living status/planning documents.
- `docs/deploy-provenance.md` — proof that the intended commit is the one live.

When documentation conflicts with live runtime evidence, state the conflict and
prefer the most direct current evidence. Then update the stale documentation so
the contradiction does not survive the task.
