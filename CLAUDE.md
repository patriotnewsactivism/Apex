# CLAUDE.md

Guidance for Claude Code (or any AI coding agent) working in this repo.

## What this is
A persistent, hierarchical 12-agent autonomous workforce (CEO → CTO/COO →
specialists), deployed as an always-on Node process on Railway — not a
request/response serverless app. See `AGENTS.md` for the org chart and
`APEX_CHARTER.md` / `BUSINESS_PROFILE.md` for product intent.

## Before you touch anything
1. **Read `lib/db/src/migrate.ts` conventions first.** Every migration call
   must be awaited — an unawaited `db.run()` here caused a full production
   crash-loop once already (fixed 2026-07-12). Don't reintroduce it.
2. **Auth is mandatory on every route except `/api/auth/login` and
   `/health`.** See `packages/api-server/src/middleware/auth.ts`
   (`requireAdminAuth`). New routes must sit behind it.
3. **This is an ESM project run via `tsx`.** Use `import`, never `require()`.
4. **Package manager is pnpm.** Do not run `npm install` or add npm/bun
   lockfiles — this repo already had one crash from a Railway builder
   mis-detecting package manager in a *different* repo (buildmybot2); don't
   let it happen here too.

## Known open issues (as of 2026-07-12)
- Dashboard UI (`packages/dashboard`) returns "Cannot GET /" in production —
  build artifacts likely not reaching the deployed image. Not yet
  root-caused. This is the top priority before any new feature work on the
  dashboard.
- `packages/frontend` vs `packages/dashboard` — unclear which is canonical.
  Ask before assuming.
- No login/agent-monitoring/override UI exists yet — API-only currently
  (bearer token via curl/Postman). This is the next planned build phase:
  login screen → live agent/goal/task/approval view (subscribe to the
  existing WebSocket, don't poll) → command/override input → OAuth
  connector framework (Vercel/Railway/Render/Neon/Convex/Cloudflare/
  WordPress/YouTube/social — scope which services are load-bearing first,
  don't build all speculatively).

## Testing / running locally
- `pnpm run dev` — runs api-server + dashboard concurrently.
- `pnpm run typecheck` — workspace-wide typecheck, run before any commit.
- `pnpm run build` — typecheck + recursive build across `artifacts/`,
  `packages/`, `scripts/`.

## Relationship to the rest of Don's portfolio
Apex is a **generic** autonomous engineering/ops workforce — it is not
specific to BuildMyBot and is **not currently integrated** with
buildmybot2's own separate "AI Team" (different repo, different hosting —
Vercel vs Railway — different DB, no shared API). If a task asks you to
"have Apex talk to BuildMyBot," that integration doesn't exist yet; it's a
new build (most likely a read-only bridge pulling BuildMyBot's Supabase
tables), not a config fix.
