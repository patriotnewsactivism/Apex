# QWEN.md — Apex Repository Context
_Last re-verified against live system + code: 2026-08-04._

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
| Database | **Postgres (Supabase)** via Drizzle ORM + `postgres` driver (`lib/db/src/client.ts`). Connection string in `DATABASE_URL` (local default `postgres://postgres:postgres@localhost:5432/apex`). Schema is bootstrapped **idempotently at startup** — no separate migration step. The old SQLite setup (`DATABASE_PATH=.local/apex.db`) is dead; ignore stale references. |
| LLM | Multi-provider fallback chain in `packages/core/src/llm-client.ts` — see **LLM Chain Operations** below. |
| Deployment | Multi-stage Dockerfile → Railway (docker builder, `railway.toml`; healthcheck `/health`, restart ON_FAILURE ×10). The runtime image `COPY *.md ./` so agent workspace docs (BUSINESS_PROFILE.md etc.) exist at `/app` — keep that line in sync when adding root docs. |

### Workspace packages (16 directories under `packages/` + `lib/db`)

| Package | Purpose |
|---|---|
| `packages/core` | Base agent, LLM client, tool registry (70 tools), task queue, vector memory, BuildMyBot/CaseBuddy connectors. |
| `packages/agents` | Workforce creation, agent definitions, org chart, role-specialized prompts. |
| `packages/api-server` | Express API + WebSocket server (the main entrypoint) + Vapi webhook route (Stripe checkout during sales calls). |
| `packages/dashboard` | React SPA (built to `dist/`, served statically). ⚠️ Also imports `@workspace/convex-backend/api` (see below). |
| `packages/health-monitor` | HealthMonitor + AlertManager (Phase 1). |
| `packages/background-jobs` | Cron parser, job scheduler/executor, job handlers (Phase 1) incl. PromptSelfImproveJob. |
| `packages/learning-system` | Outcome analysis, pattern detection, insights, strategy optimization (Phase 2). |
| `packages/cicd-automation` | Test/lint/build runners, DeploymentManager, isolated CI workspace (Phase 3). |
| `packages/cicd-worker` | Standalone CI worker (`@workspace/apex-cicd-worker`) built on the Convex backend; depends on `@workspace/convex-backend`. |
| `packages/multiapp` | ApplicationManager, OrchestrationEngine, KnowledgeBridge (Phase 4). |
| `packages/predictive` | Forecaster, RiskDetector (Phase 4). |
| `packages/buildmybot-ops` | BuildMyBot operational tooling. |
| `packages/orchestrator` | Orchestration utilities. |
| `packages/cli` | `@apex/cli` — installable-Apex bootstrap (`apex-install`) for the installable-OS initiative. |
| `packages/convex-backend` | ⚠️ In-flight Convex migration — does NOT typecheck (subagent-written `convex/toolRegistry.ts` was never codegen'd; `apexplan.md` documents it as UNVERIFIED). `dashboard` and `cicd-worker` depend on it, so their typechecks fail too until this is finished or reverted. |
| `packages/frontend` | NOT a package — stray `src/` with no package.json; excluded from the Docker build deliberately. Dead-code candidate. |
| `lib/db` | Drizzle schema + idempotent bootstrap DDL + DB client (`@workspace/db`). |

## Building & Running

```bash
# Install dependencies
pnpm install

# Typecheck ALL packages (must show every package "Done", zero errors)
pnpm run typecheck
# ⚠️ Does NOT pass end-to-end for reasons predating current work:
# packages/convex-backend fails (never codegen'd), and packages/dashboard
# and packages/cicd-worker fail because they depend on it. All fail
# identically on a clean checkout. Verify a change by typechecking the
# packages it touches (e.g. `pnpm --filter @workspace/core run typecheck`)
# until the Convex migration is finished or reverted.

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
makes the system functional — practical primaries are `CEREBRAS_API_KEY` and
`GROQ_API_KEY`; `OPENROUTER_API_KEY` is the last-resort free tier, not the
primary. `DATABASE_URL` must point at the Supabase Postgres instance. Server
listens on `PORT` (default 5000). Live diagnostics from a local checkout:
`node scripts/check-llm-status.mjs`, `node scripts/check-llm-errors.mjs`
(both read `APEX_ADMIN_PASSWORD` from `.env`), and
`node scripts/llm-probe.mjs` (probes every chain provider with local keys,
prints status only).

## Development Conventions

- **ESM only.** Use `import`/`export`. Never `require()`.
- **pnpm only.** Never introduce npm or bun lockfiles.
- **TypeScript strict mode.** All packages must typecheck cleanly.
- **Workspace protocol.** Internal deps use `workspace:*`.
- **Catalog versions.** Shared dependency versions are pinned in
  `pnpm-workspace.yaml` under `catalog:` — reference them as `"catalog:"`
  in package.json rather than hardcoding versions.
- **Supply-chain defense.** `minimumReleaseAge: 1440` in `pnpm-workspace.yaml`
  (+ `.npmrc`) — do NOT disable or set to 0.
- **No test framework is configured.** There is no `pnpm test` script.
  Verification is done via typecheck, build, and live functional smoke tests.
- **Secrets never in code.** Local-only scripts that touch live keys (e.g.
  `scripts/test-providers.mjs`) are gitignored by name — keep it that way;
  prefer scripts that read `.env` at runtime (like `scripts/llm-probe.mjs`).

## LLM Chain Operations (verified 2026-08-04)

`packages/core/src/llm-client.ts` is the source of truth. Current order:

```
cerebras → cerebras-2 → cerebras-3 → groq → groq-2 → google-gemini →
google-gemini-2 → deepseek → nvidia → together → qwen-cloud → glm-aliyun →
qwen-cloud-anthropic (Anthropic protocol) → glm-zai → poolside →
cohere* → openrouter-free* → openrouter-free-2*      (* toolCallingReliable:false)
```

Mechanics that MUST be preserved when editing this file:

1. **Two-pass fallback** — providers with `toolCallingReliable: false`
   (cohere, openrouter-free ×2) are skipped on tool-bearing requests and only
   tried in a second "last resort" pass after ALL reliable providers failed.
   A prose-only answer beats a dead workforce, but never ahead of real tools.
2. **Circuit breaker** — per-provider cooldown after failures: 30s for 429,
   5min for 402, 10min for 401/403. Skips exhausted providers instead of
   stampeding them.
3. **Round-robin start index** — each request starts at a rotated provider so
   concurrent agents spread load instead of all hitting the first entry.
4. **Global backoff** — when a full pass fails everywhere, wait before the
   next attempt instead of immediately burning the chain again.
5. **Role-aware Qwen models** — premium roles (CEO/CTO/COO/leads/QA Director)
   resolve a stronger Qwen model than standard roles; override via
   `APEX_QWEN_PREMIUM_MODEL` / `APEX_QWEN_STANDARD_MODEL`. Qwen Token Plan
   uses DOTTED model IDs (`qwen3.7-plus`), not hyphenated public IDs.
6. **History budget** — `DEFAULT_HISTORY_CHAR_BUDGET = 60_000` (~15k tokens).
   Deliberately halved from 120k on 2026-08-04: free-tier TPD caps (Groq
   100k/day) mean request size IS the capacity ceiling. Do not raise it
   casually.

**Known-bad as of 2026-08-04 (re-probe before trusting):**
`QWENCLOUD_API_KEY` is **401 Invalid API-key on every Qwen entry** (live AND
local) — the paid tier that should catch all fallbacks is dead until Don
rotates the Token Plan key in the Aliyun console. `ZAI_API_KEY` (local) is
expired; Railway has no ZAI key at all. `GEMINI_API_KEY_2` and
`NVIDIA_API_KEY` are unset on Railway — free capacity left on the table.
Cerebras local keys 402 (billing-gated); Railway's are alive but rate-limit
prone. Everything else was quota-exhausted (429) at probe time — resets
daily. Duplicate-key slots (`CEREBRAS_API_KEY_2/3`, `GROQ_API_KEY_2`,
`GEMINI_API_KEY_2`) multiply free-tier rate limits — Don's standing strategy
is more free accounts per provider.

## Security — Non-Negotiable

1. **Auth on all API routes.** Everything under `/api/*` except
   `/api/auth/login` and `/health` requires `Authorization: Bearer <token>`
   via `requireAdminAuth`. `/api/auth/login` exchanges `APEX_ADMIN_PASSWORD`
   for a token (`auth.ts` uses `requireEnv` — no hardcoded fallbacks). Never
   add routes outside this middleware stack. This was a real, live open
   exposure until 2026-07-12 — never regress it.
2. **Per-tool approval gating.** 13 tools require human approval system-wide
   (re-verified 2026-08-04 against `requiresApproval: true` in code):
   `runShell`, `deploy_to_environment`, `rollback_deployment`,
   `push_to_remote`, `create_pull_request`, `register_application`,
   `delegate_to_application`, `make_outbound_call`,
   `buildmybot_send_briefing`, `buildmybot_run_workforce`,
   `buildmybot_resolve_error`, `buildmybot_deploy`, `casebuddy_deploy_firm`.
   `writeFile`, `runInSandbox`, and `create_feature_branch` are
   auto-approved (git-reversible / local only). Never remove gating from
   `runShell` or production/deploy/PR/push/outbound-call actions without
   Don's explicit sign-off.
3. **Secrets by name only.** Never log, report, or commit secret values.
   Reference them by name (e.g., "OPENROUTER_API_KEY") only.
4. **GitHub writes** use `GITHUB_TOKEN_4` from the local/vault environment.
   No GITHUB_TOKEN env var currently exists on the live Railway service —
   in-app `create_feature_branch`/`create_pull_request` tools fail there.
   Known gap; do not "fix" by hardcoding a token into prod.
5. **No production DB schema changes** without explicit sign-off from Don,
   logged and timestamped. (The idempotent bootstrap DDL in
   `lib/db/src/client.ts` mirrors `schema.ts` — change both together.)
6. **APEX_APPROVAL_MODE** must never be globally `"off"` for irreversible
   categories. Allowed values: `"strict"` (default) or `"normal"`.

## The Verification Sequence (verified 2026-07-20)

Every real fix in this repo has followed this exact order:

1. **`git clone`/`git pull`** — always start from a fresh sync. NOTE: other
   AI sessions commit into `main` concurrently in this working tree —
   re-check `git status` immediately before committing; stage only intended
   paths.
2. **Typecheck** the packages you touched (all of them via `pnpm run
   typecheck` once convex-backend/dashboard are fixed). If any package is
   silently skipped, that's a false pass.
3. **`pnpm run build`** — confirm dashboard actually emits `dist/index.html`
   + JS/CSS bundles. Don't just trust exit code 0.
4. **Commit + push** with an honest commit message (root cause, what was
   tried, what was verified — not just "fixed bug").
5. **Wait ~60–70s**, then poll Railway's GraphQL deployments API
   (`backboard.railway.app/graphql/v2`) for `status: SUCCESS` on the new
   commit hash. Direct curls to `*.up.railway.app` can fail with TLS
   timeouts from sandboxes; `apex.donmatthews.live` works from a normal dev
   machine.
6. **Functionally smoke-test the actual feature live** — hit the real API
   route/tool with a real admin token and confirm real data comes back.
   Compiling and deploying are necessary but NOT sufficient.
7. **Update `CHECKLIST.md`/`ROADMAP.md`/`PLAN.md`** with what was verified
   vs. what wasn't, before considering the task done.

## Known Status (as of 2026-08-04)

| Area | Status |
|---|---|
| Phase 1 — Health monitoring | ✅ Functionally verified live (`/api/health` returns real data incl. provider chain status). |
| Phase 1 — Background jobs | ✅ Running live (full standing roster executing; visible in logs). |
| Phase 2 — Learning system | ⚠️ Built + typechecks. Live smoke test still pending. |
| Phase 3 — CI/CD test+build | ✅ Functionally verified live (9/9 typecheck, real vite build). |
| Phase 3 — Deploy/rollback trigger | ⚠️ Higher risk — needs Don present (No Unilateral Actions). |
| Phase 4 — Multiapp / Predictive | ⚠️ Built + typechecks. NOT functionally tested live. |
| Convex migration | ⚠️ UNVERIFIED — convex-backend typecheck broken; dashboard + cicd-worker depend on it (see package table). |
| Autonomous sales loop | ✅ Wired (Vapi outbound call → `send_checkout_link` → Stripe checkout via `/api/vapi/webhook`). |
| LLM capacity | ⚠️ DEGRADED 2026-08-04 — Qwen key dead (401), free tiers exhausted daily; see LLM Chain Operations. |

## Autonomy model (updated 2026-08-04)

Delegation is a **closed loop**, not a one-way broadcast:

1. Work originates from cron, not only from a human `POST /api/goals`. The
   standing roster is seeded idempotently in `seedDefaultJobs`
   (`packages/api-server/src/index.ts`): CEO goal review (*/15), lead-gen
   sweep (2h), daily report (09:00), maintenance (03:00), learning analysis
   (6h), delegation follow-up (*/5), goal progress (*/30), failure triage
   (2h), stalled-work recovery (*/10), COO branch review (hourly), CTO branch
   review (2h). Runtime-editable by the CEO via
   `schedule_task`/`cancel_scheduled_task` — the jobs table is the source of
   truth, not the seed array.
2. `DelegationFollowupJob` routes **real outcomes** back to the delegator
   once every sibling under that parent is terminal. Synthesis tasks are root
   tasks, so the loop converges.
3. Goals only leave `active` via the `update_goal_status` tool — nothing
   closes them automatically; `update_goal_status` refuses to complete a goal
   with open tasks or without a `result`.
4. Failures cluster into a CEO triage task via `FailureReviewJob` instead of
   dying silently at `status = 'failed'`.
5. COO and CTO have their own `BranchReviewJob` heartbeats; the CEO is not
   the only reviewer.
6. Every agent gets one **self-review turn** before a no-tool-call answer is
   accepted as done (`APEX_SELF_REVIEW=0` disables it). Apology-style answers
   ("I'm sorry, I cannot…") are detected and recorded as FAILED, never done.
7. `PromptSelfImproveJob` lets Apex self-critique its own agent prompts.

Two invariants to preserve: every autonomous handler is **idempotent** (never
stack a second review on an agent that hasn't worked the last one), and
irreversible actions stay approval-gated regardless of who originated the
task.

**Watch-outs observed 2026-08-04:** during provider exhaustion,
`stalled_work_recovery` (every 10 min, up to 15 requeues per run) can
re-burn an already-exhausted chain — recovery should respect the global LLM
backoff state. Peer-review tasks occasionally instruct an agent to request a
review from its OWN role, producing self-delegation rejections (the guard in
`delegateToRole` catches it, but the task still cost an LLM round). The
container image must keep root `*.md` docs copied in (`COPY *.md ./` in
Dockerfile) or agents fail with "file does not exist" loops (caught Sales/COO
live before the fix).

Re-verify with (destructive — scratch DB only, never production):
`DATABASE_URL=... pnpm --filter @workspace/api-server exec tsx ../../scripts/verify-autonomy-loop.ts`
and `.../verify-autonomy-scheduler.ts`.

## Key Documentation Files

| File | Purpose |
|---|---|
| `AGENTS.md` | **Canonical instructions** for any AI coding tool. Keep this current. |
| `APEX_CHARTER.md` | Governance/mission charter (non-negotiable rules, phased roadmap). |
| `APEX_INTEGRATION.md` | How Apex commands/reads BuildMyBot's AI workforce. |
| `BUSINESS_PROFILE.md` | BuildMyBot.app ground truth (pricing, ICP, what's real vs. marketed). Agents read this at runtime from the workspace. |
| `CHECKLIST.md` | Master implementation checklist with honest status notes. |
| `ROADMAP.md` | Full technical roadmap. |
| `PLAN.md` | Living plan document, updated as work happens. |
| `apexplan.md` | Convex migration plan (documents convex-backend as UNVERIFIED). |

Check `CHECKLIST.md`, `ROADMAP.md`, and `PLAN.md` first for current state
before starting any work.
