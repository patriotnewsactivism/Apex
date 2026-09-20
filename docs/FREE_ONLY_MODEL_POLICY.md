# APEX free-first OpenRouter policy

The operator-selected production roster remains free-only, but runtime continuity now has one explicit paid exception: `z-ai/glm-5.3-flashx`. APEX tries the free/BYOK routes first and appends FlashX as the final continuity route whenever the funded OpenRouter credential is configured. `APEX_PAID_FALLBACK=off` is the emergency kill switch.

## Production model order

Automatic routing must use only OpenRouter model IDs ending in `:free`, in this order:

1. `nex-agi/nex-n2.5-mini:free` — primary agentic/coding model.
2. `nex-agi/nex-n2.5-pro:free` — harder reasoning/coding fallback.
3. `nvidia/nemotron-3-super-120b-a12b:free` — multi-agent/tool fallback.
4. `nvidia/nemotron-3.5-lightning:free` — high-throughput fallback.
5. `openrouter/free` — emergency free-model router, only with tool requirements preserved.
6. `nvidia/nemotron-3-ultra-550b-a55b:free` — last-resort deep/long-context fallback while its availability is degraded.

MiniMax M3 Free is not in the production chain until its current free endpoint/tool behavior is directly re-verified. DeepSeek V4 Flash 0731 is retired. No paid model may be added to the operator-persisted roster; `z-ai/glm-5.3-flashx` is the single runtime continuity exception.

## Account capacity

The operator has three independent OpenRouter accounts that have each previously had at least $10 in credits added. OpenRouter documents that this raises the `:free` allowance to 1,000 requests/day per qualifying account, with 20 requests/minute per account. Treat the three credentials as three independent daily capacity buckets and balance requests across them.

Expected nominal ceiling: about **3,000 free requests/day**, subject to OpenRouter/provider availability. The workspace request cap defaults to **2,900** so 100 requests of headroom remain for traffic this process cannot see. Failed requests count against the daily allowance, so retries must be bounded.

Three live API keys are not automatically three accounts. `/health` `providerCredits.uniqueAccounts` is the number of distinct OpenRouter users those keys belong to; `sharedQuota: true` means two keys share one 1,000/day bucket. Optional management keys (`OPENROUTER_MGMT_KEY*`, created at https://openrouter.ai/settings/management-keys) list an account's inference keys so APEX can prove membership. They cannot infer and they never auto-create or rotate production credentials.

## Custom persisted policies

A valid production policy may contain only `:free` IDs or exactly `openrouter/free`. Custom policies use the `openrouter-free-policy` gateway with the **same free-account credential roster** as automatic routing. They never switch the persisted roster to `OPENROUTER_PAID_KEY_ENVS`. After that free-policy gateway and the independent BYOK routes, runtime may still append the separate GLM FlashX continuity provider.

OpenRouter's native `models` fallback array is capped at 3 entries per request. Larger free rosters are truncated to that ceiling for a single gateway attempt; the automatic six-route chain remains available when no custom policy is set.

`openrouter/free` is only used with `require_parameters` when APEX is sending tools, so the free router cannot pick a model that cannot execute required function calls.

## Account rotation and fail-closed pause

Credentials are tried least-used-account first (fingerprint of the key, not the env var name). Multiple env names holding the same key collapse to one retry bucket. A 429/402 on one qualifying account cools that account and moves to another before abandoning the current free model. Failed attempts count against the daily allowance, so retries are bounded. When every free account/model is unavailable, APEX advances to GLM FlashX when that route is configured and enabled. A capacity pause occurs only when no usable route remains. Account cooldowns still gate free-account selection and provider backoff.

## Hard invariants

- The operator-persisted roster stays free-only (`:free` or exactly `openrouter/free`).
- `z-ai/glm-5.3-flashx` is the only automatic paid runtime continuity route.
- FlashX is enabled by default when the funded OpenRouter key is configured; `APEX_PAID_FALLBACK=off` disables it.
- APEX does not apply daily-dollar, request-count, token, model-specific dispatch-delay, or forced-reasoning admission limits to FlashX.
- Provider/account limits, retry-after behavior, circuit breakers, credential cooldowns, approval gates, and security controls remain authoritative.
- A 429/capacity failure on free traffic should move to another qualifying free account/model before using continuity.
- Frontend labels, backend defaults, agent metadata, tests, `.env.example`, and operator documentation must report the same free-first + GLM continuity chain.

## Verification gate

Before merge/deploy, CI must prove that the selectable provider catalog remains free-only, Nex-N2.5-Mini Free remains first, GLM FlashX is the sole paid continuity exception and is last, all configured free credentials participate in least-used-account rotation, and model-policy UI/API cannot persist an arbitrary paid model.