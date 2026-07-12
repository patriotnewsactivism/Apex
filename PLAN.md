# Apex — Build Plan

Last updated 2026-07-12. Ranked in build order — later items assume earlier
ones are done.

## Done
- [x] Fixed crash-loop: all 12 migration calls in `lib/db/src/migrate.ts`
      now properly `await`ed. Verified live: 12/12 agents initialize.
- [x] Security lockdown: `requireAdminAuth` bearer-token middleware on all
      routes except `/api/auth/login` and `/health`. Verified live via
      5-point test (see BASE44.md).
- [x] Cleaned up duplicate/stale Railway service (`apex-agent`), confirmed
      `Apex` service correctly linked to `patriotnewsactivism/Apex`.

## Next (the "brain center" dashboard — Don wants full login-and-control access)
1. **Root-cause the dashboard 404.** Why doesn't `packages/dashboard/dist`
   reach the production container? Check Dockerfile COPY steps and
   `.dockerignore` first — likely a cheap fix once found.
2. **Login screen.** Hits `POST /api/auth/login`, stores the returned
   token, sends it as `Authorization: Bearer` on every subsequent call.
3. **Live view.** Agents, goals, tasks, logs, approvals — pull from the
   existing REST routes, then subscribe to the existing WebSocket
   (`setupWebSocket`) for real-time updates instead of polling.
4. **Command/override input.** Post new goals/tasks to the CEO agent;
   approve/reject UI wired to `/api/approvals/:id/approve|reject`.
5. **OAuth connector framework.** The biggest, most speculative chunk —
   essentially building token storage + refresh + per-service scopes from
   scratch for each of Vercel/Railway/Render/Neon/Convex/Cloudflare/
   WordPress/YouTube/social platforms. Scope this as its own
   discussion with Don on which services are actually load-bearing first —
   don't build all of them speculatively in one pass.

## Open questions for Don (not yet decided)
- `packages/dashboard` vs `packages/frontend` — which is canonical?
- Should the stale `Apex-Agent` repo (if it still exists) be archived?
