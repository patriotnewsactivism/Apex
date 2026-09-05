# APEX Agent Model

_Describes the agent operating model as it actually exists in Apex today (see `docs/APEX_SYSTEM_AUDIT.md` §6–7 for how this was verified). Apex-Stream's agents are a different concept — monitoring/ingestion workers, not a business-reasoning workforce — and are documented separately in Apex-Stream's own `docs/agents.md`; cross-referenced here only where relevant._

## Roster (production, 13 agents)

```
APEX CEO
├── CTO → Lead Developer → Frontend / Backend / DevOps / QA
└── COO → Lead Research / Sales / Marketing / Customer Success
QA Director — independent quality/oversight role
```

Defined in `packages/agents/src/*.ts` as `BaseAgent` subclasses. Generic specialist classes (Research/Documentation/Operations) exist in source as a legacy scaffold but are **not** part of the instantiated production roster — do not treat their presence in source as evidence they run.

## Responsibilities, tools, and limits

Every agent declares, in its own class:

- a **system prompt** defining role and constraints;
- an explicit **tool allowlist** drawn from `packages/core/src/tool-registry.ts`'s ~60 registered tools (file I/O, web search/fetch, CI/CD, peer review, sandboxed shell, portfolio connectors);
- a **model assignment**, resolved through `packages/core/src/llm-client.ts`'s OpenRouter routing (see ADR-004 in `docs/ARCHITECTURE_DECISIONS.md` for the full evidence-governed model-selection contract — this document does not repeat it);
- a **maxIterations** ceiling on its agentic tool-use loop (15–40 depending on role);
- an **`approvalRequired`** flag — currently defined per-agent but **not read anywhere in the live execution path** (only the per-tool `requiresApproval` flag is enforced; see `docs/APEX_CAPABILITY_MATRIX.md`). Treat this as an open question to resolve, not a control to rely on.

## Structured inputs/outputs

Tasks carry a JSON `context` field and a `result` string on completion; tool calls are validated against each tool's Zod schema before execution (`ToolRegistry.execute()`). There is no separate "structured output schema" per agent beyond the tool-call contract itself — an agent's final answer to a task is free text plus whatever tool results it accumulated, which is why the non-completion guard (`packages/core/src/non-completion.ts`) exists: it specifically catches an agent's free-text claim of success that isn't backed by a real completed tool call.

## Context boundaries and persisted state

Each agent's `TaskQueue` and `MemoryManager` are scoped to that agent's own rows in Postgres (`memories.agentId`, `tasks.assignedAgentId`); there is no shared mutable global state between agents beyond the database itself. Delegation between agents happens by inserting a new `tasks` row addressed to another agent's ID — never a direct in-process call — which is what makes the whole thing durable across restarts (see `docs/APEX_ARCHITECTURE.md` §"Failure handling").

## Determinism vs. LLM reasoning

Consistent with the principle that deterministic operations should use deterministic code: task claiming, retry/backoff timing, approval state transitions, dedup, and budget/backpressure decisions are all **plain Postgres queries and TypeScript logic**, not LLM calls. The LLM is used only for the things that actually need judgment — goal decomposition, tool-call planning, content drafting, classification. This audit found no case of an LLM call being used where a deterministic check would have sufficed; if anything, the reverse risk (an agent narrating success without a real tool call) is already guarded against, per above.

## Avoiding redundant agents

The audit found no case of an agent existing "to look sophisticated" without real tool access or a distinct responsibility — each of the 13 has a distinguishable role and its own tool allowlist. The one soft overlap: `packages/multiapp`'s cross-portfolio delegation and `packages/core/src/orchestration-tools.ts`'s agent-to-agent delegation tools address adjacent but distinct concerns (delegating to another *application* Apex manages, vs. delegating to another *agent* within Apex) — worth a documentation pass to make the boundary explicit, not worth merging.

## Apex-Stream's agents, for contrast

Apex-Stream's five agents (Aria, Atlas, Sentinel, Archivist, Warden) are workers, not reasoning agents in this sense — each implements a single `handle(task, ctx)` method against a fixed message-queue contract, with no LLM-driven planning loop of their own (Warden's classify/draft step is the one exception, using an LLM for classification and reply drafting, gated entirely behind human approval before anything posts). They share Apex's *naming convention and general design philosophy* (a common author, evident in both), not its code or its planning loop.
