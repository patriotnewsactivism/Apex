# Repository Guidelines — Apex

## Project structure
- `packages/api-server/` — Express + WebSocket backend. Entry: `pnpm --filter @workspace/api-server run start` (runs `NODE_ENV=production tsx` against the built entry — see that package's own `package.json` for the exact script).
- `packages/dashboard/` — the web UI meant to be served at the service root. **As of 2026-07-12 the live Railway deployment returns "Cannot GET /"** — the Express server's `existsSync(dashboardDist)` check fails in production, root cause not yet found (Docker build/`.dockerignore` likely candidates).
- `packages/frontend/` — a second, separate frontend directory also exists. Not yet determined whether this or `dashboard` is the current intended UI, or if one is stale. Check with Don before building on either without confirming.
- `lib/db/src/migrate.ts` — Drizzle/libSQL migrations. **Every `db.run(...)` call here must be `await`ed.** A missing `await` here previously caused a full crash-loop (agent init raced ahead of table creation, `SQLITE_ERROR: no such table: agents`) — fixed 2026-07-12, keep it that way.
- Database: local SQLite via libSQL driver, stored at `.local/apex.db` on Railway.
- Package manager: **pnpm** (workspace, `pnpm-workspace.yaml`). Do not introduce npm/bun lockfiles into this repo.

## The 12-agent hierarchy (confirmed live via `/api/agents`)
```
APEX (CEO, tier 0)
├── CTO (tier 1)
│   └── Lead Developer (tier 2)
│       ├── Frontend Developer / Backend Developer / DevOps Engineer / QA Engineer (tier 3)
└── COO (tier 1)
    ├── Lead Researcher / Sales & Business Development / Marketing & Social Media / Customer Success & Support (tier 3)
```
Model: `gpt-4o` via `openrouter` for all 12, as of 2026-07-12.

## Security
- All routes under `/api/*` except `/api/auth/login` and `/health` require
  `Authorization: Bearer <token>` validated by `requireAdminAuth` against
  `APEX_ADMIN_TOKEN`. `/api/auth/login` exchanges `APEX_ADMIN_PASSWORD` for
  that token. **Do not add new routes outside this middleware stack.**
- This was a real, live exposure until 2026-07-12 (every route was
  previously open, `cors({origin:'*'})`, no auth at all) — do not regress it.

## Conventions
- TypeScript strict mode throughout.
- `import crypto from 'crypto'` (ESM) — this app runs via `tsx`, not CommonJS.
  `require(...)` will throw `ReferenceError: require is not defined`.
- No `server/`-style Express monolith assumptions here — this genuinely is
  a persistent Express app (unlike buildmybot2, which is Vercel serverless
  despite some of its own docs implying otherwise — don't cross-apply
  assumptions between the two repos).
