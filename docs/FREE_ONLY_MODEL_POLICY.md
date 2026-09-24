# APEX free-roster policy with GLM continuity

The operator-selected OpenRouter roster remains free-only. Runtime continuity has one explicit paid exception: `z-ai/glm-5.3-flashx`, appended after the free/BYOK routes whenever the funded `OPENROUTER_API_KEY` is configured.

**Scope note (2026-09-23, ADR-017):** this free roster is no longer the first thing APEX tries overall. An operator-funded, governed Qwen3.8 Flash BYOK route (`qwen-dashscope-byok`) is now tried before it, falling through to the chain below only when Qwen is unconfigured, disabled, or failing. Everything in this document remains accurate for the free roster and FlashX continuity route specifically — "first" and "free-first" below mean first/free-first *within that scope*, not first in APEX's overall runtime order. See `AGENTS.md` ("LLM intelligence policy") and `docs/ARCHITECTURE_DECISIONS.md` ADR-017 for Qwen's placement and governance.

## Production model order

Automatic routing must use only OpenRouter model IDs ending in `:free`, in this order:

1. `nex-agi/nex-n2.5-mini:free` — primary agentic/coding model.
2. `nex-agi/nex-n2.5-pro:free` — harder reasoning/coding fallback.
3. `nvidia/nemotron-3-super-120b-a12b:free` — multi-agent/tool fallback.
4. `nvidia/nemotron-3.5-lightning:free` — high-throughput fallback.
5. `openrouter/free` — emergency free-model router, only with tool requirements preserved.
6. `nvidia/nemotron-3-ultra-550b-a55b:free` — last-resort deep/long-context fallback while its availability is degraded.

MiniMax M3 Free is not in the production chain until its current free endpoint/tool behavior is directly re-verified. DeepSeek V4 Flash 0731 is retired. Arbitrary paid models cannot be persisted into the operator roster; `z-ai/glm-5.3-flashx` is the sole automatic paid runtime continuity exception.

## Account capacity

The operator has three independent OpenRouter accounts that have each previously had at least $10 in credits added. OpenRouter documents that this raises the `:free` allowance to 1,000 requests/day per qualifying account, with 20 requests/minute per account. Treat the three credentials as three independent daily capacity buckets and balance requests across them.

Expected nominal ceiling: about **3,000 free requests/day**, subject to OpenRouter/provider availability. The workspace request cap defaults to **2,900** so 100 requests of headroom remain for traffic this process cannot see. Failed requests count against the daily allowance, so retries must be bounded.

Three live API keys are not automatically three accounts. `/health` `providerCredits.uniqueAccounts` is the number of distinct OpenRouter users those keys belong to; `sharedQuota: true` means two keys share one 1,000/day bucket. Optional management keys (`OPENROUTER_MGMT_KEY*`, created at https://openrouter.ai/settings/management-keys) list an account's inference keys so APEX can prove membership. They cannot infer and they never auto-create or rotate production credentials.

## Custom persisted policies

A valid production policy may contain only `:free` IDs or exactly `openrouter/free`. Custom policies use the `openrouter-free-policy` gateway with the **same free-account credential roster** as automatic routing. They never persist or select an arbitrary paid model. After the free-policy gateway and independent BYOK routes, runtime may still append the dedicated GLM FlashX continuity provider.

OpenRouter's native `models` fallback array is capped at 3 entries per request. Larger free rosters are truncated to that ceiling for a single gateway attempt; the automatic six-route chain remains available when no custom policy is set.

`openrouter/free` is only used with `require_parameters` when APEX is sending tools, so the free router cannot pick a model that cannot execute required function calls.

## Account rotation and fail-closed pause

Credentials are tried least-used-account first (fingerprint of the key, not the env var name). Multiple env names holding the same key collapse to one retry bucket. A 429/402 on one qualifying account cools that account and moves to another before abandoning the current free model. Failed attempts count against the daily allowance, so retries are bounded. When every free account/model is unavailable, APEX advances to GLM FlashX when its funded credential is usable. A capacity pause occurs only when no usable route remains. Account cooldowns continue to gate free-account selection and provider reliability backoff.

## Hard invariants

- The persisted operator roster remains free-only (`:free` or exactly `openrouter/free`).
- `z-ai/glm-5.3-flashx` is the sole automatic paid runtime continuity exception and remains last.
- FlashX is eligible whenever the funded OpenRouter credential is configured.
- APEX does not apply daily-dollar, free-request, token, emergency-request, model-specific dispatch-delay, forced-reasoning, or free-route history-trimming limits to FlashX.
- Provider/account limits, billing, retry-after behavior, circuit breakers, cooldowns, request timeouts, authentication, tool authorization, approval gates, and irreversible-action governance remain authoritative.
- Free-account rotation and free/BYOK capacity are attempted before FlashX.
- Frontend labels, backend defaults, agent metadata, tests, environment examples, and operator documentation must report the same free-roster + GLM continuity chain, understood as sitting behind the separately governed Qwen primary route (ADR-017).

## Verification gate

Before merge/deploy, CI must prove that the selectable persisted provider catalog remains free-only, Nex N2.5 Mini Free remains first *within the free chain* (Qwen precedes the whole free chain per ADR-017), GLM FlashX is the sole paid *continuity* (unrestricted, last-resort) exception and is last, APEX capacity governors do not veto FlashX, all configured free credentials participate in least-used-account rotation, and model-policy UI/API cannot persist an arbitrary paid model.