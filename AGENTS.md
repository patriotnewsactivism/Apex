# Repository Guidelines — Apex
_Last verified against source/CI and current provider docs: 2026-08-23._

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

## LLM intelligence policy — free first, paid fail-closed

`packages/core/src/llm-client.ts` is the source of truth. **Every APEX unit uses
one economics-first route.** There is no manager-vs-worker provider split.

Use this exact order:

1. **Google Gemini** — `gemini-3.7-flash`
   - first choice for every agent;
   - only dedicated `GEMINI_FREE_API_KEY` / `_2` credentials are accepted;
   - those credentials must belong to genuinely free-tier Google projects;
   - do not substitute a billing-enabled `GEMINI_API_KEY`.
2. **Groq** — `openai/gpt-oss-120b`
   - second choice for every agent;
   - Groq currently publishes Free-plan limits of 30 RPM, 1,000 RPD and
     200,000 TPD for GPT-OSS 120B;
   - use only dedicated `GROQ_FREE_API_KEY` credentials from a genuinely free
     Groq project/account;
   - `GROQ_FREE_TIER_CONFIRMED=true` is required before APEX will call it;
   - if the Groq account is upgraded to a paid Developer plan, turn this gate
     off before using that key because paid Groq is metered from usage.
3. **Cohere** — `command-a-plus-05-2026`
   - third choice;
   - Cohere currently states Command A+ is free until its applicable API rate
     limit is reached.
4. **Poolside** — `poolside/laguna-s-2.1`
   - fourth choice;
   - Poolside currently advertises limited-time free access;
   - APEX requires `POOLSIDE_FREE_ACCESS_CONFIRMED=true` so a stale config
     cannot silently assume a temporary promotion is permanent.
5. **Qwen** — `qwen3.7-max`
   - fifth choice;
   - Alibaba Model Studio can automatically become PAYG after a free quota;
   - provider-side **Free quota only** must be enabled first, then
     `QWEN_FREE_QUOTA_ONLY=true` confirms that protection to APEX.
6. **Kilo Code** — `kilo-auto/free`
   - sixth choice;
   - use Kilo Auto **Free**, never `kilo-auto/frontier`, for autonomous default
     routing.
7. **Mistral** — `mistral-medium-3-5`
   - absolute last emergency fallback;
   - it is a paid rung;
   - it is unreachable while `APEX_PAID_LLM_MODE=off`, even if
     `MISTRAL_API_KEY` exists.

### Gemini quota facts

Do **not** hard-code “1,500 requests/day” for Gemini 3.7 Flash. Google confirms
Gemini 3.7 Flash has free input/output tokens on the Free tier, but current
RPM/TPM/RPD limits are project/model specific and must be read from the AI
Studio Rate Limit page. Treat a provider 429/quota response as authoritative
and fall through to Groq rather than assuming a stale numeric quota.

### Groq quota facts

Groq's current Free-plan table for `openai/gpt-oss-120b` lists 30 RPM,
1,000 RPD, 8,000 TPM and 200,000 TPD. Treat provider responses as authoritative
if those limits change. The `.env.example` sets `APEX_TOKEN_CAPS=groq:200000`
as a proactive mirror of the current published daily free token ceiling, but
that token cap is not proof that a billing-enabled Groq account is free.

### Provider configuration

Inference-related runtime variables:

- `GEMINI_FREE_API_KEY`
- `GEMINI_FREE_API_KEY_2` (optional second genuinely-free project)
- `GROQ_FREE_API_KEY`
- `GROQ_FREE_TIER_CONFIRMED`
- `COHERE_API_KEY`
- `POOLSIDE_API_KEY`
- `POOLSIDE_FREE_ACCESS_CONFIRMED`
- `QWEN_API_KEY`
- `QWEN_BASE_URL` (optional; Singapore shared compatible endpoint is the
  fallback, workspace-specific URL preferred)
- `QWEN_FREE_QUOTA_ONLY`
- `KILO_API_KEY`
- `MISTRAL_API_KEY`
- `APEX_PAID_LLM_MODE` (default `off`)

Do not restore OpenRouter, Cerebras, SambaNova, Hugging Face, NVIDIA, or other
removed paid/legacy inference fallback providers unless the user explicitly
changes the policy after verifying current cost/quality. Embeddings are local
MiniLM only, so they cannot create a hidden paid inference path.

Model IDs are pinned in reviewed source. Stale `APEX_MODEL` or
`APEX_MODEL_<ROLE>` environment values must not override this policy.

### Routing behavior

- Preserve the exact free-first order above; do not round-robin starting
  providers.
- Multiple free Gemini keys are credentials for one logical Gemini rung. A
  rate-limited key can fall through to the second configured free key before
  leaving Gemini.
- Groq, Poolside and Qwen activation confirmations are deliberate economic
  gates.
- Mistral is a paid emergency gate, not normal capacity.
- Preserve structured tool calling. A provider response that merely describes
  a tool call is not successful execution.
- Preserve provider failure diagnostics and record the actual serving
  `provider/model`.
- Preserve request-history trimming without deleting tool-call/result message
  skeletons.

`scripts/verify-provider-routing.ts` is the deterministic guard. It must fail if
the provider/model order drifts, if Groq stops being the second free rung, if
Kilo changes away from Auto Free, or if Mistral stops being the only paid and
final rung.

## Token and spend governor

`packages/core/src/token-ledger.ts` records real prompt + completion usage by UTC
day and persists it to Postgres with a local-file fallback. A container restart
must not reset the day's accounting.

**Token capacity is not a spending allowance.** The old 33M/day Mistral target
was removed because it confused a rate-limit ceiling with free usage.

Current `.env.example` defaults:

- `APEX_TOKEN_CAP_TOTAL=0`
- `APEX_TOKEN_CAPS=groq:200000`
- `APEX_PAID_LLM_MODE=off`

Provider-side free quota controls and fail-closed paid routing are the primary
cost controls. APEX-side token caps are optional secondary operational limits,
not an attempt to estimate dollar spend.

`GET /api/tokens` remains the operational view of measured token usage.

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