# Capacity guardrails and verification

## Scope

This change reduces avoidable quota exhaustion; it does not manufacture provider
capacity, purchase entitlements, or promise unlimited operation on free quotas.
No daily dollar limit is increased and no provider is added.

- Each provider's locally eligible state is exposed under authenticated
  `GET /api/health/detail` → `llmCapacity.providers`: enabled/configured,
  access denied, upstream quota, local daily cap, pacing, budget block, or
  available. `available` means a local admission probe is permitted, **not** a
  claim that upstream entitlement has been verified. `lastSuccessAt` is an
  observed success since this process started, not fabricated historical uptime.
- Provider token reservations use `prepareProviderRequest(...).estimatedTotalTokens`,
  the same bounded history/output envelope sent to that provider. Do not reserve
  the untrimmed CEO allowance against Groq: that can falsely refuse a 3,536-token
  request as a 10,192-token request even with 8,000 tokens of real headroom.
- The same report drives the agent capacity latch. Disabled/unconfigured routes
  do not count as usable providers. Paid Qwen is not counted in `freeSlots`.
- Gemini defaults to the observed 20 daily requests for this free-tier
  project/model. More keys in the same project do not create more quota.
  An explicit `APEX_GEMINI_REQUEST_CAP` remains available for a separately
  verified entitlement. A daily-quota 429 waits for the next UTC day;
  ordinary rate limits continue to honor `Retry-After`.
- Qwen `AccessDenied.Unpurchased` responses produce a six-hour persisted
  exclusion. A valid catalogue response is not proof a model is purchased.
  Do not change billing or reset ledgers to bypass this refusal.

## Paid continuity and priority

`APEX_DAILY_SPEND_USD` remains the existing aggregate metered-spend ceiling.
Historic Qwen charges remain counted; excluding them would silently unlock
additional dollars. The admission API applies to OpenRouter paid continuity,
**not** Qwen's direct-plan route. Qwen retains separate activation/quota controls.

`APEX_SPEND_PRIORITY_RESERVE_PCT=25` keeps the last quarter of the existing daily
allowance out of background use. Operator/Command chat may consume it, within
its existing bounded concurrency/daily-request lane and full hard daily ceiling.
This is an operator-vs-background dollar reserve, **not** a claim that every
normal/revenue task has a new independent token quota or guaranteed SLA.

Immediately before dispatch, a synchronous reservation holds the maximum
completion cost (including the paid route's reasoning-output floor), plus a
conservative byte-sized prompt allowance. Concurrent calls in the **same worker
process** cannot all claim the last dollars. Successful calls book settled cost
once, then release their hold. Holds are idempotent and survive a UTC rollover
in memory. Transport timeouts/served-but-unreadable 5xx responses may still be
billed; their conservative reserved amount is booked rather than treated as free
retry money. Thus the local ledger can overstate an invoice after uncertain
failures; it is a conservative admission ledger, not an exact billing statement.

This is **not** a provider-enforced account-wide or distributed hard cap.
Other applications can share provider accounts, local pricing can drift, and
process death can lose active in-memory reservations. Do not horizontally scale
this money gate or describe it as global enforcement. Provider-side spending
limits and a distributed reservation ledger would be separate work.

The operator lane no longer appends an explicitly disabled paid route.

## Bounded investigation loops

After three identical non-polling read-only tool results, the existing nudge
asks the agent to decide or change approach. Another attempt at that warned
signature is stopped **before** executing. The task fails through its normal
bounded retry path with a concrete blocker; it is not silently marked complete.
Tool history remains paired. Polls, unknown actions, decisions/writes, changed
arguments, and changing observed outcomes before intervention remain exempt.
Existing task max-iterations, timeout, approvals, claim priorities and recovery
claim serialization remain in force.

## Production configuration

Persist reduced Gemini admission and pacing values in the service's export
source as well as its generated env file; do not regenerate the entire compose
stack just to change a few controls.

- `APEX_GEMINI_REQUEST_CAP=20`
- `APEX_GEMINI_REQUEST_PACING_BURST=5`
- `APEX_REQUEST_PACING_ENABLED=true`
- `APEX_SPEND_PACING_ENABLED=true`
- `APEX_SPEND_PRIORITY_RESERVE_PCT=25`
- Preserve the existing daily dollar cap, provider activation switches and
  background concurrency. Do not clear usage ledgers or active quota exclusions.

## Verification and bounded observation

The production CI gate runs the behavioral capacity-admission, atomic
reservation, held-transport paid-admission and BaseAgent loop-stop tests,
plus existing routing/request/cooldown/approval/checkpoint regressions.
`python3 scripts/apex_capacity_watch.py --self-test` is fixture-only.

After the exact reviewed commit is deployed and `/health.build.sha` matches,
run `scripts/apex_capacity_watch.py` once for the real baseline. A no-agent,
read-only hourly observation job with **72 repeats** records selected counters
under `/home/hermes/Operations/APEX/capacity-watch/`. No tokens, prompts or
credentials are persisted. Changed critical states, 80/90/100% budget bands,
and recoveries can be delivered without inference calls. Daily counter deltas
are computed only within the same UTC day; restart and rollover are not
misreported as negative spend. The final summary reports sampled outages and
stalls, not uninterrupted uptime or invented completed-task counts.

A scheduled 72-hour observation is pending evidence until its actual samples
exist. Do not claim the full operating-cycle acceptance criteria passed at
deployment time. Model access denial or insufficient funded capacity remains
an explicit blocker rather than a reason to increase spending automatically.

## Mission-first work-class split

`packages/core/src/work-class-budget.ts` splits the existing daily caps
(emergency request cap, `APEX_TOKEN_CAP_TOTAL`, `APEX_DAILY_SPEND_USD`) by work
class. It never raises a cap and only refuses lower-priority work earlier.

| Class | Detected by | Limit |
|---|---|---|
| operator | operator lane (Command chat) | none here (own lane) |
| mission | task context `missionId`/`campaignId`, "Execute mission:", `EXECUTE MISSION (` | existing caps only |
| internal | VERIFY / Delegation verdict / review / closeout / JUDGE / BLOCKER / Re-attempt … | `APEX_INTERNAL_LOOP_MAX_PCT` (25) of each cap, plus repeat backoff |
| background | other agent tasks | shares the non-mission pool |

internal + background together use at most `100 − APEX_MISSION_RESERVE_PCT`
(default 40%) of each cap. The same normalized internal task runs at most
`APEX_INTERNAL_LOOP_REPEAT_MAX` (2) times per `APEX_INTERNAL_LOOP_WINDOW_MINUTES`
(360). LLM calls with no task context (direct pipelines/API routes) are not
throttled. A share denial defers only that task (normal capacity requeue and
defer count). It never sets the workspace-wide capacity latch. Unused mission
reserve stays unused for that UTC day, by design.

### Mission work through non-mission pauses (follow-up)

- A provider capacity pause hit by an **internal/background** task sets a
  *non-mission* latch: only mission/campaign-linked tasks (`missionId`,
  `campaignId`, "Execute mission:", `EXECUTE MISSION (`) may be claimed until
  it clears. A pause hit by a **mission** task still sets the workspace latch.
  The operator lane never claims tasks and is unaffected.
- OpenRouter free-tier requests are counted per work class **per key**
  (`APEX_OPENROUTER_FREE_DAILY_REQUESTS`, default 1000; 0 disables). Internal
  work stops at 25% and non-mission at 40% of each key's quota, so the free
  quota is left for mission work.
- Internal-loop titles now include "Delegation results:", "REWORK:",
  "Autonomous branch/goal review", re-delegate/re-dispatch/re-open,
  ESCALATION, FINAL attempt, Gate …, QA gate/evidence, persona/peer review.

## Work-class shares apply to the paced (released) allowance

Request pools and paid spend are released gradually across the UTC day
(`pacingAllowance = burst + (cap - burst) * elapsed / day`). The work-class
shares (`APEX_MISSION_RESERVE_PCT`, `APEX_INTERNAL_LOOP_MAX_PCT`) are measured
against that **released** allowance, not the hard daily cap, so a herd of
internal loops released at the UTC rollover cannot consume the whole burst
before a mission task is claimed. Usage is booked on `paced:<provider>` and
`paced-spend` resources. Operator-lane traffic is never throttled by this
check. Counters are in-memory per UTC day and reset on process restart.
