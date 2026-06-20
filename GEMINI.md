# APEX Monorepo Guidelines & Instructions

Welcome to the **APEX** workspace! This document serves as the developer's guide and instructional context for the monorepo, outlining its architecture, tech stack, development commands, agent architecture, database schemas, and codebase guidelines.

---

## 1. Project Overview & Architecture

APEX (Autonomous AI Workforce) is a persistent, hierarchical multi-agent platform designed to decompose high-level user goals into concrete, structured tasks, and execute them via specialized AI agents.

This repository is structured as a **pnpm monorepo** containing separate, modular packages:

```
C:\Apex-Agent\
├── lib/
│   └── db/                       # SQLite + Drizzle ORM database package (@workspace/db)
└── packages/
    ├── core/                     # Base agent engine, memory, task queue, tools, & LLM client (@workspace/core)
    ├── agents/                   # Definitions, prompts, and behaviors of the 11-agent hierarchy (@workspace/agents)
    ├── api-server/               # Express 5.0 + WebSocket server providing routes & real-time streams (@workspace/api-server)
    └── dashboard/                # Vite + React 19 + Tailwind CSS v4 command center UI (@workspace/dashboard)
```

---

## 2. Technology Stack

- **Package Manager:** `pnpm` (with workspace configurations)
- **Runtime:** Node.js
- **Language:** TypeScript 5.9 (Strict typing)
- **Core Engine:** BaseAgent model, Event-driven state updates (`apexEventBus`), tool registry, task polling queue
- **Database:** SQLite (local file at `.local/apex.db`) powered by Drizzle ORM
- **API Server:** Express 5.0, `ws` (WebSockets) for real-time dashboard events
- **Frontend Dashboard:** React 19 (using exact React versions to maintain compatibility), Vite, Tailwind CSS v4, TanStack React Query v5, Framer Motion, Lucide React, and Wouter for routing.

---

## 3. Environment Variables & Setup

Before running the platform, ensure you have copy-pasted `.env.example` into `.env` and populated the values correctly:

```ini
OPENAI_API_KEY=sk-...           # Required (primary LLM provider)
ANTHROPIC_API_KEY=sk-ant-...    # Optional
GOOGLE_API_KEY=...              # Optional
APEX_LLM_PROVIDER=openai        # openai | anthropic | google
APEX_APPROVAL_MODE=on           # on (human approval required for tool usage) | off (fully autonomous)
DATABASE_PATH=.local/apex.db    # SQLite database path
WORKSPACE_ROOT=C:\Apex-Agent    # Path where agents are authorized to read/write files
PORT=5000
```

---

## 4. Run & Development Commands

Always run these commands from the monorepo root:

| Command | Action | Description |
| :--- | :--- | :--- |
| `pnpm install` | Install dependencies | Resolves workspace dependencies and downloads external packages. |
| `pnpm run dev` | Dev Mode (Both API & UI) | Runs `dev:api` and `dev:dashboard` concurrently. |
| `pnpm run dev:api` | Run API Server | Starts Express + WS server with watch mode via `tsx watch` (Port 5000). |
| `pnpm run dev:dashboard` | Run Dashboard UI | Starts Vite server for the React web app (Port 3000). |
| `pnpm run build` | Build All | Performs typechecks and builds packages. |
| `pnpm run typecheck` | Strict Typecheck | Performs strict type-checks across all workspace libraries and packages. |
| `pnpm --filter @workspace/db run push` | DB Push schema | Pushes current Drizzle schema directly to the SQLite local database file. |
| `pnpm --filter @workspace/db run studio` | DB Studio | Launches Drizzle Studio to explore local DB records. |

---

## 5. Agent Hierarchy & Interaction Model

APEX operates a multi-tier, parent-child agent organization chart:

```
                  APEX CEO (Tier 0)
                 /                 \
        CTO (Tier 1)             COO (Tier 1)
             |                        |
     Lead Dev (Tier 2)          Research Agent (Tier 3)
      /      |      \           Documentation Agent (Tier 3)
Frontend  Backend   QA          Operations Agent (Tier 3)
(Tier 3)  (Tier 3) (Tier 3)
    |
 DevOps (Tier 3)
```

- **Tier 0 (CEO):** Decides the ultimate plan for high-level goals and delegates root tasks.
- **Tier 1 (CTO/COO):** Strategic directors that coordinate development tasks or business/operational research.
- **Tier 2 (Lead Developer):** Technical lead coordinating implementation and assigning dev sub-tasks.
- **Tier 3 (Specialists):** Domain-expert agents (Frontend, Backend, DevOps, QA, Research, Docs, Ops) executing target actions.

### Tool Approvals & Safety
All modifying actions (such as file modifications, command execution, database write overrides) are gated by an **approval model**:
1. When `APEX_APPROVAL_MODE=on`, tools defined with `requiresApproval: true` are paused.
2. An entry is written to the `approvals` database table, and a WebSocket event is broadcasted.
3. The dashboard UI presents the task and arguments under the **Approval Queue** panel.
4. The user approves or rejects. Approved actions continue executing immediately.

---

## 6. Database Schema & Core Types

The schema is defined in `lib/db/src/schema.ts` and core TypeScript models in `packages/core/src/types.ts`. Key tables include:

- **`agents`:** Live registry, status (`idle | thinking | acting | blocked | done | error`), tier, LLM model info, and parent ID.
- **`goals`:** High-level initiatives mapped to CEO assignments.
- **`tasks`:** Structured actions with relationships (`parent_task_id`), statuses (`pending | in_progress | blocked | awaiting_approval | done | failed | cancelled`), assignments, retries, and outputs.
- **`approvals`:** Gates for tools requiring human-in-the-loop validation before execution.
- **`memories`:** Persistence for agent/project/global learnings (`importance` rating of 0.0 to 1.0, expiration options, tags).
- **`logs`:** Color-coded, unified real-time logs (`debug | info | warn | error | thinking | acting`).
- **`messages`:** Inter-agent communications allowing collaborative problem-solving.

---

## 7. Crucial Coding & Development Conventions

### A. Supply-Chain Attack Defense (Pnpm Configuration)
In `pnpm-workspace.yaml`, a strict security guard is active:
- **`minimumReleaseAge: 1440`**: Restricts the installation of any npm package version published within the last 24 hours.
- **DO NOT REMOVE THIS.** It guards the workspace against supply-chain compromise.
- **Exclusions:** If a packages' latest hotfix is urgently required, specify its package name or pattern under `minimumReleaseAgeExclude` (e.g., trust `@replit/*`). Remove it once the package age exceeds 1 day.

### B. Type Safety & Warnings
- **Strict TypeScript:** Do not use type-bypassing mechanisms such as `any`, structural casting (`as unknown as Target`), or `@ts-ignore` comments unless explicitly requested. Use type guards and runtime validators (Zod) instead.
- **Drizzle Models:** When modifying schemas, declare proper types and matching relations in `lib/db/src/schema.ts`, and run `pnpm --filter @workspace/db run push` to sync changes locally.

### C. Design Patterns
- **Composition over Inheritance:** Maintain the clean separating pattern of `BaseAgent` and specialized configs. Do not introduce heavy prototype cloning or complex custom inheritance chains.
- **Event-Driven UI Sync:** State updates on goals, tasks, or agents must propagate via `apexEventBus` so the frontend remains reactive and visually accurate.

### D. Writing Safe Tools
- Custom tool additions must register under `packages/core/src/tool-registry.ts` and declare a strict Zod schema.
- Always implement the tool context's `requestApproval` flow for tools that interact with the physical workspace filesystem or run shell/CLI commands.
