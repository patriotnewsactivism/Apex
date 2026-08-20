# Repository Guidelines — Apex
_Last verified against live system: 2026-08-04. Single canonical instructions
file for any AI coding tool (Claude Code, Gemini CLI, Codex, Replit Agent,
etc.) — the separate CLAUDE.md/GEMINI.md/replit.md/BASE44.md files were
deleted 2026-07-20 as stale duplicates from 2026-07-12 that had drifted out
of sync with reality (wrong agent count, wrong LLM provider setup, a
dashboard bug that was long since fixed). Keep THIS file current instead of
letting per-tool copies re-diverge._

> **2026-08-16: RAILWAY RETIRED — replaced by AWS Lightsail.** Production
> is fully off Railway (`railway.toml` removed, all `'railway'` deploy-
> platform options stripped from code/schemas — do not re-add a `railway`
> case anywhere without a real reason). Real production runtime:
> **AWS Lightsail container service `apex-service`**
> (`535203103662.dkr.ecr.us-east-1.amazonaws.com/apex-lightsail:latest`),
> built by CodeBuild project `apex-lightsail-build` (pulls from GitHub
> `main` when triggered — pushing to `main` alone does NOT deploy).
> To ship a real change: (1) push/merge to `main`, (2)
> `aws codebuild start-build --project-name apex-lightsail-build --region
> us-east-1` and wait for `buildStatus: SUCCEEDED` (this builds + pushes the
> new image to ECR), (3)
> `aws lightsail create-container-service-deployment` for service
> `apex-service` with the current container/env spec (pull it first via
> `aws lightsail get-container-service-deployments --service-name
> apex-service` and only change what you intend to) — a bare CodeBuild
> success does NOT redeploy the running service. (4) Poll
> `aws lightsail get-container-service-deployments --service-name
> apex-service --query 'deployments[0].state'` until `ACTIVE`, then hit the
> service's real health endpoint (`aws lightsail get-container-services
> --service-name apex-service --query 'containerServices[0].url'`, then
> `curl <url>health`) for direct proof, not just deployment state.
>
> **Differentiating the deploy targets (2026-08-19):** Apex ITSELF runs only on
> Lightsail. Vercel and Railway still appear throughout this repo — in the
> CI/CD tooling, the BuildMyBot/TubeScribe connectors, and older planning docs
> — as deploy targets for **client projects** Apex manages, or as history. Do
> not read those as Apex's hosting, and never repoint Apex at one of them.
> **Verifying what's live:** `GET /health` reports the commit baked into the
> running image (`build.sha`), process uptime, and task-queue liveness, and
> returns 503 when `dequeue()` is failing repeatedly. Check it before theorising
> about production behaviour — on 2026-08-19 hours went into a bug that was
> actually a stale image, because nothing could answer "is my fix running?".
> See `docs/deploy-provenance.md`. Deploys run via the **Deploy** GitHub Actions
> workflow (manual trigger); it fails the run if the live commit is not the
> commit deployed, so a cached `:latest` digest can no longer pass as green.
>
> **Self-deploy is now implemented (2026-08-19, second pass).**
> `deploy_to_environment` runs the four steps above for real via
> `packages/cicd-automation/src/lightsail-deployer.ts` (CodeBuild StartBuild →
> poll → CreateContainerServiceDeployment reusing the CURRENT spec → poll to
> ACTIVE → verify the live `/health` endpoint) and `rollback_deployment` rolls
> the service back to the previous ACTIVE spec, also health-verified. Both are
> approval-gated. Earlier the same day they threw; before that they returned a
> fabricated `status: 'healthy'` plus a fake `apex.vercel.app` URL, which let
> agents report releases that never happened — never reintroduce that shape.
> Requirements, both mandatory or the tool refuses (it never fakes):
> `APEX_DEPLOY_ENABLED=production` (or `staging` / `all` — credentials existing
> is not consent to ship) and scoped AWS credentials. Use a dedicated IAM
> identity with the five actions in `docs/aws-deploy-iam-policy.json`, never
> root-account keys. Optional: `APEX_CODEBUILD_PROJECT`,
> `APEX_LIGHTSAIL_SERVICE`, `APEX_DEPLOY_BUILD_TIMEOUT_MS`,
> `APEX_DEPLOY_ACTIVATION_TIMEOUT_MS`, `APEX_DEPLOY_POLL_INTERVAL_MS`.
> A throw from either tool means NOTHING shipped.

## What this is
A persistent, hierarchical **13-agent** autonomous workforce (CEO -> CTO/COO
-> specialists -> QA Director), deployed as an always-on Node process --
not a request/response serverless app. (Formerly hosted on Railway at
`apex-production-731c.up.railway.app` / `apex.donmatthews.live` — retired
2026-08-16, see banner above. Now runs on AWS Lightsail as `apex-service`;
`apex.donmatthews.live` is repointed at the Lightsail service URL.)

```
APEX CEO (Tier 0)
├── CTO (Tier 1) -> Lead Developer (Tier 2) -> Frontend/Backend/DevOps/QA (Tier 3)
└── COO (Tier 1) -> Lead Researcher / Sales / Marketing / Customer Success (Tier 3)
QA Director -- 13th agent, sits outside the two branches
```
A generic Research/Documentation/Operations trio also exists in
`packages/agents/src/specialists.ts` but is **never instantiated** -- dead
code, do not delegate to it or treat it as part of the real org chart.

## Stack & conventions
- **Package manager: pnpm** (workspace, `pnpm-workspace.yaml`). Never
  introduce npm/bun lockfiles.
- **ESM via `tsx`**, not CommonJS -- use `import`, never `require()`.
- TypeScript strict mode throughout, 16 directories under packages/ (core,
  agents, api-server, dashboard, health-monitor, background-jobs,
  learning-system, cicd-automation, cicd-worker, convex-backend, cli,
  buildmybot-ops, orchestrator, frontend, multiapp, predictive) plus lib/db.
  convex-backend does NOT typecheck (never codegen'd — apexplan.md) and
  dashboard + cicd-worker depend on it; packages/frontend is a stray src/
  with no package.json (not a real package).
- DB: Drizzle ORM over **Postgres (Supabase)** via `DATABASE_URL`; schema
  bootstrapped idempotently at startup (lib/db/src/client.ts). The old
  SQLite setup is dead. A separate raw-container Postgres also existed in
  the (now-retired) Railway project (service `1ab5efa2-...`) -- unused, no
  volume, DO NOT USE even if it's somehow still reachable.
- **LLM fallback chain** (`packages/core/src/llm-client.ts`, re-verified
  2026-08-04): Cerebras(×3) -> Google Gemini(×2) -> Groq(×2) -> NVIDIA NIM ->
  Poolside -> Together AI -> DeepSeek -> Qwen Cloud -> GLM-Aliyun ->
  Qwen Cloud (Anthropic protocol) -> GLM-Z.ai ->
  Cohere (toolCallingReliable:false) -> OpenRouter-free ×2
  (toolCallingReliable:false). Ordered by the 2026-08-04 live+local audit
  (scripts/llm-probe.mjs): live/self-resetting providers first; 401/402-dead
  entries (cerebras-2/3, together, deepseek, the three qwen entries) demoted
  but kept for zero-code-change recovery. Mistral was REMOVED (all keys
  401). Two-pass
  fallback: toolCallingReliable:false providers are skipped on tool-bearing
  requests and only tried as last resort after all reliable providers fail.
  Circuit breaker (30s/429, 5min/402, 10min/401 cooldowns) + round-robin
  start index spread concurrent load. Request history budget is 60k chars
  (~15k tokens) on purpose — free-tier TPD caps make request size the
  capacity ceiling. OpenRouter is the last-resort free tier, NOT the
  primary. Duplicate-key slots (CEREBRAS_API_KEY_2/3, GROQ_API_KEY_2,
  GEMINI_API_KEY_2) multiply free-tier rate limits. As of 2026-08-04 the
  QWENCLOUD_API_KEY is 401-dead on live AND local — needs rotation before
  the paid tier works again.

## Token budget governor (added 2026-08-19)
Everything that protected token spend before this was REACTIVE — the circuit
breaker, the daily-quota keyword sniff, the unclassified-429 streak
escalation and the global backoff all only fire after a provider has already
refused a request. `LLMResponse.usage` was parsed on every call and thrown
away, so nothing knew how many tokens the workforce had spent today.
`packages/core/src/token-ledger.ts` now records real per-provider spend
(persisted to `APEX_TOKEN_LEDGER_PATH`, default `/tmp/apex/token-ledger.json`,
so a Lightsail redeploy doesn't reset the day), keyed by UTC day.
- `APEX_TOKEN_CAPS=mistral:30000000,groq:400000` — per-provider daily token
  caps. A provider at/over its cap is skipped BEFORE the HTTP call and put in
  cooldown until the real UTC daily reset (not the 4h heuristic).
- `APEX_TOKEN_CAP_TOTAL=8000000` — workspace-wide daily cap; `complete()`
  fails fast with a clear "spend paused until UTC reset" error instead of
  walking 15 providers to collect 15 429s.
- Unset/0 = no cap (exactly the pre-2026-08-19 behavior). Caps count prompt +
  completion tokens, since every free tier with a TPD limit counts both.
- `GET /api/tokens` (behind `requireAdminAuth`) returns today's spend per
  provider with cap percentages — the answer to "are we about to run out?"
  that previously only existed in error logs after the fact.
- Idle agents now back off 5s → 60s between empty dequeues
  (`base-agent.ts`, reset to 5s the moment a task arrives), so an idle
  workforce stops converting every speculative task into instant LLM spend.

## Security
- All routes under `/api/*` except `/api/auth/login` and `/health` require
  `Authorization: Bearer <token>` (`requireAdminAuth`). `/api/auth/login`
  exchanges `APEX_ADMIN_PASSWORD` for that token. Do not add routes outside
  this middleware stack. This was a real, live open exposure until
  2026-07-12 (no auth, `cors({origin:'*'})`) -- never regress it.
- Approval is **per-tool**, not a global on/off switch: 13 tools require it
  system-wide (verified 2026-07-31) -- `runShell`, `deploy_to_environment`,
  `rollback_deployment`, `push_to_remote`, `create_pull_request`,
  `register_application`, `delegate_to_application`, `make_outbound_call`,
  `buildmybot_send_briefing`, `buildmybot_run_workforce`,
  `buildmybot_resolve_error`, `buildmybot_deploy`, `casebuddy_deploy_firm`.
  `writeFile` (2026-07-19), `runInSandbox`, and `create_feature_branch`
  (2026-07-22) are all auto-approved now (git-reversible / local only). Never
  remove gating from `runShell` or production/deploy/PR/push/outbound-call
  actions without Don's explicit sign-off.
- Secrets referenced by name only, never by value, in any log/report/commit
  message. GitHub writes use `GITHUB_TOKEN_12` (the current standing token
  per portfolio convention; `GITHUB_TOKEN_4` is superseded). Confirmed
  present on the current Lightsail `apex-service` host as of 2026-08-16
  (both `GITHUB_TOKEN` and `GITHUB_TOKEN_4` env vars exist there) -- this
  replaces the old note about the retired Railway host having none, so
  in-app `create_feature_branch`/`create_pull_request` tools should work if
  invoked. Still verify live rather than trusting this note forever.

## The order that reliably reproduces success (verified 2026-07-20)
Every real fix this repo has needed followed this exact sequence -- skipping
steps is what let a false "100% complete, all clean" claim get written into
CHECKLIST.md while `packages/core` was actually broken:
1. `git clone`/`git pull` -- always start from a fresh sync, never assume
   your last local state matches origin/main.
2. `pnpm run typecheck` -- must show all 12 packages `Done` with zero
   errors. If any package is silently skipped (check the package list in
   the output), that's a false pass, not a real one.
3. `pnpm run build` -- same rule; confirm dashboard actually emits
   `dist/index.html` + JS/CSS bundles, don't just trust exit code 0.
4. Commit + push with `GITHUB_TOKEN_12` (the current standing token; `GITHUB_TOKEN_4` is superseded), honest commit message (root cause,
   what was tried, what was verified -- not just "fixed bug").
5. Wait for the deploy to land, then confirm it landed on the CURRENT
   production host: AWS Lightsail service `apex-service`. Railway (and the
   GraphQL polling steps that used to live here) is retired as of
   2026-08-16 -- do not poll `backboard.railway.app` or any
   `*.up.railway.app` host; both are dead. Verify via
   `aws lightsail get-container-service-deployments --service-name
   apex-service --query 'deployments[0].state'` (wait for `ACTIVE`), then a
   real `curl` against the service's health endpoint -- see the banner at
   the top of this file for the full CodeBuild + Lightsail deploy sequence.
6. **Functionally smoke-test the actual feature live** -- hit the real API
   route/tool with a real admin token and confirm real data comes back.
   Compiling and deploying are necessary but not sufficient; this step is
   what caught that the CI/CD pipeline was structurally incapable of ever
   passing (typecheck was being run against prod's `--omit=dev` node_modules
   -- see `packages/cicd-automation/src/ci-workspace.ts`) even though it had
   compiled and deployed cleanly.
7. Update whichever of `CHECKLIST.md`/`ROADMAP.md`/`PLAN.md` is relevant
   with what was verified vs. what wasn't, before considering the task done.

## Known-good vs. known-gap status (2026-07-20)
- Phase 1 health monitoring: functionally verified live (`/api/health`
  returns real tool/WebSocket/task-backlog counts).
- Phase 3 CI/CD test+build: functionally verified live (9/9 typecheck pass,
  real vite build) as of commits 55bbb7a/5e9ad99.
- NOT yet functionally tested: background-jobs, learning-system, multiapp,
  predictive, and DeploymentManager's actual deploy/rollback trigger (higher
  risk -- needs Don present per No Unilateral Actions).

## Other docs in this repo
- `BUSINESS_PROFILE.md` -- BuildMyBot.app ground truth (pricing/ICP/what's
  real vs. marketed). Still current, COO-side agents must check it before
  making product claims.
- `APEX_CHARTER.md` -- the governance/mission charter APEX runs under. Still
  current, matches standing rules (no unilateral action, infra stability
  first, honest reporting, secrets by name only).
- `APEX_INTEGRATION.md` -- how Apex commands/reads BuildMyBot's AI workforce
  (no GitHub write access, no deploy authority over BuildMyBot -- reads
  `ai_team_log`/`leads`/`error_logs`, writes `manager_briefings`). Still
  accurate.
- `PLAN.md`, `ROADMAP.md`, `CHECKLIST.md` -- living status docs, updated as
  work happens. Check these first for current state before starting work.

## Context budget (token exhaustion)

`packages/core/src/context-budget.ts` bounds what each task re-sends to the model.
The agent loop keeps one `history` array and re-sends all of it every turn, for up
to `maxIterations` (20) turns. Tool results used to be appended as uncapped
`JSON.stringify(result)`, so a single large payload was re-billed on every later
turn — cost scaled with (turns x accumulated bytes) rather than with useful work.

Two limits, both env-tunable:

| Env var | Default | Effect |
| --- | --- | --- |
| `APEX_MAX_TOOL_RESULT_CHARS` | `8000` | Truncates one tool result (keeps head **and** tail, states how much was dropped). |
| `APEX_MAX_HISTORY_TOKENS` | `60000` | Elides oldest tool results until the whole history fits. |

This is distinct from `token-ledger.ts`: the ledger caps total spend after the
fact, this reduces the spend in the first place. Both are wanted.

**Do not "optimise" this by deleting old messages.** OpenAI-compatible APIs
reject a request where an assistant `tool_calls` message has no matching `tool`
result, so elision replaces `content` and keeps `toolCallId`/`name`. Dropping
messages would produce 400s in exactly the long conversations it aimed to help.
The system prompt, the first user message (the task) and the most recent turns
are never elided — an agent that forgets its objective thrashes and costs more.
