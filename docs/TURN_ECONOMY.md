# Turn Economy foundation

This extends the existing request ledger and free-first routing. It does not
change the selected model roster, paid continuity policy, or production settings.

## Opt-in work bundles

Set `APEX_WORK_BUNDLES_ENABLED=true`, then submit compatible background work via
`TaskQueue.enqueue` with `context.bundleKey` set to the same nonempty string.
The collection window is `APEX_BUNDLE_WINDOW_MS` (default 10 seconds, bounded
0–60 seconds; zero disables). The first enqueue fixes the deadline; later work
never extends it. Existing queue polling can add latency after that deadline.

Matching requires the same assigned agent, creator, goal, parent, priority and
**entire remaining context**, including project/campaign and permission metadata.
Each bundle holds at most 20 items and 12,000 description characters. Overflow
opens another bundle. Interactive/urgent tasks, priorities 1–2, executor tasks,
checkpoint continuations and deterministic reads bypass bundling.

Enqueues are serialized per scope with a Postgres transaction advisory lock.
Candidate rows are locked against claims/cancellations. A claimed/previously
started task is never appended to. Collection uses the existing durable
`next_retry_at`, so restarts preserve the window without timers or new tables.

**Contract:** opting in requests one shared task and result for these items.
Every enqueue can return the SAME task ID. Original item IDs and descriptions
remain in the bundle. The bundle is the approval, cancellation, checkpoint and
retry unit. Do not opt in producers that require independent task results or
cancellation. Already-created tasks are never merged. No current producer is
automatically opted in; enable only after reviewing its shared-result contract.
The agent is instructed to report an outcome for each item, including failures.

Example (same scope/context for each enqueue):

```ts
await queue.enqueue({
  title: 'Review lead A', description: 'Evaluate the supplied evidence for lead A.',
  goalId: goal.id, context: { bundleKey: 'qualification', projectId, campaignId },
});
```

## Deterministic batch read

Sales has `campaign_snapshot`, a read-only tool that retrieves up to 50 email
campaigns and queued counts in two database queries. It returns missing IDs
explicitly and never sends messages. Other roles do not gain this permission.

An explicitly scheduled Sales task can use:

```json
{"deterministicRead":{"tool":"campaign_snapshot","args":{"campaignIds":["campaign-id"]}}}
```

Place this in the task's context. The agent checks its tool allowlist, validates
arguments through the registry and saves the real result without any LLM or
memory lookup. Approval-required agents cannot use this shortcut. Unsupported
operations fail closed. The existing worker capacity latch still governs queue
admission; the shortcut does not create a separate always-on worker.

## Account quotas and measurements

`APEX_REQUEST_CAPS` is enforced using the strictest positive configured cap across
all credentials confirmed by the provider probe to share an account. An uncapped
sibling cannot escape the account cap. Account-wide usage, cap percentage and
pacing agree in both enforcement and dashboard rows. Unknown identities remain
separate; this code does not invent account ownership or free allowance.

`APEX_ACCOUNT_REQUEST_RATE_PER_MIN` bounds attempts per known account across its
credentials (default 15; zero disables). Workspace RPM and daily limits still
apply. Failed attempts consume quota. Existing synchronous check/reserve ordering
protects concurrent calls in one process. **Quota admission remains process-local**;
Postgres persists usage but does not yet provide a cross-process reservation lock.
Multiple inference runtimes must not be treated as having one atomic shared cap.
Key rotation/unknown account identities and requests outside APEX also require
provider reconciliation. Rolling minute counters are process-local and reset on
restart, as the existing workspace limiter does.

Authenticated `/api/spend` and the spend panel expose account rows and Turn Economy
counters. These new productivity counters are explicitly labelled **this process**
and reset on restart or UTC rollover. They count actual upstream attempts,
successful/failed tool executions, completed tasks, deterministic completions and
items appended to bundles. Successful tools are not a quality/usefulness score;
items coalesced are not a claimed count of LLM requests saved. Compare completion
quality separately before expanding rollout. No prompt, result or key is stored
in these counters.

## Validation / rollout

Run `scripts/verify-turn-economy.ts`, `scripts/verify-account-quotas.ts`, existing
request/routing/backpressure/model-intelligence guards, production typechecking
and the dashboard build. The `turn-economy-postgres` CI job runs
`scripts/verify-turn-economy-postgres.ts` against disposable local PostgreSQL,
including 40 concurrent enqueues, competing claims, real snapshot queries and
an agent completion with LLM/memory calls forbidden. It requires the explicit
`APEX_TURN_ECONOMY_TEST_DATABASE_URL` and rejects non-local/non-test targets.
Keep bundling disabled initially to collect a baseline.
Then opt in one compatible producer and compare upstream requests, task outcomes
and human corrections. Revert by disabling bundling; already queued bundles
retain their item list and drain normally. No database migration is required.
