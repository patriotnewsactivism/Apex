# Repository Guidelines — APEX
_Last verified against current source, production health, and CI: 2026-09-24._

This is the canonical instruction file for AI coding tools and contributors working in this repository. Keep it synchronized with current source and live production evidence. Do not create per-tool instruction copies that can drift.

## Truth hierarchy

When sources disagree, use this order:

1. direct live production evidence and current source code;
2. this `AGENTS.md` file;
3. `docs/ARCHITECTURE_DECISIONS.md` and `docs/PRODUCTION_OPERATIONS.md`;
4. `README.md` and `docs/deploy-provenance.md`;
5. `CHECKLIST.md` and `ROADMAP.md`;
6. historical plans, dated notes, screenshots, and old deployment files.

Never guess a project ID, service name, region, secret name/value, database target, live SHA, or deployment state. If the exact value cannot be established from a trusted source, stop and report what is missing.

If stale documentation is discovered while doing real work, fix it in the same work item when practical. Historical material may remain for context only when it is clearly labeled historical and cannot be mistaken for current instructions.

## Current production runtime

APEX itself runs on **Railway** — project `APEX`, service `apex-backend` — behind:

`https://apex.donmatthews.live`

The cutover from Google Cloud Run happened on 2026-09-14/15 and is described in `docs/HOSTING_MIGRATION.md`. Railway builds the repository `Dockerfile` per `railway.toml`, health-checks `/health`, and deploys itself from `main`; there is no deployment workflow in front of it.

Google Cloud Run is a **retired** production host. Billing is disabled on project `apex-503709`, so it serves nothing and cannot even accept an image push. The old GitHub deploy workflow has been removed; `packages/cicd-automation/src/cloud-run-deployer.ts` and `cloudbuild.apex.yaml` remain only as a deliberately gated migration-back implementation behind `APEX_DEPLOY_ENABLED`, and must not be enabled while billing is off. The former AWS Lightsail/CodeBuild deployment path is retired and must not be restored. Vercel, Render, and other platforms may still appear as deployment targets for client projects APEX manages, and the React dashboard has a Vercel project of its own (`don-matthews/apex`); none of them is the APEX control-plane host. That Vercel project posts the GitHub commit status named `Vercel`. `vercel.json` must build `@workspace/dashboard` only — never root `pnpm run build` / `typecheck:production`. Railway Wait for CI gates on GitHub Actions `production-checks`, not the Vercel status.

A production release is complete only after all of these are true:

1. the intended reviewed commit is on `main`;
2. CI `production-checks` is green for that code state;
3. Railway service `apex-backend` reports Success for that commit (GitHub status `APEX - apex-backend`);
4. `https://apex.donmatthews.live/health` reports the expected `build.sha` (HTTP 200); authenticated `GET /api/health/detail` reports a healthy `taskQueue.verdict`;
5. the changed feature is smoke-tested through its real production path.

Railway Wait for CI is enabled (`checkSuites=true` on the `main` GitHub trigger). A red `production-checks` run is skipped. Treat a red CI run after a live SHA as an incident. The GitHub `Vercel` status is the dashboard static build and is not a Railway gate.

The retired Cloud Run migration-back code (`packages/cicd-automation/src/cloud-run-deployer.ts` and `cloudbuild.apex.yaml`) remains in the repository, but the old GitHub deploy workflow is gone. It is gated behind `APEX_DEPLOY_ENABLED` and must not be re-enabled while billing is off on project `apex-503709`.

`deploy_to_environment` and rollback remain hard-gated. See `docs/PRODUCTION_OPERATIONS.md`, `docs/HOSTING_MIGRATION.md`, and `docs/deploy-provenance.md`.

Runtime health and the autonomous provenance gate use the same deployed commit resolver: a known `APEX_BUILD_SHA`, then Railway's injected `RAILWAY_GIT_COMMIT_SHA`. Empty/whitespace/`unknown` build placeholders do not mask the Railway commit. The image pins `WORKSPACE_ROOT` and `APEX_CANONICAL_REPO_ROOT` to `/app`; outside the image the gate discovers the containing pnpm workspace when no canonical root is specified. Missing commit/artifact/database/audit evidence still blocks writes; fix the reported precondition instead of bypassing provenance. `health_check` and the API health monitor use local LLM routing capacity (including budgets, pacing and cooldowns) in addition to key presence. `configured` means a key exists; capacity unavailable/unknown reports degraded without issuing an inference call.

## What APEX is

APEX is a persistent hierarchical autonomous workforce, not a request/response chatbot.

```text
APEX CEO
├── CTO -> Lead Developer -> Frontend / Backend / DevOps / QA
└── COO -> Lead Researcher / Sales / Marketing / Customer Success
QA Director -- independent quality/oversight role
```

The production workforce is 13 agents. Generic specialist classes may exist in source but are not part of the instantiated production organization unless the workforce definition changes explicitly.

An optional Cartesia sales-agent webhook surface lives at `/api/cartesia` (implementation and configuration in `docs/CARTESIA_SALES_TOOLS.md`). It is separate from APEX's Telnyx outbound transport; exposing its routes does not mean the Cartesia agent, tools, calendar, or phone transfer has been configured or tested in production. The Cartesia tool bearer secret and call-event webhook secret are independent and required. APEX outbound caller ID remains `+18329757665`; owner escalation destination is `+18328804970` when configured. Cartesia availability and consultation booking go through the calendar booking service. They do not call the Cal.com bookings API.

### Calendar booking

Google Calendar is the master. `packages/core/src/calendar/` is the only booking path: free/busy across the busy calendars chosen in settings, then working hours, buffers, no-book blocks, the daily cap, and minimum notice (`America/Chicago` unless settings say otherwise), then a short slot hold, then the Google event. Holds use `calendar_slot_holds_no_overlap` (`btree_gist`) so two workers cannot keep the same time. Which Google account is connected, and which calendars count as busy, are settings and env (`APEX_GOOGLE_OAUTH_*`, `APEX_CALENDAR_BUSY_IDS`). Do not hardcode an account.

Events are created with `sendUpdates=none`. Invites, reschedule notices, and cancellation notices to outside people are staged in the send safeguard (`calendar/invite-gate.ts`): a `calendar` recipient in Pending Sends under story key `calendar:<organization>`, so the operator code applies at 5 or more invites in 24 hours. Nothing reaches the attendee until the operator confirms twice and releases it; the `google_calendar_invite` transport then re-runs `assertSendAllowed` and tells Google to notify (`sendUpdates=all`, or delete with `all` for a cancellation). A released invite for a meeting that has since been cancelled is not sent. The outbound kill switch blocks both staging and delivery, and do-not-contact blocks the booking. Public booking links stay on Cal.com (`APEX_CAL_API_KEY`, `APEX_CAL_EVENT_TYPE_ID`, `APEX_CAL_WEBHOOK_SECRET` on `POST /api/calendar/cal/webhook`). Google appointment schedules are a manual fallback and have no API. Agent tools are `calendar_get_agenda`, `calendar_find_slots`, and `calendar_request_booking`. Timeline rows are appended to `interactions` (`TODO(feat/crm)` until that writer exists). Tokens are encrypted with `APEX_ENCRYPTION_KEY`.

### Virtual specialist departments

APEX also has a **virtual specialist layer** in `packages/core/src/specialists/`. These specialists are not additional always-on workers and do not change the 13-agent production organization. They are named, department-scoped execution profiles routed through an existing standing role using task context (`specialistId`).

The specialist layer exists so APEX can maintain real departments — Revenue & Sales, Marketing & Growth, BuildMyBot Product, Newsroom & Investigations, Video & Media, Publishing, Legal Research & Records, Engineering & Reliability, Business Operations, Executive Command, and APEX Control Plane — without multiplying baseline worker/model cost.

Rules:
- A specialist profile changes task focus and operating instructions only; it grants no extra tools, credentials, permissions, or approval bypass.
- `dispatchSpecialist` routes one specialist to its standing parent role.
- `dispatchDepartment` activates a department's default or explicitly selected specialist roster as durable tasks.
- Revenue-facing department work should optimize for measurable pipeline, conversion, retained customers, and revenue rather than raw activity.
- External messages/calls, public publishing, financial actions, production changes, and other governed effects retain the normal approval/tool policy.
- Do not describe the specialist profiles as separate persistent workers. The persistent production workforce remains 13 agents.

Tasks are expected to progress through real delegation, tools, verification, learning, and measurable completion. Announcing intended work is not completion.

## Stack and conventions

- Package manager: **pnpm 11.19.0** workspace. Do not introduce npm/yarn/bun lockfiles.
- Runtime/tooling target: Node.js 22.
- TypeScript strict mode; ESM via `tsx`. Use `import`, not CommonJS `require()` in production TypeScript.
- Container runtime: Docker on Railway (`railway.toml` + repository `Dockerfile`). Google Cloud Run is the retired rollback host.
- Database access: Postgres through Drizzle ORM and `DATABASE_URL`; deployments may use Supabase-hosted Postgres, but runtime database access is not blanket management-plane authorization.
- Schema bootstrap/migration logic must remain idempotent and reviewable.
- The old SQLite runtime and retired Railway Postgres are not production stores and must not be revived.
- `packages/convex-backend` remains experimental. Production Convex autonomy is disabled unless `APEX_CONVEX_AUTONOMY_ENABLED=true` is an intentional, reviewed architecture change.

## Database and management-plane boundary

Treat data-plane access and management-plane access as different permissions.

A runtime `DATABASE_URL`, service-role credential, connector token, or other application credential does **not** authorize autonomous project administration, schema changes, migrations, destructive SQL, credential rotation, or provider-management actions.

Before any production database or Supabase management action:

1. identify the exact APEX project/target;
2. verify the credential belongs to that target and is intended for that operation;
3. obtain explicit approval for schema/destructive/management changes;
4. capture a reversible migration or rollback plan where applicable;
5. verify the result against the intended environment.

Do not reuse credentials from another application or project. Do not infer that similarly named projects are interchangeable.

## LLM intelligence policy — OpenRouter production

`packages/core/src/llm-client.ts` is the request-path source of truth. `packages/core/src/model-routing.ts` defines the operator policy contract, `packages/core/src/model-intelligence.ts` owns evidence-based ranking, and `packages/core/src/model-execution-context.ts` plus `packages/core/src/instrumented-base-agent.ts` provide concurrency-safe task attribution to normal LLM calls. Every production APEX unit uses this centralized routing client. The normal order is OpenRouter free models **first**, then optional direct Groq/Gemini BYOK capacity, then the paid continuity model `deepseek/deepseek-v4-flash-0731` last, served by two providers: OpenRouter (`openrouter-deepseek-v4-flash-paid`, funded `OPENROUTER_API_KEY_4`, `provider.sort: latency`) and Nous Portal (`nous-deepseek-v4-flash-paid`, `NOUS_API_KEY`). This is a 2026-10-05 operator decision (ADR-020): the QwenCloud Token Plan is exhausted, so Qwen is removed from the automatic chain (the `qwen-dashscope-byok` spec stays defined and unused; reinstating it needs a new operator decision), and paid load is split so neither provider takes it all. `requestProviderOrder()` puts Nous first on 9 requests in 10 and OpenRouter first on the tenth (operator decision, same day: Nous is the cheaper host), so paid traffic splits about 90/10 and each is the other's immediate fallback; a route in cooldown or credit exclusion is skipped and the other carries the load. `getProviderOrderForRole()` stays deterministic for health and guards. Both paid routes are **unrestricted**: off unless `APEX_PAID_FALLBACK_ENABLED=true` and at least one of the two credentials is configured, and they bypass APEX spend, token, request, emergency-cap, and pacing governors. `APEX_PAID_FALLBACK_ENABLED` is the operator's single switch for both: unset or `false` removes both routes and leaves APEX free-only, parking the workforce at capacity exhaustion rather than spending further. Upstream OpenRouter/Nous billing/rate limits, error cooldowns, tool authorization, and approval policy remain authoritative. Do not add further paid providers or models without a new operator decision. ("FlashX" in older text and identifiers means this paid continuity route.)

With no valid operator policy, the reviewed production fallback is:

1. `nvidia/nemotron-3-super-120b-a12b:free`
2. `nvidia/nemotron-3.5-lightning:free`
3. `openrouter/free` (tool requirements preserved)
4. `nvidia/nemotron-3-ultra-550b-a55b:free`

The two `nex-agi/nex-n2.5-*:free` rungs are gone (2026-10-11): OpenRouter
withdrew their free tier, so every dispatch 404'd while the pre-dispatch
reservation kept charging it to the daily OpenRouter allowance.

Nemotron 3 Super Free is the primary model for the entire workforce unless an explicitly supported role-level free-model policy says otherwise. MiniMax M3 Free is not in the chain. Paid model IDs cannot be persisted. The paid continuity routes (`deepseek/deepseek-v4-flash-0731` on OpenRouter and on Nous Portal) remain last after the free/BYOK chain and run only when `APEX_PAID_FALLBACK_ENABLED=true` and their credential is set. Free-pool, workspace-token, emergency-request, and legacy paid-spend exhaustion do not veto them; only the switch does, and turning it off removes both routes without removing any free or BYOK provider. The Nous route is not an OpenRouter route: it gets no OpenRouter `provider`, `usage`, headers, or account handling (Nous refuses the `provider` object with HTTP 400); the OpenRouter paid route keeps all of them. A free-route quota or rate-limit 429 on the funded OpenRouter account excludes only that account's free routing (scope `free`), never its paid route (`scripts/verify-paid-fallback-request.ts`). The paid routes receive the full normal conversation history instead of the smaller free-route history trim, and at least `PAID_MIN_OUTPUT_TOKENS` (16,384) output tokens whatever the role budget: DeepSeek's reasoning can otherwise fill a 4,096-token budget and return no content (`finish_reason: length`), failing the task after the reasoning was billed. Billing is per generated token, so the higher ceiling costs nothing when the answer is short; free routes keep the role budget. The paid routes also wait `PAID_REQUEST_TIMEOUT_MS` (120s) for an answer, where free routes keep `APEX_LLM_REQUEST_TIMEOUT_MS` (default 30s) for fast failover: at 30s, DeepSeek answers on 25-35K-token agent contexts timed out about once a minute, each timeout became a 5s capacity pause and a restart from the last checkpoint, and the aborted generation was likely still billed. Provider-side context/rate limits and reliability cooldowns still apply.

The authenticated Settings → OpenRouter Model Control panel may persist `APEX_OPENROUTER_MODEL_POLICY` with:

- 1–500 selected OpenRouter model IDs in global priority order, intentionally large enough for the current hundreds-model catalog;
- optional role-specific first choices, restricted to models already in that roster;
- a routing mode: `manual`, `advisor`, or `adaptive`;
- an optimization objective: `quality`, `balanced`, `budget`, or `speed`;
- a minimum completed-task sample threshold before learned routing may move a model;
- an optional controlled-learning trial rate from 0 to 25%;
- an optional smart complexity-escalation flag.

Saved policies from before the intelligence layer remain backward-compatible only when every selected model is production-eligible (`:free` or exactly `openrouter/free`). Any persisted policy containing a paid model ID is rejected and the reviewed zero-cost chain is used instead.

### Routing modes and operator authority

- **Manual** — use the exact operator-defined order. Evidence is collected but never changes routing.
- **Advisor** — use the exact operator-defined order and show evidence-backed recommendations for operator review.
- **Adaptive** — evidence-qualified models may reorder **only inside the selected roster**. Under-sampled models retain their operator-defined slots. At least two models must be evidence-qualified before learned ranking can change an order.
- An explicit role-specific first choice is a hard operator pin. It stays first in adaptive mode even when another model has a higher learned score.
- Model Intelligence must never introduce an unselected model or silently broaden the operator-approved roster.

Controlled learning trials are opt-in and exist only to close cold-start evidence gaps. They are allowed only in Adaptive mode, only on tasks whose pre-run complexity is `<= 0.5`, never for a role with a hard model pin, and are deterministically sampled by task ID. Trial traffic is hard-capped at 25% and targets the least-sampled selected model below the evidence threshold. Do not turn this into unrestricted random model experimentation.

Smart complexity escalation is also opt-in. When enabled, a task at complexity `>= 0.70` uses the `quality` objective; routine work at `<= 0.35` shifts a neutral `balanced` base objective to `budget`; middle-complexity work keeps the base objective. Explicit routine `quality`, `budget`, or `speed` preferences are preserved, missing complexity never changes the objective, and role pins still win. The API/UI must expose the effective objective when it differs from the saved base objective.

Neither learning trials nor complexity escalation can make an under-sampled model evidence-qualified. Normal sample thresholds still govern automatic learned promotion.

When a valid custom FREE policy exists, APEX sends the ordered roster to OpenRouter using its native `models` fallback parameter through the `openrouter-free-policy` gateway. That gateway uses the same free-account credential roster as automatic routing and never switches to paid keys. APEX records the concrete model returned in OpenRouter's response rather than assuming the first requested model served the generation.

### Static catalog score versus learned evidence

The Settings catalog pulls current model metadata from `https://openrouter.ai/api/v1/models`. Do not hard-code current prices into runtime policy. The dashboard may compute a transparent APEX value-efficiency score from live price, context, and agent-capability metadata, but it must label that score as a **static heuristic**, not an intelligence benchmark.

The separate **Observed Model Intelligence** ranking is based on APEX's own work. Per-generation telemetry is joined by durable task ID to existing `task_outcomes` records. It may use:

- concrete model OpenRouter actually served;
- selected route candidate safely attributable for learning, with explicit attribution basis;
- attribution coverage and count of successful ambiguous calls excluded from scoring;
- observed request latency;
- prompt/completion/cached/reasoning token counts;
- OpenRouter-reported generation cost when available;
- generation success/failure and tool-call behavior;
- completed-task success, quality, satisfaction, and post-run complexity;
- privacy-minimized OpenRouter router-audit identity/status metadata when returned.

Keep concrete served-model identity separate from selected-route learning identity. Credit an exact concrete match exactly. When exactly one selected model/alias/router was requested, that sole selected route may receive route-level evidence even if OpenRouter reports a different concrete model. If multiple selected aliases/routers were sent and the concrete response does not exactly identify one requested candidate, mark the observation **unattributed** and exclude it from scoring. Never guess an alias mapping to make evidence fit the roster.

A completed task outcome is credited once to the dominant **attributable selected route candidate** for that task, not once per LLM iteration. This prevents an iterative task from becoming multiple fake successful samples, avoids crediting every transient fallback with the same task outcome, and keeps ambiguous alias traffic from poisoning rankings.

Telemetry is operational metadata only. It must **not** persist prompt text, completion text, tool-result content, secrets, API keys, OpenRouter free-form summaries, or pipeline payloads. Router metadata must be sanitized to bounded routing identity/status fields before persistence. Task identity flows through concurrent work using `AsyncLocalStorage`; the instrumented BaseAgent must continue injecting that current task-local context into the normal LLM `complete()` path so parallel tasks on the same agent cannot cross-contaminate model attribution.

Adaptive routing must fail safe: if telemetry/outcome data is unavailable or insufficient, preserve the operator-defined order. Learning is not allowed to become a new inference-availability dependency. Telemetry writes are best-effort and must never convert a successful LLM response into a failed task.

The operator-facing intelligence view must surface attribution coverage rather than hiding ambiguous exclusions.

See `docs/MODEL_INTELLIGENCE.md` and `docs/ADR-012_MODEL_INTELLIGENCE.md` for the scoring, attribution, privacy, and adaptation contract.

Credential environment variables:

- `OPENROUTER_FREE_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_API_KEY_2`
- `OPENROUTER_API_KEY_4` — optional independent-account credential
- `OPENROUTER_MGMT_KEY`, `OPENROUTER_MGMT_KEY_2`, `OPENROUTER_MGMT_KEY_3`, `OPENROUTER_MGMT_KEY_4` — optional management keys, one per independent OpenRouter account. They cannot infer. They list that account's inference keys so authenticated `GET /api/health/detail` can prove a live key belongs to a distinct user. They never auto-create or rotate credentials. The OpenRouter half of the paid continuity split uses the funded `OPENROUTER_API_KEY_4` inference credential, never a management key; the Nous half uses `NOUS_API_KEY`. Both keys can be stored in Settings → Paid Continuity.

All configured qualifying OpenRouter accounts are load-balanced by the account identity resolved from `creator_user_id`; a key fingerprint is only the fail-safe identity while that probe is unavailable. `OPENROUTER_API_KEY_3` is deliberately absent from the active roster because it duplicated the `OPENROUTER_FREE_API_KEY` account. Two API keys belonging to the same OpenRouter account do **not** create separate account balances or independent account-wide quota. Treat them as credential redundancy only. Available free-request capacity scales with the number of distinct qualifying accounts actually detected by authenticated `GET /api/health/detail`; credential count alone is not treated as account count. Failed requests consume quota, so retries are bounded. Account 429/402 exclusions apply to all sibling keys and OpenRouter routes, survive process restarts in `component_health`, and rotate to another qualifying account before abandoning the current free model. Exception: a quota or rate-limit 429 raised by a `:free` route is scoped `free` and blocks only free routing on that account, because OpenRouter's free-model limits do not apply to paid models; credit exhaustion (402/out of funds) stays account-wide. Daily free-quota exclusions expire at the next UTC midnight; a 402/credit exhaustion exclusion lasts six hours unless a longer `Retry-After` applies. Nonpositive management-key balance probes exclude that account from paid routing until a later positive probe, without suppressing its independent free allowance. Authenticated `GET /api/health/providers` exposes these exclusions. Only the explicitly confirmed continuity route may spend paid credit after free execution becomes unavailable.

OpenRouter requests retain provider pacing, retry-after handling, transient cooldowns, circuit breakers, context trimming, token reservations, structured tool calls, and serving-provider diagnostics.

### Routing behavior

- If `APEX_OPENROUTER_MODEL_POLICY` is absent or invalid, fall back to the exact six-route free chain (Nex N2.5 Mini Free first, Nemotron Ultra last).
- Persisted production policies may contain only `:free` model IDs or exactly `openrouter/free`. Paid model IDs are rejected.
- `openrouter/free` must preserve APEX tool/function-call requirements (`require_parameters`).
- Flag models without reliable tool calling in the operator UI. Selecting such a model does not disable malformed-tool-call/non-completion guards.
- Preserve structured tool calling. A response that merely narrates a tool call is not successful execution.
- Record the model OpenRouter actually served, not merely the requested first choice, and keep it separate from the route candidate used for learning attribution.
- Ambiguous multi-alias/multi-router attribution must remain unattributed unless direct evidence identifies the selected candidate. Do not infer it from provider/model name similarity.
- Router audit metadata is optional observability, not a new inference dependency; its absence (including cache-hit paths) is not a generation failure.
- Preserve tool-call/result message pairing while trimming context.
- Provider exhaustion is a capacity pause, not an agent failure, when a machine-readable resume time exists.
- Do not silently route to unrelated direct legacy providers because an OpenRouter model is temporarily unavailable.
- A routing-policy change does not bypass approval requirements, tool authorization, token/spend caps, or other safety controls.

`scripts/verify-provider-routing.ts`, `scripts/verify-provider-backpressure.ts`, `scripts/verify-model-routing-policy.ts`, and `scripts/verify-model-intelligence.ts` are deterministic guards and must stay aligned with the production OpenRouter stack.

## CRM contact book

The operator contact book lives in the revenue-ops tables (`lib/db/src/schema-revenue-ops.ts`) plus the additive migration `lib/db/drizzle/20261003_crm.sql`. `contact_timeline` is append-only: a trigger rejects UPDATE and DELETE, and corrections are new rows. `audit_events` may hold many rows per entity. Every outbound send first passes the CRM do-not-contact check (`assertContactSendable`, contact-level, all channels), then the send safeguard (`openOutboundSendJob` + `assertSendAllowed`: operator confirm/code, kill switch, suppressions), then the provider call, and only then writes the CRM timeline row. A send held in Pending Sends writes no timeline row, because nothing was sent; released email, texts, and calls write it when they go out. The send safeguard's suppression check also reads contact-level do-not-contact, so a released send is blocked if the contact opted out on any channel after release. Clearing do-not-contact and merging contacts require the operator dashboard session (`X-Apex-Operator-Session`), not just the admin bearer. Clearing lifts only the contact flag: suppressions from an SMS STOP, a bounce, or a complaint keep that channel blocked.

Inbound email is `POST /api/resend/inbound` (Svix). Reply-To uses `r+<token>@APEX_REPLY_DOMAIN` when that host is set. Inbound Telnyx SMS requires an ed25519 signature from `TELNYX_PUBLIC_KEY`; `TELNYX_SMS_QUERY_KEY_FALLBACK` defaults off. BCC capture (`APEX_CRM_BCC_CAPTURE`) and Gmail read-only sync (`APEX_CRM_GMAIL_SYNC`, scope `gmail.readonly`) both default off. Agents may call `crm_search_contacts`, `crm_get_contact`, and `crm_get_timeline`. They cannot merge contacts or clear do-not-contact, through a tool or the HTTP routes. `scripts/import-contacts-csv.ts` and `scripts/backfill-crm.ts` are dry-run by default and refuse non-local databases. See `docs/CRM.md`.

## Turn Economy

`docs/TURN_ECONOMY.md` describes opt-in durable queue bundles, the read-only
`campaign_snapshot` tool, the explicit no-LLM task path and process-scoped
productivity counters. Bundling defaults off. Opted-in producers accept one
shared task/result/approval/cancellation unit for compatible items; never merge
existing independent tasks. Preserve exact context/scope isolation, fixed
collection deadlines, row locking and per-tool approvals. Known sibling
credentials share the strictest configured daily cap and account RPM window.
Quota admission is still process-local; do not claim distributed reservations.

## Production concurrency and spend controls

Current production defaults in `.env.example` are intended for a real workforce, not the temporary demo throttle:

- `APEX_MAX_CONCURRENT_LLM_CALLS=13` — one slot per current agent; configurable up to 64
- `APEX_LEAD_RESEARCH_CONCURRENCY=3`
- `APEX_MAX_OUTPUT_TOKENS=4096`
- leadership roles may use larger role-specific output ceilings
- `APEX_TOKEN_CAP_TOTAL=0` means no APEX-wide daily ceiling unless deliberately configured
- `APEX_TOKEN_PACING_ENABLED=true`
- `APEX_TOKEN_PACING_BURST_TOKENS=50000`

The scheduled-task dedupe and provider backpressure fixes are permanent reliability controls, not demo throttles. Do not remove them merely to increase throughput.

Token capacity is not the same as a spending allowance. OpenRouter account billing controls remain authoritative. If explicit APEX token caps are added, treat them as hard operational limits and reserve/pace atomically so concurrent workers cannot oversubscribe them.

`GET /api/tokens` and authenticated `GET /api/health/detail` are the operational usage views. Public `GET /health` returns only `{ status, build }` (sha/version and start/uptime). It still returns HTTP 503 when the task queue is provably broken. It does not include account ids, env names, balances, spend, caps, or worker ids.

## Deployment safety

APEX production deployment is **existing-service-only**.

Railway is the ordinary APEX production deployment authority. A reviewed commit reaches service `apex-backend` from `main` only after the configured Wait-for-CI gate; release verification must then prove that the live `/health.build.sha` matches the intended commit.

The old Cloud Run files (`cloudbuild.apex.yaml` and the Cloud Run deployer) are migration-back artifacts only; the former GitHub deploy workflow has been removed. They must remain gated behind `APEX_DEPLOY_ENABLED` and must not be treated as the ordinary release procedure while GCP billing is disabled.

Never:

- create or substitute a different production service because access to the intended Railway service is missing;
- replace all service environment variables during a deployment;
- expose secret values in logs;
- fake `APEX_BUILD_SHA` as a runtime override merely to make health verification pass;
- report a release successful before `/health.build.sha` matches the requested commit;
- revive the removed AWS Lightsail/CodeBuild production path;
- claim a deploy occurred when only a build or commit occurred.

Normal rollback uses Railway's existing service/revision history and must be followed by `/health` verification. The Cloud Run path is an emergency migration-back route only after its documented preconditions (including GCP billing and `APEX_DEPLOY_ENABLED`) are intentionally restored.

## Approval and security rules

- Operator `/api/*` routes remain behind `requireAdminAuth`; external provider webhooks (Vapi, Telnyx, Resend, and optional Cartesia) are mounted before that middleware and verify provider-specific secrets or signatures. Public `GET /health` is unauthenticated and minimal so Railway can healthcheck it. `GET /api/health/detail` is behind `requireAdminAuth`.
- `APEX_ADMIN_PASSWORD` and `APEX_ADMIN_TOKEN` are deployment secrets; there is no source-code fallback.
- `POST /api/auth/login` compares that password with SHA-256 digests and `crypto.timingSafeEqual`, and applies an in-memory per-IP limit, a global limit, and a failure lockout with backoff (`packages/api-server/src/login-guard.ts`). Limits are per process. Optional `APEX_LOGIN_*` / `APEX_TRUST_PROXY_HOPS` overrides must keep safe defaults; `trust proxy` stays a hop count (default 1) so `X-Forwarded-For` cannot choose the client key. Log the IP and timestamp on failure, and a warn-level `login lockout triggered` line — never the password.
- Secrets are referenced by environment-variable name only in logs, reports, commits, issues, PR descriptions, and documentation. Never log or commit secret values.
- Human approval is per tool. Do not create a global bypass.
- `APEX_OPERATOR_AUTO_APPROVE_ALL` fails closed when unset. An explicit true-like value may skip ordinary approval gates, and it never auto-approves `send_email`, `send_email_campaign_batch`, `make_outbound_call`, or `call_initiate`.
- Every outbound email, phone call, SMS, and calendar invite passes `assertSendAllowed` at the moment of send. The operator confirms the job twice in Pending sends. Jobs whose 24-hour campaign or story total is 5 or more also need the dashboard four-digit code. The kill switch still blocks a cleared job. The code is stored only as a scrypt hash. An operator-started rehearsal or test call to the saved rehearsal phone, and the matching practice email, dial and send immediately: both confirmations are recorded and the volume code is waived for that job only. A tool, agent, or background caller cannot take that path. Unattended calls and calls to anyone else still wait in Pending Sends.
- Production deploy/rollback, protected remote writes, outbound calls, externally sent communications, financial actions, schema/destructive database operations, and other irreversible effects remain approval-gated unless governance is explicitly changed.
- `runShell` remains approval-gated. Safe local or feature-branch work may remain automatic where current policy allows it.
- Escalations are notifications, not approvals.
- Normal engineering work lands through feature branches/PRs; emergency direct production fixes must still be validated by deterministic CI and live health.

See `SECURITY.md` for the repository-wide security contract.

## Autonomous work integrity

- A task is not complete because an agent says what it intends to do. The non-completion guard must continue catching announced-but-not-taken tool work.
- Scheduled delegation must remain deduplicated so multiple scheduler passes do not create the same live LLM task repeatedly.
- Provider-capacity pauses must release leases and defer work without consuming ordinary task retry budgets.
- The lead campaign runner applies the same rule to search providers. When every keyed search source a segment tried was unavailable (quota, rate limit, out of credits, 5xx, timeout, rejected key, or an open webSearch circuit breaker) and none answered, the segment goes back to pending with its attempt handed back and segment claiming pauses: 2 minutes, doubling to 60, then one test search. The first answer resumes it. Keyless OSM and DuckDuckGo failures never pause search. `isDeterministicFailure` closes a segment early only when no source can answer at all, never during an outage. See `packages/background-jobs/src/lead-search-capacity.ts`.
- `saveResearchedLead` and `saveResearchedLeadsBatch` save US leads only. The city must name a US state or territory or be a well-known US city. Anything else, a missing city, or a contact phone with a country code other than +1 is refused with `OUT_OF_SCOPE_GEOGRAPHY` and nothing is written (`packages/core/src/lead-geography.ts`). No argument switches the check off. A duplicate comes back with `duplicateDetails`, `lookupOnly: true` answers without writing, and every saved row records its producing task in `pipeline_metadata.taskRef` (`agent_research_batch:<task>` for a batch). Lead records are updatable through `updateLeadStatus` and `updateLeadContactInfo`. There is no delete API.
- Managers must follow delegated work through to a measurable result rather than treating delegation itself as completion.
- Repeated current failures are engineering defects until evidence shows they are transient/recovered.
- Never manufacture metrics, status, deploy evidence, test results, or external side effects.

## Durable work, sandbox executor, and cron governance (ADR-013)

- **Durable artifacts**: the container filesystem is ephemeral. Finished deliverables belong in the store named by `APEX_ARTIFACT_BUCKET` (GCS) or `APEX_ARTIFACT_DIR` (Railway volume / local directory). Tools fail closed when both are unset.
- **Durable workspace**: `init_workspace` / `sync_workspace` / `push_workspace` sync project trees to `projects/<projectId>/workspace/<worktree>/` with a checksum manifest; the sandbox executor pulls before and pushes after every run so instance recycle never loses work.
- **Sandbox executor**: heavy tasks (`context.runtime='job'`) dispatch to Cloud Run Jobs when `APEX_EXECUTOR_JOB` is set. On Railway the default is `APEX_EXECUTOR_MODE=inprocess`, which demotes those tasks to the ordinary worker loop instead of waiting forever for gcloud. Set `APEX_EXECUTOR_MODE=off` to keep the fail-closed no-op.
- **Cron governance**: agent-created crons (`schedule_task`) are marked `dynamic:true`, capped at `APEX_MAX_DYNAMIC_JOBS` (default 25), per-workstream 3, floor 15 min — enforced at insert and hourly by `cron_governor` (pauses only, never creates). `work_generation` (every 10 min) plans deduplicated tasks from open goals, accepted opportunities, and due workstreams; `create_workstream` registers durable deliverable units.
- **Autonomy mode**: `projects.autoapproveTools` (non-empty) + `autonomyLevel` of `full_autonomous` or `autonomous` lets a bounded eligible set skip human approval. The control-plane project `apex` is seeded `full_autonomous` with `create_github_repo`, `push_to_remote`, `create_pull_request`, `create_workstream`, `publish_artifact`. Hard-gated forever against the project allowlist: `deploy_to_environment`, `rollback_deployment`, `make_outbound_call`, `send_email`, `send_email_campaign_batch`, `runShell`, `register_deploy_hook`, `register_application`, `delegate_to_application`, inbound-number tools, and BuildMyBot/CaseBuddy connector sends (`scripts/verify-approval-policy.ts`). `APEX_OPERATOR_AUTO_APPROVE_ALL` is a separate standing switch for non-outbound gated tools only. Unset fails closed (false). Explicit true never auto-approves an outbound sales send. Sales email and calls still need the send safeguard plus `outbound_policies` for project `apex`: `rehearsal_only` matches the operator profile, `capped_live` requires a real lead, the daily cap, the send window, a postal address, and the kill switch off (`scripts/verify-sales-outbound.ts`, `scripts/verify-send-safeguard.ts`). `APEX_SALES_OUTBOUND_GATE=closed` is a test latch, not a production setting. Settings → Project autonomy allowlist is the operator UI. Unscoped tasks fall back to the `apex` project policy.
- **Deploy hooks**: third-party hosting deploys for client deliverables go through registrable webhooks only (`register_deploy_hook` / `deploy_via_hook`); hook URLs are stored as `env:VAR_NAME` secret references, never logged. They do not change APEX's own hosting (ADR-015 — Railway; Cloud Run is rollback-only).

## Checkpoint/resume, approval yield, and shared worker bootstrap (ADR-014)

- **Checkpoint/resume**: `executeTask` checks a soft deadline (`APEX_SOFT_TIMEOUT_RATIO`, default 0.7 of the hard timeout) once per iteration, only between tool-call batches. When crossed it stops starting new work, writes a `TaskCheckpoint` (`packages/core/src/task-checkpoint.ts` — real resumable history plus real completed-steps/findings/decisions, never fabricated) via the guarded `TaskQueue.checkpointAndResume()`, and returns the task to `pending`. The 10-/55-minute hard timeout is an emergency-only backstop, not the normal way work gets sliced — it should rarely fire now. The resumable state lives on `tasks.context.checkpoint`; `task_checkpoints` is an append-only audit/dashboard log, not the resumable state itself.
- **Approval yield**: `requestHumanApproval` never waits in-process anymore — it persists the pending approval and yields immediately via `ApprovalYieldSignal`. `POST /api/approvals/:id/approve|reject` requeues the task immediately (fast path); the durable recovery sweep in `instrumented-base-agent.ts` is the backstop. A gated approval durably waits until a human decides or `APEX_APPROVAL_AUTO_REJECT_HOURS` elapses (default 24h; 0 disables it) — auto-**reject** only, never auto-approve.
- **Heavy-work classifier** (`work-classifier.ts`) is advisory only: it nudges agents toward the existing `run_executor_job` tool but never sets `context.runtime` itself, since that silently reassigns a task to the fixed executor identity/tool set.
- **Shared runtime bootstrap** (`packages/api-server/src/runtime-bootstrap.ts`): both `index.ts` and `worker.ts` call this one routine for settings load, token-ledger hydration, lease recovery, workforce/scheduler creation, default job seeding, `CampaignRunner`, executor dispatch, and the durable worker heartbeat. Adding a new runtime-critical subsystem to only one entrypoint reintroduces the divergence this closed — always add it here.
- **Durable worker heartbeat**: every runtime upserts to `worker_heartbeats` on a 15s interval; authenticated `GET /api/health/detail`'s `workerHeartbeats` field is separate from the process-local `workforce` liveness block. A healthy HTTP listener is never proof that an autonomous worker process is alive. Public `GET /health` does not include worker ids.
- **Task economy** (`execution-budget.ts`): deterministic repetition detection (3× identical tool+args outside polling/decision exemptions) and a budget nudge, each firing at most once per task.
- **Autonomy dashboard**: `GET /api/autonomy` reports worker health, task-queue shape, checkpoint/yield counts, executor jobs, retry backlog, approvals, throughput, goals, and duplicate-side-effect-prevention events.

See `docs/ARCHITECTURE_DECISIONS.md` (ADR-014) for the full decision and consequences, including the explicit note that this has not yet been production-deployed or verified against live traffic.

## Verification sequence

For any real code fix or feature:

1. Start from current `origin/main`.
2. Run `pnpm install --frozen-lockfile` when dependencies are involved or the environment is fresh.
3. Run `pnpm run typecheck:production`.
4. Run deterministic guards relevant to the change; LLM changes require routing/backpressure/model-intelligence guards, deployment changes require the provenance guard.
5. Build the dashboard and verify real output.
6. Require green CI before ordinary merge/release.
7. Merge/push the exact reviewed SHA to `main`; Railway's Wait-for-CI gate must allow service `apex-backend` to deploy it.
8. Confirm Railway reports Success for that commit and verify `https://apex.donmatthews.live/health` reports that SHA. Confirm a healthy queue on authenticated `GET /api/health/detail` (`taskQueue.verdict`).
9. Smoke-test the actual changed feature against production.
10. Record what was verified and what remains unverified.

A successful build or merge is not a successful deployment. Production is released only when Railway reports success and the expected commit is answering the production health endpoint.

## CI contract

`.github/workflows/ci.yml` is the ordinary production gate. Keep it deterministic and secret-free where possible.

Production CI currently includes:

- frozen pnpm install;
- production TypeScript checks;
- provider routing guard;
- paid continuity request guard (drives the real client with fetch stubbed: the Nous paid route sends no OpenRouter `provider`/`usage` fields or headers, OpenRouter routes keep them; once the free pool answers 429, 10 paid requests land 9 on Nous and 1 on OpenRouter, the OpenRouter one on the account whose free quota ran out; an unfunded Nous key falls to OpenRouter with no failed request; Nous alone and unfunded is a capacity pause; both paid routes get the 16,384-token output floor while free routes keep the role budget; a paid answer slower than the default request timeout is received, while free routes keep that timeout; the spend ledger reads a same-day file written before it tracked cached tokens and records the paid route's cache hits);
- provider backpressure guard (includes the LLM capacity-latch release checks);
- budget-pause guard;
- Cloud Run deploy-provenance guard (includes the retired-hosting-instructions check and the Vercel dashboard-only build check);
- malformed-tool-call guard;
- non-completion guard;
- branch/review guard;
- opportunity-engine guard;
- durable-autonomy/task-claim guard;
- approval-state-integrity guard;
- hard-timeout quarantine guard (includes the task-ownership-transition behaviour checks);
- durable-worker-runtime guard;
- login brute-force guard (constant-time password compare, per-IP and global limits, failure lockout, proxy-hop client IP);
- OpenRouter model-routing-policy guard;
- evidence-driven model-intelligence guard;
- retired-hosting-instructions guard;
- artifact-store guard (Phase 1: storage wiring, artifacts table, tools registered);
- workspace-sync guard (Phase 3: checksum round-trip determinism);
- cron-governor guard (Phase 5: frequency floor, dynamic-ceiling constants, schedule_task enum);
- approval-policy guard (Phase 5.5: hard-gated tools never auto-approvable; unset auto-approve fails closed);
- send-safeguard guard (every channel blocked without clearance, dual confirm, 5+ code + 24h aggregation, bot code rejected, lockout, Stop, kill switch, suppression);
- calendar booking guard (free/busy and every booking rule, one winner when bookings race, hold expiry, invites staged in the send safeguard with operator-only confirm, code, and release, kill switch at staging and at send, no invite for a meeting cancelled since, do-not-contact, Cal.com signatures);
- BuildMyBot lead-ingest guard (authenticated HTTP handoff: not-configured, dry-run default, live-push approval gate, chunking, 401/503);
- lead-search capacity-pause guard (the 2026-10-03 incident's shape replayed with Serper, the keyed web source in use since Tavily left the stack on 2026-10-05: an outage pauses instead of closing, attempts handed back, backoff and single test search, honest empties and keyless flakiness still retry or close, a Serper 429 trips the webSearch breaker and the next search skips Serper, a 502 naming an upstream status is classified by that status, Yelp/Google HTTP failures are reported as failures);
- lead geography guard (US-only saves need positive evidence: a state, a territory, or a well-known US city; foreign places, bare ambiguous names, a missing city, and non-+1 phones are refused; every us-geo.ts campaign city passes; a refusal never reads the database);
- lead write-path suite (`lead-write-path.test.ts`: duplicateDetails, typed lookupOnly, OUT_OF_SCOPE_GEOGRAPHY kept apart from duplicates and failures, producing-task provenance, no delete API; its database half runs in the `lead-status-postgres` job);
- executor-dispatch guard (Phase 4: claim-by-id, runtime routing, dispatch wiring);
- checkpoint/resume guard (ADR-014: checkpoint construction, ownership-guarded resume, executor-job dispatch-marker reset);
- soft-deadline yield guard (hard/soft timeout resolution, no silent drift between start() and executeTask());
- heavy-work routing guard (classifier true/false positives, advisory-only wiring);
- task-repetition guard (circular-investigation detection, budget nudge);
- durable-worker-heartbeat guard (schema/migration, authenticated health-detail separation from process-local liveness; public `/health` stays minimal);
- autonomy-dashboard guard (every metric backed by a real query/counter);
- call-outcome-capture guard (DST-correct appointment timezone resolution, upsert never lets end-of-call-report overwrite a disposition the mid-call function already recorded);
- crash-recovery integration guard (create → claim → disappear → resume → exactly-one-side-effect → complete);
- dashboard build;
- mobile layout guard (`mobile-layout` job, separate from `production-checks`): drives the built dashboard in Chromium across every nav view (including Pending Sends and Contacts) at 360/390/430px and fails on horizontal overflow, on a view that renders blank, or on a nav view the harness does not visit.
- CRM postgres guard (`crm-postgres` job): contact book, append-only timeline, inbound matching, and do-not-contact against a throwaway Postgres. It is not part of `production-checks` because that job has no database.
- lead-search postgres guard (`lead-search-postgres` job): the real `CampaignRunner` against a throwaway Postgres with stubbed search tools and a fake clock — an outage hands every segment back, claims nothing while paused, sends one test search, and resumes on the first answer.

Experimental Convex checks must not silently become production authority merely because they pass.

## Context-budget rules

`packages/core/src/context-budget.ts` bounds iterative task history. Tool results can become expensive because history is re-sent on each model iteration.

Do not optimize context by deleting arbitrary messages. Assistant `tool_calls` and matching `tool` messages must remain structurally paired. Preserve the system prompt, original task, and recent turns.

## Documentation maintenance

Documentation is part of the production system. Keep it truthful.

When a change affects hosting, model routing, secrets, auth, database targets, approval policy, CI, release procedure, workforce composition, or major architecture:

1. update the relevant source code;
2. update `AGENTS.md` if the canonical operating rule changed;
3. update `README.md` if contributor/operator expectations changed;
4. add or amend an entry in `docs/ARCHITECTURE_DECISIONS.md` for durable architecture decisions;
5. update `docs/PRODUCTION_OPERATIONS.md` / `docs/deploy-provenance.md` for release/operations changes;
6. update `CHECKLIST.md` / `ROADMAP.md` only with evidence-backed status;
7. clearly mark old statements historical instead of leaving contradictory “current” instructions.

Do not let a completed code migration leave documentation on the old architecture.

## Other source-of-truth documents

- `README.md` — contributor/operator orientation and current production summary.
- `SECURITY.md` — secrets, auth, vulnerability, and high-risk change rules.
- `docs/ARCHITECTURE_DECISIONS.md` — durable decisions and retired architecture.
- `docs/PRODUCTION_OPERATIONS.md` — production runbook.
- `docs/deploy-provenance.md` — source/image/runtime provenance contract.
- `docs/MODEL_INTELLIGENCE.md` — model telemetry, attribution, evidence thresholds, controlled learning, complexity escalation, adaptive-routing, and scoring contract.
- `docs/ADR-012_MODEL_INTELLIGENCE.md` — durable Model Intelligence learning-authority and privacy decision.
- `BUSINESS_PROFILE.md` — dated BuildMyBot business/ICP snapshot; verify current pricing, features, payment state, and deployment before acting.
- `APEX_CHARTER.md` — mission/governance; dated infrastructure/model notes are historical unless promoted into current canonical docs.
- `packages/core/src/buildmybot-connector.ts` — current BuildMyBot connector implementation; verify live BuildMyBot state separately.
- `ROADMAP.md`, `CHECKLIST.md` — living planning/status documents, subordinate to current source and canonical runtime docs.
- `cloudbuild.apex.yaml` — immutable Google Cloud Build image definition.

When documentation conflicts with current runtime evidence, state the conflict, prefer the most direct evidence, and update the stale documentation so the contradiction does not survive the task.

## Base44 sandbox dev environment

`docker-compose.base44.yml` runs the repo warm for the Base44 preview (dev only — production runs on Railway per ADR-015; the old Cloud Run path is rollback-only):

- Two services: `db` (postgres:16-alpine) and `app` (node:22-slim). Only host port 3000 is public.
- Single-origin wiring: the `app` container runs `pnpm run dev` (concurrently `tsx watch` API on :5000 + Vite dashboard on :3000). The Vite dev server proxies `/api` and `/ws` to `localhost:5000` inside the container — do not "fix" the proxy target to a service name; both processes share the container on purpose.
- `pnpm install --frozen-lockfile` runs on every container start; the pnpm store is a named volume so it is fast after the first boot.
- DB bootstrap is the idempotent DDL in `lib/db/src/client.ts` (`migrate()`), which `main()` catches and warns on if the DB is down — the server still boots without Postgres, it just has no data.
- `APEX_ADMIN_TOKEN` is the only secret required at boot: `api-server/src/middleware/auth.ts` calls `requireEnv` at module load and the server crashes without it. Placeholders live in `.env.base44-defaults` (FIRST env_file); real values come from the platform-managed `/run/base44/app.env` (LAST env_file, always wins).
- Vite config sets `server.allowedHosts: true` because the preview hostname changes when the sandbox is recreated.
- Verify the stack: `docker compose -f docker-compose.base44.yml ps` (db healthy, app up), then `curl -sf -H "Host: x.example.com" http://localhost:3000/` for the dashboard and `curl -X POST .../api/auth/login` for the API through the proxy.

## Cursor Cloud Agent

Cloud Agent sessions for this repository use a local PostgreSQL 16 cluster and `pnpm run dev`. That environment is a development desk. Production remains Railway service `apex-backend`.

- Install runs `pnpm install --frozen-lockfile` after PostgreSQL 16 is present (`pg_isready` on `PATH`).
- On boot, Postgres listens on `127.0.0.1:5432`. The local role and database are both `apex`. `DATABASE_URL` defaults to `postgres://apex:apex_dev_password@127.0.0.1:5432/apex`, the same local password as `docker-compose.base44.yml`.
- `pnpm run dev` serves the API on port 5000 and the Vite dashboard on port 3000. The dashboard proxies `/api` and `/ws` to the API.
- `APEX_ADMIN_TOKEN` is required before the API module loads. When `APEX_ADMIN_TOKEN` and `APEX_ADMIN_PASSWORD` are unset, the Cloud Agent start script supplies local-only placeholders so the desk can log in. Override them with Cloud Agent secrets. Do not copy those placeholders into Railway or any shared environment.
- Provider keys are optional here. `GET /health` and the dashboard boot without them; inference stays unconfigured.
