# APEX zero-cost OpenRouter policy

Effective immediately, APEX must fail closed to **no inference** rather than spend money. This is an operational constraint, not a preference.

## Production model order

Automatic routing must use only OpenRouter model IDs ending in `:free`, in this order:

1. `nex-agi/nex-n2.5-mini:free` — primary agentic/coding model.
2. `nex-agi/nex-n2.5-pro:free` — harder reasoning/coding fallback.
3. `nvidia/nemotron-3-super-120b-a12b:free` — multi-agent/tool fallback.
4. `nvidia/nemotron-3.5-lightning:free` — high-throughput fallback.
5. `openrouter/free` — emergency free-model router, only with tool requirements preserved.
6. `nvidia/nemotron-3-ultra-550b-a55b:free` — last-resort deep/long-context fallback while its availability is degraded.

MiniMax M3 Free is not in the production chain until its current free endpoint/tool behavior is directly re-verified. Paid DeepSeek, GPT-OSS, Grok/Bedrock, or any other billable model must never be reached automatically while zero-cost mode is enabled.

## Account capacity

The operator has three independent OpenRouter accounts that have each previously had at least $10 in credits added. OpenRouter documents that this raises the `:free` allowance to 1,000 requests/day per qualifying account, with 20 requests/minute per account. Treat the three credentials as three independent daily capacity buckets and balance requests across them.

Expected nominal ceiling: about **3,000 free requests/day**, subject to OpenRouter/provider availability. Failed requests count against the daily allowance, so retries must be bounded.

## Hard invariants

- No silent paid fallback.
- No non-`:free` model in the automatic production chain, except the special `openrouter/free` free router.
- A 402, exhausted balance, or paid-provider availability must not trigger paid inference.
- A 429/capacity failure should move to another qualifying account before burning repeated retries on one account.
- Provider/model failure should advance to the next free model with bounded retry/circuit-breaker behavior.
- When every free account/model is exhausted or unavailable, put the workforce into a capacity-pause state and expose that state in `/health` and the dashboard.
- Frontend labels, backend defaults, agent metadata, API validation, tests, `.env.example`, and operator documentation must all report the same chain.

## Verification gate

Before merge/deploy, CI must prove that the automatic provider catalog is free-only, the first model is Nex-N2.5-Mini Free, no paid provider is reachable from automatic routing, all configured free credentials participate in least-used-account rotation, and model-policy UI/API cannot accidentally re-enable a paid fallback.