# Provider escalation corrective actions

Tracked from the 2026-09-16 escalation stream.

## Immediate

- Do not rotate or replace OpenRouter credentials solely because `health_check` says providers are `ok` while an agent failed. That check is configuration-presence only.
- Correlate any provider error to the running build SHA and active provider roster before acting on it.
- Treat old task failures that name providers absent from the current routing chain as historical until a current execution reproduces them.
- Use the deterministic `stalled_work_recovery` job for provider-outage recovery; do not create an LLM-dependent recovery task.

## Engineering

- Make the agent-facing `health_check` expose the same distinction already available on `/health`: configuration presence versus non-spending capacity/backpressure state.
- Rename provider detail labels from `ok` to `configured` when no live probe occurs.
- Add regression coverage proving configured credentials can coexist with paused/unavailable capacity without being described as live-healthy.
- Deduplicate repeated human escalations for a single unresolved outage signature.
