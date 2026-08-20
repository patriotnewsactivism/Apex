# Apex → Convex Migration

> **⚠️ 2026-08-19 — INFRASTRUCTURE NOTE (read before acting on anything below).**
> Every deployment/hosting reference in this file is **historical**. Apex
> production runs on the **AWS Lightsail** container service `apex-service`,
> image built by CodeBuild project `apex-lightsail-build`. Railway was retired
> 2026-08-16 and Apex has never run on Vercel. Where this file says "Railway"
> or implies Apex deploys to Vercel, read it as a record of what was true at
> the time, not as current state. `README.md` and `AGENTS.md` are authoritative.

## ⚡ RESUMPTION SNAPSHOT (2026-07-26, ~21:40) — READ THIS FIRST

Written mid-M3 at the user's request so work can resume on a different model/session. This section is the source of truth for "what's actually done" — trust it over inference from file timestamps.

### Status by milestone
- **M0 (fix hardcoded secrets)** — ✅ DONE. `packages/api-server/src/middleware/auth.ts` and `packages/api-server/src/routes/auth.ts` no longer fall back to hardcoded `apex-admin-secret-token`/`Mr03241987$`; both now `requireEnv()` and throw at import time if unset. **Local `.env` already has both vars set, so local dev is unaffected. If Railway prod was relying on the code fallback (not its own env vars), the next deploy of api-server will crash-loop until `APEX_ADMIN_TOKEN`/`APEX_ADMIN_PASSWORD` are set as real Railway env vars.** This hasn't been deployed anywhere yet — just committed to the working tree (not even git-committed — check `git status`).
- **M1 (scaffold packages/convex-backend)** — ✅ DONE. Package created, `convex/schema.ts` (26 tables, see below) deployed to production `agile-tern-916` via `pnpm exec convex deploy` (confirmed working, exit 0). A standing permission rule for `pnpm exec convex deploy`/`codegen`/`npx convex *` was added to `.claude/settings.local.json` (gitignored, personal) so these no longer prompt.
- **M2 (core data-access layer)** — ✅ DONE AND VERIFIED. `convex/{agents,projects,goals,tasks,approvals,memories,logs,messages}.ts` written, typechecked (real typecheck — see tsconfig note below), deployed, and smoke-tested live: seeded a test agent (`smoke-test-agent`, real Convex id `j5730z683za9w12jwt6vk9w6th8bav3r`), enqueued a task, dequeued it via the `by_agent_status_retry` index (confirmed atomic claim + correct priority/createdAt sort), completed it, confirmed a second dequeue returns nothing. **Two harmless leftover test rows exist in the live `agile-tern-916` deployment** (that agent + its now-`done` task) — trivial to delete via the Convex dashboard before the real data migration (M7), not urgent.
- **M3 (agent execution core)** — 🟡 IN PROGRESS, the largest milestone. See detailed breakdown below.
- **M4-M8** — not started (see original milestone list further down for scope).
- **Side-task (not part of the migration, requested mid-M3):** user wants a second Qwen Cloud provider entry added to the LLM fallback chain — the Aliyun Token Plan's **Anthropic-Messages-API-compatible** endpoint (`https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`, confirmed parallel in structure to the already-working OpenAI-compatible endpoint at `.../compatible-mode/v1`), alongside the existing OpenAI-compatible `qwen-cloud` entry. **Not started — see "Side-task" section below for the full design.**

### M3 detailed state — what's done, what's NOT verified, what's left

Files written (by me directly, all in `packages/convex-backend/convex/`):
- `llmConfig.ts` — pure config helpers (`getDefaultLLMConfig`, `getConfiguredProviders`, `getKnownApiKeyEnvs`), no Convex/Node runtime directive, split out specifically so non-`'use node'` files can import them safely.
- `llm.ts` — `'use node'` action file, ports `packages/core/src/llm-client.ts`'s `MultiProviderClient.complete()` and `createEmbedding()` as `internal.llm.complete` / `internal.llm.createEmbedding` actions. **This is the file the side-task (Qwen Anthropic endpoint) needs to modify.**
- `taskRuns.ts` — durable step-wise tool-loop state, one row per task (not per-iteration), `upsert` uses `ctx.db.replace()` (not `patch()`) specifically so `pendingJoins`/`partialToolResults` actually clear when omitted — this was a real bug I caught and fixed before it shipped.
- `cicd.ts` — **M3-scoped stub only** (`enqueueJob`, `getJob`) so tool actions have something to call; M5 adds the worker-facing `claimNextJob`/`reportJobResult`/timeout-sweep cron on top of the same `externalJobs` table.
- `agentLoop.ts` — the core control-flow file: `tick` (per-agent recursive self-chaining action replacing `BaseAgent.start()`'s `while(true)`), `resurrectStaleChains` (60s watchdog), `runIteration` (one LLM turn + tool executions per invocation, replacing `executeTask()`'s in-process while-loop), `resumeToolCall` (continues an iteration once a pending approval/external-job resolves — this is the replacement for the old busy-wait `requestHumanApproval`). Also has the two learning-context queries (`recentLearningInsights`, `appliedStrategyRecommendations`) pulled forward from M4 since `runIteration` hard-depends on them.
- `bootstrap.ts` — `bootstrapWorkforce` action: seeds/reconciles the 13-agent roster from `agentConfigs.ts`, stashes per-role `{maxIterations, concurrency, tools, approvalRequired}` into each agent's `metadata`, kicks off each agent's `tick` chain. **Not yet run against the live deployment.**
- `crons.ts` — one `crons.interval` entry (the watchdog), per the plan's "one cron, not 13" design.

Files written by subagents:
- `agentConfigs.ts` — ✅ DONE, confirmed clean by the subagent (verified by temporarily removing it and re-running tsc — identical unrelated failures occurred, confirming this file itself introduces zero errors). 13 entries, all fields populated including `approvalRequired` (I sent a follow-up message mid-run asking for this field after realizing I'd missed it in the original prompt — subagent added it correctly). Values match the "dev/infra + Marketing gated, everyone else autonomous" pattern predicted from the old codebase's own comments.
- `toolRegistry.ts` — 🟡 **UNVERIFIED.** File exists (88KB, last modified 21:39) but the subagent (task id `a239738743506068d` in this session — will NOT be resumable from a different model/session, that id is only meaningful within this exact conversation) had not yet reported completion when this snapshot was written. **Do not assume it's correct or even syntactically valid.** Next step: check if the task notification already arrived (if resuming in the same session) or, if starting fresh, just run `cd packages/convex-backend && pnpm exec convex codegen` and read the TypeScript errors — that will immediately show whether `toolRegistry.ts` is complete and whether its exports (`dispatchTool`, `getLLMToolSchemas`, `TOOL_DEFS`, `ToolContext` type) match exactly what `agentLoop.ts` expects (see the contract spelled out in the original subagent prompt, findable by searching this conversation, or just read `agentLoop.ts`'s imports from `./toolRegistry.js` and reconcile).

**M3 remaining work (in order):**
1. Verify/fix `toolRegistry.ts` — run codegen, fix type errors, spot-check that `requiresApproval` is set correctly on `deploy_to_environment`/`rollback_deployment`/`push_to_remote`/(check `create_pull_request`) and that the ~22 tool names actually referenced in `agentConfigs.ts` (`browserCheck, buildmybot_deploy, buildmybot_dispatch_engineering, buildmybot_health_check, buildmybot_open_errors, buildmybot_send_briefing, buildmybot_status, collectSwarmResults, create_pull_request, dispatchSwarm, fetchUrl, health_check, listDir, listResearchedLeads, readFile, requestPeerReview, runInSandbox, runShell, saveResearchedLead, sendMessage, webSearch, writeFile`) all exist as keys in `TOOL_DEFS`.
2. Once `pnpm exec convex codegen` (from `packages/convex-backend/`) is fully clean across the whole file set, `pnpm exec convex deploy` to push M3 to production.
3. Run `pnpm exec convex run bootstrap:bootstrapWorkforce '{}'` to seed the 13 agents and kick off their tick chains for the first time — **this is the first real functional test of the whole agent loop.**
4. Watch the Convex dashboard's function logs / query `agents`/`tasks`/`logs` tables to confirm at least one agent's tick chain is alive (heartbeat updating) and, if any real task gets created, that `runIteration` actually drives an LLM call end-to-end. (No real tasks will exist yet since no goal has been submitted — bootstrapping alone just proves the tick chains start and idle-poll correctly.)
5. Spike `@convex-dev/agent` fit per the original plan (§3) — not started, arguably now optional since the custom `agentLoop.ts` design is fully built; use judgment on whether it's still worth the detour or whether to just proceed with what's built.
6. Delete the two smoke-test rows from M2 before real data ever flows in (cosmetic, do whenever convenient).

### Side-task: Qwen Cloud Anthropic-compatible endpoint (not started)

User confirmed via a mid-turn message that both endpoints share one API key (`QWENCLOUD_API_KEY`) and use parallel paths:
- Existing (working) OpenAI-compatible entry: `baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'`
- New Anthropic-compatible entry (to add): `baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic'` (path confirmed parallel by the user; exact model ID string this endpoint expects is **still unknown** — WebFetch on that URL 401'd, needs either the user checking their Aliyun dashboard/docs for the model name, or a live test call with a guessed model string to see what error comes back).

**Design decided (not yet implemented) — apply to BOTH `packages/core/src/llm-client.ts` (the live file used by the currently-running production system) and `packages/convex-backend/convex/llm.ts` (the Convex port, same logic):**

1. Add `@anthropic-ai/sdk` as a dependency (`packages/core/package.json` and `packages/convex-backend/package.json`), then `pnpm install`.
2. Extend the `PROVIDERS` array's entry type with an optional `protocol?: 'openai' | 'anthropic'` field (undefined/absent = `'openai'`, today's default for every existing entry). Add one new entry:
   ```ts
   { name: 'qwen-cloud-anthropic', protocol: 'anthropic', baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', apiKeyEnv: 'QWENCLOUD_API_KEY', fallbackModel: '<CONFIRM WITH USER — placeholder, do not guess>' }
   ```
3. In the main provider loop inside `complete()`, branch: if `provider.protocol === 'anthropic'`, use a new `completeViaAnthropic()` path instead of the existing OpenAI-shaped path. Reuse the same `AbortController`/timeout/error-capture scaffolding already in the loop — only the request-building and response-parsing differ.
4. Anthropic Messages API shape (confirmed from the official skill reference, not guessed):
   - `system` is a **top-level string field**, not a message with `role: 'system'` — extract any `LLMMessage` with `role==='system'` out of the history and join into one `system` string; do not include it in `messages`.
   - Tool results (the internal format's `role: 'tool'` messages, one per tool call) must be **batched**: Anthropic expects all `tool_result` blocks for one turn inside a **single** `role: 'user'` message's `content` array (`[{type:'tool_result', tool_use_id, content}, ...]`) — splitting them across multiple messages is explicitly documented as harmful ("silently trains Claude to stop making parallel calls"). Write a conversion function that walks the history and merges consecutive `role==='tool'` entries into one Anthropic user message.
   - Assistant messages with tool calls become `{role:'assistant', content: [...(text block if content non-empty), ...toolCalls.map(tc=>({type:'tool_use', id:tc.id, name:tc.name, input:tc.args}))]}`.
   - Tools: Anthropic's field is `input_schema` (not OpenAI's `parameters`) — `{name, description, input_schema: t.parameters}`.
   - Call: `client.messages.create({model, max_tokens, system, messages, tools}, {signal})` using `@anthropic-ai/sdk`'s `Anthropic` client constructed with `{apiKey, baseURL, timeout: 75_000, maxRetries: 0}` — same pattern as the existing OpenAI client construction just above it in the file.
   - Response parsing: iterate `res.content` blocks — `type==='text'` blocks concatenate into `content`; `type==='tool_use'` blocks become `{id: block.id, name: block.name, args: block.input}` entries in `toolCalls`. Usage: `{promptTokens: res.usage?.input_tokens ?? 0, completionTokens: res.usage?.output_tokens ?? 0}`.
   - Errors: the existing generic `(err as any)?.status` extraction already works for Anthropic SDK errors (they expose `.status` the same way) — no special-casing needed there.
5. **Before treating this as done**, make one real test call (once `QWENCLOUD_API_KEY` is confirmed set and a model ID is confirmed) to verify the endpoint actually round-trips — this is a third-party proxy of Anthropic's wire format, not the real Anthropic API, so don't assume it's byte-perfect compatible without a live check.

---

## Context

Apex currently runs as a live, self-directing multi-agent system on Railway (`apex.donmatthews.live`, verified healthy today, 2026-07-26) backed by Postgres via Drizzle, a hand-rolled Express API + WebSocket server, and 13 always-on in-process agent loops. The user created a fresh Convex project (account `don-matthews-e412e`, project `APEX`, deployment `agile-tern-916`, production) and asked to replace the current backend with it.

Scope was narrowed through discussion to two explicit decisions:
1. **Full rewrite onto Convex's model** — task queue, goals, all 13 agent loops, memory, logs, messages, approvals, health, learning/predictive, and scheduled-job dispatch all move onto Convex (schema + queries/mutations/actions/crons). The Express server, Railway hosting for this logic, and the custom WebSocket are retired.
2. **One carve-out**: filesystem/shell/browser work (`packages/cicd-automation`'s git clone/pnpm install/test/lint/build, plus `tool-registry.ts`'s `readFile`/`writeFile`/`listDir`/`runShell`/`runInSandbox`/`browserCheck` and git/PR/deploy tools) cannot run inside Convex functions — no persistent disk between invocations, no arbitrary process/browser execution. This stays on a small standalone persistent worker.

This is a live system with real data (~10 pending tasks, active crons) and no staging environment, so the plan below is sequenced to build entirely alongside production with zero risk, then do one deliberate, rehearsed maintenance-window cutover — not a live rewrite-in-place.

**Sensitive credential handling**: the production deploy key (`prod:agile-tern-916|...`) was pasted directly in chat. It must only ever live in gitignored `.env`/Railway env vars, never committed or logged. Since it was exposed in a chat transcript, rotate it once the migration is stable and confirmed working (mention once, not a blocker).

## Package structure

New workspace package `packages/convex-backend/` (already covered by the `packages/*` glob in `pnpm-workspace.yaml`, no config edit needed):
```
packages/convex-backend/
  package.json          # "@workspace/convex-backend", exports ./api and ./dataModel
  convex.json
  convex/
    schema.ts
    agents.ts  tasks.ts  goals.ts  approvals.ts  memories.ts  logs.ts  messages.ts
    agentLoop.ts  llm.ts  toolRegistry.ts
    scheduledJobs.ts  jobHandlers/  health.ts  learning.ts  predictive.ts  multiapp.ts
    cicd.ts  crons.ts
  .env.local            # CONVEX_DEPLOYMENT=prod:agile-tern-916 (gitignored)
```
Run the Convex CLI with cwd = `packages/convex-backend` (`pnpm --filter @workspace/convex-backend exec convex dev|deploy`). Mark `convex/llm.ts` `"use node"` if the LLM SDK doesn't bundle cleanly in the default isolate runtime.

New workspace package `packages/cicd-worker/` — absorbs `packages/cicd-automation`'s shell-out logic (`ci-workspace.ts`, `test-runner.ts`, `linter-runner.ts`, `build-manager.ts`, `deployment-manager.ts`) plus the filesystem/shell/browser tools from `tool-registry.ts`, largely unchanged. Runs as a new, separate Railway service.

**Retired outright**: `packages/api-server` (Express + `websocket.ts`), `lib/db` (once schema is translated). **Ported as logic, not deleted-then-rebuilt**: the algorithms in `packages/agents`, `packages/background-jobs`, `packages/health-monitor`, `packages/learning-system`, `packages/predictive`, `packages/multiapp`, `packages/core` move into `convex/*.ts` with Drizzle calls swapped for `ctx.db`/`ctx.runQuery`/`ctx.runMutation`.

## Schema translation (`lib/db/src/schema.ts` → `convex/schema.ts`)

Rules, established once and applied across all 25 tables:
- `text('id').primaryKey()` / `serial('id')` → Convex's implicit `_id`; every FK-shaped column pointing at it becomes `v.id("otherTable")` (or `v.optional(...)`).
- `timestamp(...).defaultNow()` → Convex's `_creationTime`, **except** columns the app explicitly sorts/filters on and must preserve original values for (`logs.timestamp`, `healthMetrics.checkedAt`) — keep those as explicit `v.number()` epoch-ms fields.
- `jsonb(...)` → `v.any()` or a precise `v.object(...)` where the shape is stable (`metadata`, `context`, `toolArgs`).
- Nullable columns → `v.optional(...)`, **except** columns driving a "due" range query (`nextRetryAt`, `nextRunAt`) — default those to `0` rather than `undefined`, so one `.lte()` index scan catches both "never delayed" and "elapsed" uniformly.

Representative translations (apply the same pattern to the remaining 21 tables — goals, projects, approvals, memories, messages, researchedLeads, healthMetrics, componentHealth, jobExecutionLog, taskOutcomes, learningInsights, strategyRecommendations, performanceBaselines, pipelineRuns, testResults, lintResults, deployments, applications, applicationTasks, predictiveForecasts, riskAssessments, integrationSettings):

```ts
agents: defineTable({
  name: v.string(), role: v.string(), tier: v.number(),
  parentId: v.optional(v.id("agents")),
  status: v.union(v.literal("idle"), v.literal("thinking"), v.literal("acting"),
                  v.literal("blocked"), v.literal("done"), v.literal("error")),
  systemPrompt: v.string(), model: v.string(), provider: v.string(),
  lastActiveAt: v.optional(v.number()), metadata: v.optional(v.any()),
}).index("by_parent", ["parentId"]).index("by_role", ["role"]),

tasks: defineTable({
  goalId: v.optional(v.id("goals")), parentTaskId: v.optional(v.id("tasks")),
  title: v.string(), description: v.string(),
  status: v.union(v.literal("pending"), v.literal("in_progress"), v.literal("blocked"),
                  v.literal("awaiting_approval"), v.literal("done"), v.literal("failed"), v.literal("cancelled")),
  priority: v.number(), assignedAgentId: v.optional(v.id("agents")), createdByAgentId: v.optional(v.id("agents")),
  startedAt: v.optional(v.number()), completedAt: v.optional(v.number()), dueAt: v.optional(v.number()),
  nextRetryAt: v.number(), retryCount: v.number(), maxRetries: v.number(),
  result: v.optional(v.string()), errorMessage: v.optional(v.string()), context: v.optional(v.any()),
})
  .index("by_agent_status_retry", ["assignedAgentId", "status", "nextRetryAt"])
  .index("by_goal", ["goalId"]).index("by_parentTask", ["parentTaskId"]),

scheduledJobs: defineTable({ /* ... */ nextRunAt: v.number(), enabled: v.boolean(), status: v.string() /* union */ })
  .index("by_due", ["enabled", "status", "nextRunAt"]),

logs: defineTable({
  agentId: v.optional(v.id("agents")), taskId: v.optional(v.id("tasks")), goalId: v.optional(v.id("goals")),
  level: v.union(v.literal("debug"), v.literal("info"), v.literal("warn"), v.literal("error"), v.literal("thinking"), v.literal("acting")),
  message: v.string(), data: v.optional(v.any()), timestamp: v.number(),
}).index("by_agent_time", ["agentId", "timestamp"]).index("by_task_time", ["taskId", "timestamp"]),
```

Dequeue (replacing `packages/core/src/task-queue.ts:56-91`):
```ts
const due = await ctx.db.query("tasks")
  .withIndex("by_agent_status_retry", q => q.eq("assignedAgentId", agentId).eq("status", "pending").lte("nextRetryAt", Date.now()))
  .take(50);
const next = due.sort((a, b) => a.priority - b.priority || a._creationTime - b._creationTime)[0];
```
Index narrows candidates; final priority/createdAt sort happens in JS — fine at Apex's real scale (single/double-digit backlog per agent).

`memories.embedding` stays `v.optional(v.array(v.number()))` with the existing brute-force cosine similarity in `packages/core/src/memory.ts` ported as-is (table is small); Convex's native `vectorSearch` is an optional fast-follow, not day-one scope.

## Execution model redesign

**13 agent loops → 13 independent self-chaining actions, not one shared tick.** Each agent keeps its own concurrency/backoff/crash isolation (as today), replacing `BaseAgent.start()`'s `while(true)` + `setTimeout` with recursive `ctx.scheduler.runAfter`:
```ts
export const tick = internalAction({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const task = await ctx.runMutation(internal.tasks.dequeueFor, { agentId });
    if (!task) { await ctx.scheduler.runAfter(2000, internal.agentLoop.tick, { agentId }); return; }
    await ctx.runMutation(internal.agentLoop.recordTickHeartbeat, { agentId });
    await ctx.scheduler.runAfter(0, internal.agentLoop.runIteration, { taskId: task._id, agentId, iteration: 1 });
    await ctx.scheduler.runAfter(0, internal.agentLoop.tick, { agentId });
  },
});
```
`crons.ts` has one entry — a 60s watchdog checking each agent's `lastTickAt` heartbeat and re-kicking `tick` for any chain that went silent (covers an uncaught error killing a chain before it could reschedule itself). Sub-minute cadence (2s idle poll, 2s→30s error backoff) lives in the recursive `runAfter` pattern, not in declared `crons.interval` entries, which are reserved for the coarse 60s job-scheduler and health-poll ticks. **Confirm Convex's current cron/scheduler granularity limits against live docs at implementation time** — the recursive self-chaining pattern itself is solid, but don't hard-code an assumed second-level floor.

**Tool-loop is step-wise, not one long action.** Each action invocation does one LLM call + its tool executions, persists `history`/iteration count to a new `taskRuns` table, then either completes the task or schedules the next iteration via `runAfter(0, self, ...)`. This bounds runtime regardless of `maxIterations` (up to 30 today), gives the dashboard live per-iteration visibility, and — unlike today — survives a crash/redeploy mid-loop without losing conversation state, since `history` is persisted every iteration instead of held only in local variables.

**Approval gate becomes push-driven, replacing the busy-wait** (confirmed at `packages/core/src/base-agent.ts:497-509`: `while(Date.now()<deadline) { sleep(1000); check row }` inside one function call — this pattern cannot and should not port as-is to Convex):
1. On a tool call needing approval: write the `approvals` row, set `taskRuns.status = "awaiting_approval"`, **return** — no busy-wait.
2. `approvals.resolve` mutation (human clicks Approve/Reject) does its write, then in the same mutation calls `ctx.scheduler.runAfter(0, internal.agentLoop.resumeTask, { taskId })` — zero-latency wake-up instead of up-to-1s poll granularity.
3. The 5-minute timeout becomes one `ctx.scheduler.runAfter(5*60*1000, internal.approvals.expireIfStillPending, { approvalId })` set at request time, firing once instead of 300 sleep-and-check cycles.

**Worth a spike before hand-rolling the above from scratch**: `@convex-dev/agent` (durable threads, persisted messages, resumable tool execution) may cover a large part of this pattern already. Spend part of milestone M3 checking whether it fits Apex's specific delegate/dispatchSwarm/approval-gate semantics before committing to a full custom build.

**Actions can't touch `ctx.db` directly.** Split `tool-registry.ts`'s ~44 tools three ways: (a) pure computation/external-API tools — action logic mostly unchanged; (b) DB-only tools — become `internalQuery`/`internalMutation` called via `ctx.runQuery`/`ctx.runMutation`; (c) filesystem/shell/browser tools (`readFile`, `writeFile`, `listDir`, `runShell`, `runInSandbox`, `browserCheck`, `git_status`, `create_feature_branch`, `push_to_remote`, `create_pull_request`, `run_tests`, `run_lint`, `build_project`, `deploy_to_environment`, `rollback_deployment` — confirmed at `tool-registry.ts:115,139,166,182,377,715,1286-1439`) — dispatched to the CI/CD worker.

**JobScheduler's 60s poll** (`packages/background-jobs/src/job-scheduler.ts`) → one `crons.interval("scheduled-jobs-dispatch", {seconds:60}, ...)` querying the `by_due` index, fire-and-forget `runAfter(0, executeJob, {jobId})` per due job — same non-blocking shape as today. Port `CronParser`, the 6 job handlers, and the retry/backoff math directly into `convex/jobHandlers/*.ts`. The old in-memory `maxConcurrent=50` counter has no automatic equivalent — either trust Convex's platform-level scheduling or track an explicit `inFlightJobCount` field if a hard cap must be preserved.

## CI/CD worker ↔ Convex contract

New `externalJobs` table (jobType covering test/lint/build/deploy/rollback/git ops/shell/fs/browser; status `queued|claimed|running|succeeded|failed`; payload/result/error; requestingTaskId/agentId; claimedAt/timeoutAt).

- `enqueueJob` (internalMutation) — called instead of a category-(c) tool's old in-process body.
- `claimNextJob` (mutation, atomic claim) — called by the worker (short-poll via `ConvexHttpClient` every 1-2s, or reactive subscription via `ConvexClient` if straightforward).
- `reportJobResult` (mutation) — worker reports outcome; same mutation calls `runAfter(0, resumeTask, {taskId})` so the waiting agent wakes immediately.
- A cron sweeps jobs past `timeoutAt` to `failed`.
- **Separate credential from the deploy key**: the worker authenticates with its own `CICD_WORKER_SECRET` (set via `npx convex env set` + a normal Railway env var), not the Convex deploy key — the deploy key is for schema/function pushes only and should never live in the always-running worker process.

## Dashboard realtime migration

Migrate the ~13 consuming components directly to `ConvexReactClient`/`useQuery`/`useMutation` — no compatibility shim (the REST surface and WS event union are both small enough that a faithful wrapper would cost nearly as much as the real migration while blunting the actual benefit: live reactivity).

- `main.tsx` — wire `ConvexReactClient`/`ConvexProvider`.
- `lib/api.ts` and `hooks/useWebSocket.tsx` — deleted once consumers are migrated.
- `App.tsx` — `useQuery(['agents'], api.agents.list, {refetchInterval:15000})` → `useQuery(api.agents.list)` (live, no interval needed).
- `AgentNetwork.tsx`, `ApprovalQueue.tsx`, `HealthPanel.tsx`, `LearningPanel.tsx`, `LogStream.tsx`, `LoginScreen.tsx`, `MissionControl.tsx`, `MultiAppPanel.tsx`, `PipelinePanel.tsx`, `QuickChat.tsx`, `Settings.tsx`, `TaskBoard.tsx` — mostly mechanical swaps; `LogStream.tsx`/`MissionControl.tsx` need more rework since they currently reduce a raw WS event stream rather than querying a table.
- `LoginScreen.tsx` — keep the shared-admin-credential UX for now (swap bearer header for `ConvexReactClient.setAuth`); don't scope-creep into full Convex Auth/passkeys in this migration.
- Rough estimate: ~15-17 files, mechanical rather than redesign work.

## Rollout sequence

**Maintenance-window cutover, not dual-write** — confirmed as the right call: dual-write would require every write path across 13 loops + JobScheduler + health poll to correctly write both stores in sync, for a system with only ~10 pending tasks and no external user traffic besides the dashboard. Not worth the throwaway complexity and silent-divergence risk.

1. **Build alongside** (zero prod risk): scaffold `convex-backend`, write all schema/queries/mutations/actions/crons, build the CI/CD worker, migrate the dashboard — all against seed data, current Railway/Postgres untouched. Fix the hardcoded fallback secrets in `packages/api-server/src/middleware/auth.ts:18` and `routes/auth.ts` here too, independent quick win.
2. **Data migration rehearsal** (against copies of prod data, never touching prod): export script reads live Postgres read-only; importer remaps every old text-UUID/serial-int ID to a new Convex `Id<>` via an old-id→new-Id map, importing in dependency order (agents/projects → goals → tasks [two-pass for self-references] → approvals/memories/logs/messages/jobExecutionLog last). Consider keeping the old id as an indexed `legacyId` field for audit/rollback traceability. **This ID-remapping step is the highest-risk mechanical part of the whole migration** — rehearse it at least twice against real data copies with a verification script (row counts + referential integrity) before trusting it for the real window.
3. **Cutover**: scale the Railway service to 0 (simplest way to pause all 13 loops + scheduler + health poll at once) → run the rehearsed export → run the rehearsed import into production `agile-tern-916` (the one moment the prod deploy key is actually used for a real write — rotate it after) → run verification → deploy Convex functions if not already live → deploy `cicd-worker` as a new Railway service → deploy the Convex-backed dashboard → repoint `apex.donmatthews.live` if hosting changed → smoke test (all 13 agents idle/active not error; imported tasks visible; one task actually dequeues→runs→completes; a scheduled job fires; dashboard updates live with no WebSocket).
4. **Rollback plan, agreed before the window opens**: trigger = e.g. "agents not picking up tasks within 15 minutes, or >N% import verification failures." Mechanism: the old Railway service + Postgres are kept stopped-not-deleted for 1-2 weeks; rollback = restart the old service (its own boot-time recovery already resets stale `in_progress` tasks) + repoint DNS. Since Postgres is never written to during the migration, rollback loses at most whatever was created only in Convex during the smoke-test window.

## Milestones (implementation order)

- **M0** — Fix hardcoded fallback secrets (`packages/api-server/src/middleware/auth.ts`, `routes/auth.ts`).
- **M1** — Convex scaffolding: `packages/convex-backend/{package.json,convex.json,convex/schema.ts}`.
- **M2** — Core data-access: `convex/{agents,tasks,goals,approvals,memories,logs,messages}.ts` (ports `lib/db/src/schema.ts` + `task-queue.ts` + `memory.ts`).
- **M3** — Agent execution core: `convex/{agentLoop,llm,toolRegistry,crons}.ts` (ports `base-agent.ts`, `llm-client.ts`, `tool-registry.ts`; 13 role classes become config/data); spike `@convex-dev/agent` fit.
- **M4** — Background jobs/health/learning/predictive/multiapp: `convex/{scheduledJobs,jobHandlers/*,health,learning,predictive,multiapp}.ts`.
- **M5** — CI/CD worker: new `packages/cicd-worker/` absorbing `packages/cicd-automation/src/*`; `convex/cicd.ts`; new Railway service.
- **M6** — Dashboard migration (files listed above).
- **M7** — Data migration tooling: `scripts/{export-postgres-snapshot,import-into-convex,verify-migration}.ts`.
- **M8** — Cutover + retirement (old service stopped, not deleted; `lib/db`/`packages/api-server`/old agent classes/`packages/background-jobs`/old Postgres scheduled for later cleanup, not part of this migration).

## Critical files

- `C:\Apex\lib\db\src\schema.ts` — source of truth for schema translation
- `C:\Apex\packages\core\src\base-agent.ts` — agent loop + approval gate to redesign
- `C:\Apex\packages\core\src\task-queue.ts` — dequeue logic to port
- `C:\Apex\packages\core\src\tool-registry.ts` — 44 tools to split across action/mutation/worker
- `C:\Apex\packages\background-jobs\src\job-scheduler.ts`, `job-executor.ts` — scheduler to port to cron+actions
- `C:\Apex\packages\cicd-automation\src\ci-workspace.ts` — logic moving to the new worker as-is
- `C:\Apex\packages\dashboard\src\hooks\useWebSocket.tsx`, `src\lib\api.ts` — retired after dashboard migration
- `C:\Apex\packages\api-server\src\index.ts`, `websocket.ts` — retired outright

## Verification

- After M1-M4: `pnpm --filter @workspace/convex-backend exec convex dev` runs clean against `agile-tern-916`; write a throwaway seed script and confirm one agent's tick actually dequeues and completes a synthetic task end-to-end in the Convex dashboard's function logs.
- After M5: manually enqueue an `externalJobs` row and confirm the worker claims it, runs a real `pnpm test` against its scratch checkout, and reports back — check `reportJobResult` correctly wakes the waiting task.
- After M6: run the dashboard dev server against the seeded Convex deployment; confirm every panel renders live data with no console errors referencing the old WS/api.ts, and that an approval click resolves instantly (no ~1s delay) end-to-end.
- Before the real cutover (Phase 2 rehearsal): run the export/import/verify scripts against a copy of production data at least twice; verification script must report zero referential-integrity failures and matching row counts per table.
- After the real cutover: the smoke-test checklist in Rollout step 3, plus watching Convex's function logs for the first 30-60 minutes for unexpected error rates before considering the old Railway service safe to leave stopped long-term.
