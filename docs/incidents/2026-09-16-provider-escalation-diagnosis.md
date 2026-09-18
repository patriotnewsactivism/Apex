# 2026-09-16 provider escalation diagnosis

## Status

The escalation stream that reported a systemic provider-chain outage mixes three different kinds of evidence and should not be treated as proof of one current credential failure.

### 1. `health_check` does not live-probe LLM providers

`packages/health-monitor/src/index.ts` explicitly avoids live LLM calls. Its LLM provider check reports whether provider credentials/configuration are present. A provider row rendered as `ok` therefore means **configured**, not **currently accepting inference**.

This distinction matters because the escalation stream treated `health_check` provider `ok` values as contradictory evidence that delegated execution should work. They are not equivalent signals.

### 2. Current `main` no longer contains several providers named by the escalation

The current automatic request path in `packages/core/src/llm-client.ts` is free-first and uses the current OpenRouter free chain, with only the explicitly enabled, spend-bounded DeepSeek paid continuity rung. Current routing guards explicitly keep MiniMax M3 Free and the old GPT-OSS paid gateway out of the automatic chain.

Therefore errors naming retired routes such as `openrouter-gpt-oss-120b-paid`, `openrouter-grok-4-6-bedrock`, or `openrouter-minimax-m3` must be timestamped and correlated to the exact running build before they are classified as a current routing defect. They may be historical task errors, an older deployed build, or another component's provider chain.

### 3. Provider-outage recovery on current `main` is already database-only

`StalledWorkRecoveryJob` directly reads failed task rows, filters only recoverable provider-chain failures, and conditionally requeues them with bounded backoff. It does not require an LLM call to inspect or mutate the backlog.

Any escalation saying the scheduled provider-outage recovery itself cannot run because a delegated child lacks an LLM credential is therefore not describing the current `StalledWorkRecoveryJob` implementation. Before creating another recovery task, identify which code path actually produced that child task and its `scheduledJobId`/task context.

## Required remediation

1. Change LLM health wording from `ok`/`missing` to `configured`/`missing` anywhere no live probe occurs. Never describe key presence as live provider health.
2. Add a structured, non-spending capacity signal to `health_check` using the existing in-memory routing/backpressure state (`llmCapacityAvailableNow`, provider cooldown/backpressure, request/token pacing). Label it separately from configuration presence.
3. Include the running build SHA and current active provider names in provider-outage escalations. If an error names a provider that is not in the running build's active chain, classify it as historical/stale until proven otherwise.
4. Keep provider-outage recovery deterministic/database-only. Do not implement outage recovery by delegating an LLM task whose success depends on the outage being over.
5. Suppress duplicate human escalations for the same outage signature while an existing incident is open. A later successful task or restored capacity signal should close/reclassify historical provider failures instead of repeatedly asking for credentials.
6. Add a regression guard covering the exact failure mode: configured credentials + unavailable/cooldown capacity must never be summarized as `providers healthy`.

## Verification criteria

- Fast `health_check` performs no paid/live LLM request.
- Its output clearly distinguishes `configured` from `capacityAvailableNow`.
- A simulated all-provider cooldown returns configured providers but degraded/paused capacity.
- A simulated missing-key state returns missing configuration distinctly.
- `StalledWorkRecoveryJob` can requeue a qualifying failed task in a test with no LLM credential configured.
- An escalation generated from an old task error cannot cite a retired provider as a current provider without also proving the running build still contains that provider.
