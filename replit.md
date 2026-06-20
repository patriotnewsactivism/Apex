# APEX — Autonomous AI Workforce

A persistent, hierarchical multi-agent platform that transforms high-level goals into completed outcomes through an autonomous AI workforce.

## Run & Operate

- `pnpm run dev:api` — start the APEX API server + agent workforce (port 5000)
- `pnpm run dev:dashboard` — start the command center dashboard (port 3000)
- `pnpm run dev` — run both concurrently

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```
OPENAI_API_KEY=sk-...           # Required (primary LLM provider)
ANTHROPIC_API_KEY=sk-ant-...    # Optional
GOOGLE_API_KEY=...              # Optional
APEX_LLM_PROVIDER=openai        # openai | anthropic | google
APEX_APPROVAL_MODE=on           # on (human approval required) | off (fully autonomous)
DATABASE_PATH=.local/apex.db    # SQLite database path
WORKSPACE_ROOT=/path/to/project # Directory agents can read/write
PORT=5000
```

## Agent Hierarchy

```
APEX CEO (Tier 0)
├── CTO (Tier 1)
│   └── Lead Developer (Tier 2)
│       ├── Frontend Agent (Tier 3)  — React, Vite, TailwindCSS
│       ├── Backend Agent (Tier 3)   — Node.js, Express, Drizzle
│       ├── DevOps Agent (Tier 3)    — Docker, CI/CD
│       └── QA Agent (Tier 3)        — Testing, audits
└── COO (Tier 1)
    ├── Research Agent (Tier 3)       — Web research & synthesis
    ├── Documentation Agent (Tier 3)  — READMEs, wikis, docs
    └── Operations Agent (Tier 3)     — Reports, scheduling
```

## Stack

- pnpm workspaces, Node.js, TypeScript 5.9
- **Core Engine**: `packages/core` — BaseAgent, LLM client, tool registry, memory, task queue
- **Agents**: `packages/agents` — 11-agent hierarchy
- **API**: `packages/api-server` — Express 5 + WebSocket
- **Dashboard**: `packages/dashboard` — React 19 + Vite + TailwindCSS
- **DB**: SQLite + Drizzle ORM (`lib/db`)

## Where Things Live

- Agent system prompts: `packages/agents/src/`
- Tool definitions: `packages/core/src/tool-registry.ts`
- DB schema: `lib/db/src/schema.ts`
- Dashboard pages: `packages/dashboard/src/components/`
- API routes: `packages/api-server/src/routes/`

## Architecture Decisions

- **SQLite over Postgres** for zero-config local development; switch by changing `lib/db/src/client.ts`
- **Approval-gated by default** — agents request permission before writing files or running commands
- **Multi-provider LLM** — senior agents (CEO/CTO/COO) use GPT-4o, specialists use GPT-4o-mini
- **Event-driven** — all state changes emit events via `apexEventBus` → WebSocket → dashboard
- **pnpm workspaces** — each layer is an independent package for clean separation

## Dashboard Panels

| Panel | Path | Description |
|-------|------|-------------|
| Mission Control | `/` | Submit goals, view stats, active goal list |
| Agent Network | `/agents` | Live org chart with status indicators |
| Task Board | `/tasks` | Kanban board across 6 status columns |
| Log Stream | `/logs` | Real-time color-coded agent logs |
| Approval Queue | `/approvals` | Pending tool actions requiring human review |

## Gotchas

- Always set `WORKSPACE_ROOT` to the project directory you want agents to work in
- The SQLite DB is stored in `.local/apex.db` — back this up to preserve agent memory
- Agents poll for tasks every 2 seconds — don't worry if they seem idle briefly
- `APEX_APPROVAL_MODE=off` enables full autonomy — use with caution
