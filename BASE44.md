# BASE44.md — Instructions for the Base44 Superagent working on this repo

## Non-negotiable rules
1. **GitHub writes always use `GITHUB_TOKEN_4`.**
2. **No unilateral irreversible action** — deploy/infra changes need Don's
   explicit go-ahead. Monitoring, analysis, and recommendations are fine
   without asking.
3. **Railway config for the `Apex` service must stay:** Root Directory
   blank, Serverless OFF (this is a persistent 12-agent loop, not
   scale-to-zero), no Cron Schedule (it's a long-running server, not a
   scheduled job), Healthcheck Path `/health`.
4. **`APEX_ADMIN_TOKEN`/`APEX_ADMIN_PASSWORD` are secrets** — reference by
   name only, never echo values.

## Verified current state (2026-07-12)
- All 12 agents initialize successfully and are healthy
  (`/health` → `{"status":"ok","agents":12}`).
- API is bearer-token gated (`requireAdminAuth`), confirmed via live 5-point
  test: no token → 401, wrong password → 401, correct password → 64-char
  token, token → 200 with real body, `/health` stays public.
- Dashboard UI is NOT live in production — returns "Cannot GET /". Queued
  as the top build priority; do not report the dashboard as working until
  this is actually fixed and re-verified live.
- `patriotnewsactivism/Apex` is the correct, actively-developed repo.
  `patriotnewsactivism/Apex-Agent` is/was a stale duplicate — if it still
  exists, don't develop against it; confirm with Don whether it can be
  archived.
- Working credential for Railway API access: `RAILWAY_USER_TOKEN`
  (account-scoped). Query via `workspace(workspaceId: ...)` — the `me { projects }`
  query returns empty for this account; the workspace id is
  `3136a2c1-361f-4aa7-8258-03653a66997b` ("Matthew Reardon's Projects").

## Relationship to buildmybot2's AI Team
Not integrated. See `CLAUDE.md` in this repo and
`ARCHITECTURE_REVIEW.md` in buildmybot2 for the full picture. If Don asks
for them to be tied together, that's new scoped work — propose a read-only
bridge (Apex pulls buildmybot2's Supabase `ai_team_log`/`error_logs`
tables via service-role key, synthesizes a portfolio brief) rather than
giving Apex write access to buildmybot2's production data.
