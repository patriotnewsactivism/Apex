# QWEN.md — Apex Repository Context

## Project Overview

**Apex** is a persistent, hierarchical **13-agent autonomous AI workforce**
deployed as an always-on Node process on Railway
(`apex-production-731c.up.railway.app` / `apex.donmatthews.live`). It is NOT
a request/response serverless app — it runs continuously, polling health,
executing background jobs, and serving a live dashboard + API.

```
APEX CEO (Tier 0)
├── CTO (Tier 1) → Lead Developer (Tier 2) → Frontend/Backend/DevOps/QA (Tier 3)
└── COO (Tier 1) → Lead Researcher / Sales / Marketing / Customer Success (Tier 3)
QA Director — 13th agent, sits outside the two branches
```

> **Note:** A generic Research/Documentation/Operations trio exists in
> `packages/agents/src/specialists.ts` but is **never instantiated** — dead
> code. Do not delegate to it or treat it as part of the real org chart.

**Mission:** Run BuildMyBot.App's day-to-day operations (engineering, sales,
support, content, infrastructure) toward self-sustainment so Don Matthews can
focus on CaseBuddy. Governed by `APEX_CHARTER.md`.

## Stack & Architecture

| Layer | Technology |
|---|---|
| Package manager | **pnpm** workspace (`pnpm-workspace.yaml`). Never introduce npm/bun lockfiles. |
| Module system | **ESM via `tsx`** — use `import`, never `require()`. |
| Language | TypeScript strict mode throughout (`tsconfig.base.json`). |
| Runtime | Node 20 (Alpine in Docker). |
| API server | Express 5 + WebSocket (`ws`), entry: `packages/api-server/src/index.ts`. |
| Dashboard | React 19 + Vite + Tailwind CSS 4 + TanStack Query + wouter. |
| Database | Drizzle ORM over SQLite (`DATABASE_PATH=.local/apex.db`). Schema: `lib/db/src/schema.ts`. |
| LLM | Multi-provider fallback chain in `packages/core/src/llm-client.ts` (verified live 2026-07-31): Cerebras(×3) → Groq(×2) → Google Gemini(×2) → DeepSeek → NVIDIA NIM → Together AI → Qwen Cloud → GLM-Aliyun → Mistral → Qwen Cloud (Anthropic protocol) → GLM-Z.ai → Poolside → Cohere (`toolCallingReliable:false`) → OpenRouter-free ×2 (`toolCallingReliable:false`). OpenRouter is the **last-resort free tier, not the primary**. NOT a single-provider setup. Duplicate-key slots (`CEREBRAS_API_KEY_2/3`, `GROQ_API_KEY_2`, `GEMINI_API_KEY_2`) multiply free-tier rate limits. |
| Deployment | Multi-stage Dockerfile → Railway (docker builder, `railway.toml`). |

### Workspace packages (13 directories)

| Package | Purpose |
|---|---|
| `packages/core` | Base agent, LLM client, tool registry, task queue, vector memory, BuildMyBot connector. |
| `packages/agents` | Workforce creation, agent definitions, org chart. |
| `packages/api-server` | Express API + WebSocket server (the main entrypoint). |
| `packages/dashboard` | React SPA (built to `dist/`, served statically). |
| `packages/health-monitor` | HealthMonitor + AlertManager (Phase 1). |
| `packages/background-jobs` | Cron parser, job scheduler/executor, job handlers (Phase 1). |
| `packages/learning-system` | Outcome analysis, pattern detection, insights, strategy optimization (Phase 2). |
| `packages/cicd-automation` | Test/lint/build runners, DeploymentManager, isolated CI workspace (Phase 3). |
| `packages/multiapp` | ApplicationManager, OrchestrationEngine, KnowledgeBridge (Phase 4). |
| `packages/predictive` | Forecaster, RiskDetector (Phase 4). |
| `packages/buildmybot-ops` | BuildMyBot operational tooling. |
| `packages/orchestrator` | Orchestration utilities. |
| `packages/frontend` | Frontend utilities. |
| `lib/db` | Drizzle schema, migrations, DB client (`@workspace/db`). |

## Building & Running

```bash
# Install dependencies
pnpm install

# Typecheck ALL packages (must show every package "Done", zero errors)
pnpm run typecheck
# ⚠️ As of 2026-07-28 this does NOT pass end-to-end, for reasons predating any
# current work: `packages/convex-backend` fails (its subagent-written
# convex/toolRegistry.ts was never codegen'd — apexplan.md documents it as
# UNVERIFIED), and `packages/dashboard` fails because it imports
# `@workspace/convex-backend/api`, which that package never emits. Both fail
# identically on a clean checkout. Verify a change by typechecking the packages
# it touches until the in-flight Convex migration is finished or reverted.

# Build (typecheck + per-package builds; dashboard emits dist/index.html + bundles)
pnpm run build

# Run API server in dev mode (watch)
pnpm run dev:api

# Run dashboard in dev mode
pnpm run dev:dashboard

# Run both concurrently
pnpm run dev

# Production start (what Railway runs)
pnpm --filter @workspace/api-server run start
```

**Environment:** Copy `.env.example` → `.env`. At least one LLM provider key
makes the system functional — practical primaries are `CEREBRAS_API_KEY`
and `GROQ_API_KEY`; `OPENROUTER_API_KEY` is the last-resort free tier, not
the primary. Other provider keys: `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`,
`NVIDIA_API_KEY`, `TOGETHER_API_KEY`, `QWENCLOUD_API_KEY`, `MISTRAL_API_KEY`,
`COHERE_API_KEY`. Duplicate-key slots (`CEREBRAS_API_KEY_2/3`,
`GROQ_API_KEY_2`, `GEMINI_API_KEY_2`) multiply free-tier rate limits. Server
listens on `PORT` (default 5000).

## Development Conventions

- **ESM only.** Use `import`/`export`. Never `require()`.
- **pnpm only.** Never introduce npm or bun lockfiles.
- **TypeScript strict mode.** All packages must typecheck cleanly.
- **Workspace protocol.** Internal deps use `workspace:*`.
- **Catalog versions.** Shared dependency versions are pinned in
  `pnpm-workspace.yaml` under `catalog:` — reference them as `"catalog:"`
  in package.json rather than hardcoding versions.
- **Supply-chain defense.** `minimumReleaseAge: 1440` in `.npmrc` — do NOT
  disable or set to 0.
- **No test framework is configured.** There is no `pnpm test` script.
  Verification is done via typecheck, build, and live functional smoke tests.

## Security — Non-Negotiable

1. **Auth on all API routes.** Everything under `/api/*` except
   `/api/auth/login` and `/health` requires `Authorization: Bearer <token>`
   via `requireAdminAuth`. `/api/auth/login` exchanges `APEX_ADMIN_PASSWORD`
   for a token. Never add routes outside this middleware stack. This was a
   real, live open exposure until 2026-07-12 — never regress it.
2. **Per-tool approval gating.** 13 tools require human approval
   system-wide (verified live 2026-07-31 against `requiresApproval: true` in
   the tool definitions): `runShell`, `deploy_to_environment`,
   `rollback_deployment`, `push_to_remote`, `create_pull_request`,
   `register_application`, `delegate_to_application`, `make_outbound_call`,
   `buildmybot_send_briefing`, `buildmybot_run_workforce`,
   `buildmybot_resolve_error`, `buildmybot_deploy`, `casebuddy_deploy_firm`.
   `writeFile` (2026-07-19), `runInSandbox`, and `create_feature_branch`
   (2026-07-22) were all flipped to auto-approved — git-reversible / local
   only. Never remove gating from `runShell` or production/deploy/PR/push/
   outbound-call actions without Don's explicit sign-off.
3. **Secrets by name only.** Never log, report, or commit secret values.
   Reference them by name (e.g., "OPENROUTER_API_KEY") only.
4. **GitHub writes** use `GITHUB_TOKEN_4`. No GITHUB_TOKEN env var currently
   exists on the live Railway service — in-app `create_feature_branch`/
   `create_pull_request` tools will fail if invoked. This is a known gap,
   not a bug to "fix" by hardcoding a token into prod.
5. **No production DB schema changes** without explicit sign-off from Don,
   logged and timestamped.
6. **APEX_APPROVAL_MODE** must never be globally `"off"` for irreversible
   categories. Allowed values: `"strict"` (default) or `"normal"`.

## The Verification Sequence (Verified 2026-07-20)

Every real fix in this repo has followed this exact order. Skipping steps is
what let false "100% complete" claims get written while `packages/core` was
actually broken:

1. **`git clone`/`git pull`** — always start from a fresh sync.
2. **`pnpm run typecheck`** — all 12 packages must show `Done` with zero
   errors. If any package is silently skipped, that's a false pass.
3. **`pnpm run build`** — confirm dashboard actually emits `dist/index.html`
   + JS/CSS bundles. Don't just trust exit code 0.
4. **Commit + push** with `GITHUB_TOKEN_4`, honest commit message (root
   cause, what was tried, what was verified — not just "fixed bug").
5. **Wait ~60–70s**, then poll Railway's GraphQL deployments API
   (`backboard.railway.app/graphql/v2`) for `status: SUCCESS` on the new
   commit hash. Direct curls to `*.up.railway.app` reliably fail from TLS
   timeouts in the sandbox.
6. **Functionally smoke-test the actual feature live** — hit the real API
   route/tool with a real admin token and confirm real data comes back.
   Compiling and deploying are necessary but NOT sufficient.
7. **Update `CHECKLIST.md`/`ROADMAP.md`/`PLAN.md`** with what was verified
   vs. what wasn't, before considering the task done.

## Known Status (as of 2026-07-20)

| Area | Status |
|---|---|
| Phase 1 — Health monitoring | ✅ Functionally verified live (`/api/health` returns real data). |
| Phase 1 — Background jobs | ⚠️ Built + typechecks. NOT functionally tested live. |
| Phase 2 — Learning system | ⚠️ Built + typechecks. NOT functionally tested live. |
| Phase 3 — CI/CD test+build | ✅ Functionally verified live (9/9 typecheck, real vite build). |
| Phase 3 — Deploy/rollback trigger | ⚠️ Higher risk — needs Don present (No Unilateral Actions). |
| Phase 4 — Multiapp / Predictive | ⚠️ Built + typechecks. NOT functionally tested live. |

## Autonomy model (updated 2026-07-28)

Delegation is a **closed loop**, not a one-way broadcast. Understand this before
changing anything in `background-jobs` or `base-agent.ts`:

1. Work originates from cron, not only from a human `POST /api/goals`. The
   standing roster is seeded idempotently in `seedDefaultJobs`
   (`packages/api-server/src/index.ts`) and is runtime-editable by the CEO via
   `schedule_task`/`cancel_scheduled_task` — the jobs table is the source of
   truth, not that array.
2. When work is delegated, `DelegationFollowupJob` routes the **real outcomes**
   (results and error text) back to the delegator once every sibling under that
   parent is terminal. The synthesis task is a root task, so the loop converges.
3. Goals only leave `active` via the `update_goal_status` tool — nothing closes
   them automatically. `GoalProgressJob` drives each active goal toward that
   decision; `update_goal_status` refuses to complete a goal with open tasks or
   without a `result`.
4. Failures cluster into a CEO triage task via `FailureReviewJob` instead of
   dying silently at `status = 'failed'`.
5. COO and CTO have their own `BranchReviewJob` heartbeats, so autonomy is not
   bottlenecked on the CEO's review cycle.
6. Every agent gets one **self-review turn** before a no-tool-call answer is
   accepted as done (`APEX_SELF_REVIEW=0` disables it).

Two invariants to preserve: every autonomous handler is **idempotent** (it must
never stack a second review on an agent that hasn't worked the last one), and
irreversible actions stay approval-gated regardless of who originated the task.

Re-verify with (destructive — scratch DB only, never production):
`DATABASE_URL=... pnpm --filter @workspace/api-server exec tsx ../../scripts/verify-autonomy-loop.ts`
and `.../verify-autonomy-scheduler.ts`.

## Key Documentation Files

| File | Purpose |
|---|---|
| `AGENTS.md` | **Canonical instructions** for any AI coding tool. Keep this current. |
| `APEX_CHARTER.md` | Governance/mission charter (non-negotiable rules, phased roadmap). |
| `APEX_INTEGRATION.md` | How Apex commands/reads BuildMyBot's AI workforce. |
| `BUSINESS_PROFILE.md` | BuildMyBot.app ground truth (pricing, ICP, what's real vs. marketed). |
| `CHECKLIST.md` | Master implementation checklist with honest status notes. |
| `ROADMAP.md` | Full technical roadmap. |
| `PLAN.md` | Living plan document, updated as work happens. |

Check `CHECKLIST.md`, `ROADMAP.md`, and `PLAN.md` first for current state
before starting any work.
