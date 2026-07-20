# Repository Guidelines — Apex
_Last verified against live system: 2026-07-20. Single canonical instructions
file for any AI coding tool (Claude Code, Gemini CLI, Codex, Replit Agent,
etc.) — the separate CLAUDE.md/GEMINI.md/replit.md/BASE44.md files were
deleted 2026-07-20 as stale duplicates from 2026-07-12 that had drifted out
of sync with reality (wrong agent count, wrong LLM provider setup, a
dashboard bug that was long since fixed). Keep THIS file current instead of
letting per-tool copies re-diverge._

## What this is
A persistent, hierarchical **13-agent** autonomous workforce (CEO -> CTO/COO
-> specialists -> QA Director), deployed as an always-on Node process on
Railway (`apex-production-731c.up.railway.app` / `apex.donmatthews.live`) --
not a request/response serverless app.

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
- TypeScript strict mode throughout, 12 workspace packages: core, agents,
  api-server, dashboard, health-monitor, background-jobs, learning-system,
  cicd-automation, multiapp, predictive, plus lib/db.
- DB: Drizzle ORM, real prod DB URL cached at `/tmp/apex_db_url.txt` in the
  agent sandbox. A separate raw-container Postgres also exists in this
  Railway project (service `1ab5efa2-...`) -- unused, no volume, DO NOT USE.
- **LLM fallback chain** (`packages/core/src/llm-client.ts`): OpenRouter ->
  Cerebras -> Mistral -> Groq -> Cohere-trial -> Cohere -> OpenRouter-free.
  Not a single-provider `OPENAI_API_KEY` setup.

## Security
- All routes under `/api/*` except `/api/auth/login` and `/health` require
  `Authorization: Bearer <token>` (`requireAdminAuth`). `/api/auth/login`
  exchanges `APEX_ADMIN_PASSWORD` for that token. Do not add routes outside
  this middleware stack. This was a real, live open exposure until
  2026-07-12 (no auth, `cors({origin:'*'})`) -- never regress it.
- Approval is **per-tool**, not a global on/off switch: only 6 tools require
  it system-wide (`writeFile` was flipped to auto-approved 2026-07-19 as
  git-reversible; `runShell`, `runInSandbox`, and 3 buildmybot-connector
  actions remain human-gated). Never remove gating from `runShell`/
  `runInSandbox`/production actions without Don's explicit sign-off.
- Secrets referenced by name only, never by value, in any log/report/commit
  message. GitHub writes always use `GITHUB_TOKEN_4`. No GITHUB_TOKEN env
  var currently exists on the live Railway service itself -- so in-app
  `create_feature_branch`/`create_pull_request` tools will fail if invoked;
  that's a known gap, not a bug to "fix" by hardcoding a token into prod.

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
4. Commit + push with `GITHUB_TOKEN_4`, honest commit message (root cause,
   what was tried, what was verified -- not just "fixed bug").
5. Wait ~60-70s, then poll Railway's GraphQL deployments API for `status:
   SUCCESS` on the new commit hash (direct curls to `*.up.railway.app`
   reliably fail in this sandbox from TLS timeouts -- use
   `backboard.railway.app/graphql/v2` instead).
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
